/**
 * /api/cli/index.js
 * ═══════════════════════════════════════════════════════════════════════════════
 * Endpoint unificado do TOTVS Context CLI — Vercel Serverless (Node.js, ESM)
 *
 * Rotas → ?action=<ação>
 * ───────────────────────────────────────────────────────────────────────────────
 *  POST  ?action=auth_login     Autentica com email+senha; emite JWT de sessão
 *  POST  ?action=auth_refresh   Renova access_token com refresh_token
 *  GET   ?action=me             Retorna dados do usuário autenticado
 *  POST  ?action=logout         Revoga refresh_token e limpa sessão
 *  POST  ?action=save_meeting   Persiste análise estruturada em public.meetings
 *  GET   ?action=list_meetings  Lista reuniões do usuário (paginado)
 *  GET   ?action=get_meeting    Retorna uma reunião pelo id
 *  DELETE?action=delete_meeting Remove uma reunião pelo id
 *
 * Variáveis de ambiente necessárias
 * ───────────────────────────────────────────────────────────────────────────────
 *  SUPABASE_URL              URL pública do projeto Supabase
 *  SUPABASE_SERVICE_ROLE_KEY Chave service-role (somente backend)
 *  SUPABASE_ANON_KEY         Chave anon pública
 *  JWT_SECRET                Segredo para assinar o JWT de sessão CLI
 */

import jwt from 'jsonwebtoken'
import { createClient } from '@supabase/supabase-js'

// ─── Config ───────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const ANON_KEY = process.env.SUPABASE_ANON_KEY
const JWT_SECRET = process.env.JWT_SECRET

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30 // 30 dias
const PAGE_SIZE_DEFAULT = 20
const PAGE_SIZE_MAX = 50

// ─── Supabase clients ─────────────────────────────────────────────────────────

function supabaseAdmin() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
}

function supabaseAnon() {
  return createClient(SUPABASE_URL, ANON_KEY)
}

// ─── CORS ─────────────────────────────────────────────────────────────────────

function applyCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-CLI-Version')
  if (req.method === 'OPTIONS') {
    res.status(204).end()
    return true
  }
  return false
}

// ─── JWT de sessão CLI ────────────────────────────────────────────────────────

function issueCliSession(userId, refreshToken) {
  return jwt.sign(
    { sub: userId, rt: refreshToken },
    JWT_SECRET,
    { expiresIn: SESSION_TTL_SECONDS, algorithm: 'HS256' }
  )
}

function verifyCliSession(token) {
  try {
    return jwt.verify(token, JWT_SECRET)
  } catch {
    return null
  }
}

function extractToken(req) {
  const auth = req.headers['authorization'] ?? ''
  if (auth.startsWith('Bearer ')) return auth.slice(7)
  return null
}

function requireAuth(req, res) {
  const token = extractToken(req)
  if (!token) {
    res.status(401).json({ code: 401, error_code: 'unauthenticated', msg: 'Não autenticado. Execute /login primeiro.' })
    return null
  }
  const payload = verifyCliSession(token)
  if (!payload) {
    res.status(401).json({ code: 401, error_code: 'session_expired', msg: 'Sessão expirada. Execute /login novamente.' })
    return null
  }
  return payload
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function err(res, status, errorCode, message) {
  if (!res.headersSent) {
    res.status(status).json({ code: status, error_code: errorCode, msg: message })
  }
}

// ─── Rate limiting (in-memory; swap for Redis em multi-instância) ─────────────

const _loginAttempts = new Map()
const RATE_LIMIT = { MAX: 10, WINDOW_MS: 5 * 60 * 1000, LOCKOUT_MS: 3 * 60 * 1000 }

function checkRateLimit(ip) {
  const now = Date.now()
  const rec = _loginAttempts.get(ip)
  if (!rec) return { allowed: true }
  if (rec.lockedUntil && now < rec.lockedUntil) {
    return { allowed: false, retryAfter: Math.ceil((rec.lockedUntil - now) / 1000) }
  }
  if (now - rec.firstAttempt > RATE_LIMIT.WINDOW_MS) {
    _loginAttempts.delete(ip)
    return { allowed: true }
  }
  if (rec.count >= RATE_LIMIT.MAX) {
    rec.lockedUntil = now + RATE_LIMIT.LOCKOUT_MS
    _loginAttempts.set(ip, rec)
    return { allowed: false, retryAfter: Math.ceil(RATE_LIMIT.LOCKOUT_MS / 1000) }
  }
  return { allowed: true }
}

function recordFailedLogin(ip) {
  const now = Date.now()
  const rec = _loginAttempts.get(ip) || { count: 0, firstAttempt: now }
  rec.count++
  _loginAttempts.set(ip, rec)
}

function clearLoginAttempts(ip) {
  _loginAttempts.delete(ip)
}

function clientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0].trim()
    || req.headers['x-real-ip']
    || req.socket?.remoteAddress
    || 'unknown'
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

/**
 * POST ?action=auth_login
 *
 * Autentica com email + senha via Supabase, busca name e plan na tabela users
 * e emite um JWT de sessão CLI.
 *
 * Body:     { email: string, password: string }
 * Resposta: { session_token: string, email: string, name: string|null, plan: string|null }
 */
async function handleAuthLogin(req, res) {
  if (req.method !== 'POST') return err(res, 405, 'method_not_allowed', 'Método não permitido.')

  const ip = clientIp(req)
  const { allowed, retryAfter } = checkRateLimit(ip)
  if (!allowed) {
    res.setHeader('Retry-After', retryAfter)
    return err(res, 429, 'rate_limited', `Muitas tentativas. Aguarde ${retryAfter}s e tente novamente.`)
  }

  const { email, password } = req.body ?? {}

  if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return err(res, 400, 'validation_failed', 'E-mail inválido.')
  }
  if (!password || typeof password !== 'string' || password.length < 6) {
    return err(res, 400, 'validation_failed', 'Senha inválida.')
  }

  // 1. Autentica via Supabase Auth
  const sb = supabaseAnon()
  const { data, error } = await sb.auth.signInWithPassword({
    email: email.trim().toLowerCase(),
    password,
  })

  if (error || !data?.user) {
    recordFailedLogin(ip)
    return err(res, 401, 'invalid_credentials', 'Credenciais inválidas.')
  }

  clearLoginAttempts(ip)

  // 2. Busca name e plan na tabela users (service role para bypass de RLS)
  const admin = supabaseAdmin()
  const { data: userRow } = await admin
    .from('users')
    .select('name, plan')
    .eq('id', data.user.id)
    .maybeSingle()

  // 3. Emite JWT de sessão CLI
  const sessionToken = issueCliSession(data.user.id, data.session?.refresh_token ?? '')

  return res.status(200).json({
    session_token: sessionToken,
    email: data.user.email,
    name: userRow?.name ?? null,
    plan: userRow?.plan ?? null,
  })
}

/**
 * POST ?action=auth_refresh
 *
 * Renova a sessão CLI usando o refresh_token embutido no JWT atual.
 */
async function handleAuthRefresh(req, res) {
  if (req.method !== 'POST') return err(res, 405, 'method_not_allowed', 'Método não permitido.')

  const payload = requireAuth(req, res)
  if (!payload) return

  const { rt: refreshToken } = payload
  if (!refreshToken) return err(res, 401, 'no_refresh_token', 'Sessão sem refresh token. Execute /login.')

  const sb = supabaseAnon()
  const { data, error } = await sb.auth.refreshSession({ refresh_token: refreshToken })

  if (error || !data?.user) {
    return err(res, 401, 'refresh_failed', 'Sessão expirada. Execute /login novamente.')
  }

  const sessionToken = issueCliSession(data.user.id, data.session?.refresh_token ?? refreshToken)
  return res.status(200).json({ session_token: sessionToken })
}

/**
 * GET ?action=me
 *
 * Retorna id, email, name e plan do usuário autenticado.
 */
async function handleMe(req, res) {
  if (req.method !== 'GET') return err(res, 405, 'method_not_allowed', 'Método não permitido.')

  const payload = requireAuth(req, res)
  if (!payload) return

  const sb = supabaseAdmin()
  const { data, error } = await sb
    .from('users')
    .select('id, email, name, plan')
    .eq('id', payload.sub)
    .maybeSingle()

  if (error) return err(res, 500, 'db_error', 'Erro ao buscar usuário.')
  if (!data) return err(res, 404, 'not_found', 'Usuário não encontrado.')

  return res.status(200).json(data)
}

/**
 * POST ?action=logout
 */
async function handleLogout(req, res) {
  if (req.method !== 'POST') return err(res, 405, 'method_not_allowed', 'Método não permitido.')

  const payload = requireAuth(req, res)
  if (!payload) return

  const { rt: refreshToken } = payload
  if (refreshToken) {
    const sb = supabaseAnon()
    await sb.auth.signOut().catch(() => { })
  }

  return res.status(200).json({ success: true })
}

/**
 * POST ?action=save_meeting
 */
async function handleSaveMeeting(req, res) {
  if (req.method !== 'POST') return err(res, 405, 'method_not_allowed', 'Método não permitido.')

  const payload = requireAuth(req, res)
  if (!payload) return

  const userId = payload.sub
  const body = req.body ?? {}
  const { idempotency_key, title, transcription, goal, size, analysis_data } = body

  if (!idempotency_key || typeof idempotency_key !== 'string') {
    return err(res, 400, 'validation_failed', 'idempotency_key é obrigatório.')
  }
  if (!title || typeof title !== 'string') {
    return err(res, 400, 'validation_failed', 'title é obrigatório.')
  }
  if (!analysis_data || typeof analysis_data !== 'object') {
    return err(res, 400, 'validation_failed', 'analysis_data é obrigatório.')
  }

  const VALID_GOALS = new Set(['success', 'partial', 'fail'])
  const safeGoal = VALID_GOALS.has(goal) ? goal : 'partial'

  const sb = supabaseAdmin()

  // Idempotência
  const { data: existing } = await sb
    .from('meetings')
    .select('id, title, created_at, analysis_data')
    .eq('id', idempotency_key)
    .eq('user_id', userId)
    .maybeSingle()

  if (existing) return res.status(200).json({ ...existing, already_existed: true })

  const { data, error } = await sb
    .from('meetings')
    .insert({
      id: idempotency_key,
      user_id: userId,
      title: String(title).slice(0, 255),
      transcription: transcription ?? null,
      goal: safeGoal,
      size: size ?? null,
      analysis_data,
    })
    .select('id, title, created_at, analysis_data')
    .single()

  if (error) {
    console.error('[cli/save_meeting]', error.message)
    return err(res, 500, 'db_error', 'Falha ao salvar reunião: ' + error.message)
  }

  return res.status(201).json(data)
}

/**
 * GET ?action=list_meetings&page=1&page_size=20
 */
async function handleListMeetings(req, res) {
  if (req.method !== 'GET') return err(res, 405, 'method_not_allowed', 'Método não permitido.')

  const payload = requireAuth(req, res)
  if (!payload) return

  const page = Math.max(1, parseInt(req.query.page ?? '1', 10))
  const pageSize = Math.min(PAGE_SIZE_MAX, Math.max(1, parseInt(req.query.page_size ?? String(PAGE_SIZE_DEFAULT), 10)))
  const from = (page - 1) * pageSize
  const to = from + pageSize - 1
  const exactTitle = typeof req.query.title === 'string' ? req.query.title.trim() : ''
  const titlePrefix = typeof req.query.title_prefix === 'string' ? req.query.title_prefix.trim() : ''

  const sb = supabaseAdmin()
  let query = sb
    .from('meetings')
    .select('id, title, goal, size, created_at, analysis_data', { count: 'exact' })
    .eq('user_id', payload.sub)

  if (exactTitle) query = query.eq('title', exactTitle)
  if (titlePrefix) query = query.ilike('title', `${titlePrefix}%`)

  const { data, error, count } = await query
    .order('created_at', { ascending: false })
    .range(from, to)

  if (error) return err(res, 500, 'db_error', 'Erro ao listar reuniões.')

  return res.status(200).json({ meetings: data, total: count, page, page_size: pageSize })
}

/**
 * GET ?action=get_meeting&id=<uuid>
 */
async function handleGetMeeting(req, res) {
  if (req.method !== 'GET') return err(res, 405, 'method_not_allowed', 'Método não permitido.')

  const payload = requireAuth(req, res)
  if (!payload) return

  const { id } = req.query
  if (!id) return err(res, 400, 'validation_failed', 'Parâmetro id é obrigatório.')

  const sb = supabaseAdmin()
  const { data, error } = await sb
    .from('meetings')
    .select('id, title, goal, size, transcription, analysis_data, created_at')
    .eq('id', id)
    .eq('user_id', payload.sub)
    .maybeSingle()

  if (error) return err(res, 500, 'db_error', 'Erro ao buscar reunião.')
  if (!data) return err(res, 404, 'not_found', 'Reunião não encontrada.')

  return res.status(200).json(data)
}

/**
 * DELETE ?action=delete_meeting&id=<uuid>
 */
async function handleDeleteMeeting(req, res) {
  if (req.method !== 'DELETE') return err(res, 405, 'method_not_allowed', 'Método não permitido.')

  const payload = requireAuth(req, res)
  if (!payload) return

  const { id } = req.query
  if (!id) return err(res, 400, 'validation_failed', 'Parâmetro id é obrigatório.')

  const sb = supabaseAdmin()

  const { data: record } = await sb
    .from('meetings')
    .select('id')
    .eq('id', id)
    .eq('user_id', payload.sub)
    .maybeSingle()

  if (!record) return err(res, 404, 'not_found', 'Reunião não encontrada.')

  const { error } = await sb
    .from('meetings')
    .delete()
    .eq('id', id)
    .eq('user_id', payload.sub)

  if (error) return err(res, 500, 'db_error', 'Erro ao excluir reunião.')

  return res.status(200).json({ success: true })
}

// ─── Handler principal ────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (applyCors(req, res)) return

  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Cache-Control', 'no-store')

  const { action } = req.query

  try {
    switch (action) {
      case 'auth_login': return await handleAuthLogin(req, res)
      case 'auth_refresh': return await handleAuthRefresh(req, res)
      case 'me': return await handleMe(req, res)
      case 'logout': return await handleLogout(req, res)
      case 'save_meeting': return await handleSaveMeeting(req, res)
      case 'list_meetings': return await handleListMeetings(req, res)
      case 'get_meeting': return await handleGetMeeting(req, res)
      case 'delete_meeting': return await handleDeleteMeeting(req, res)
      default:
        return err(res, 400, 'unknown_action', `Ação desconhecida: "${action}".`)
    }
  } catch (e) {
    console.error(`[cli/${action}]`, e.message)
    return err(res, 500, 'internal_error', 'Erro interno do servidor.')
  }
}
