/**
 * /api/cli/index.js
 * ═══════════════════════════════════════════════════════════════════════════════
 * Endpoint unificado do TOTVS Context CLI — Vercel Serverless (Node.js, ESM)
 *
 * Rotas → ?action=<ação>
 * ───────────────────────────────────────────────────────────────────────────────
 *  POST  ?action=auth_init      Inicia fluxo OAuth PKCE — retorna URL + state
 *  POST  ?action=auth_exchange  Troca code+verifier por tokens; emite JWT de sessão
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
 *  SUPABASE_ANON_KEY         Chave anon pública (troca de code OAuth)
 *  JWT_SECRET                Segredo para assinar o JWT de sessão CLI
 */

import jwt from 'jsonwebtoken'
import { createClient } from '@supabase/supabase-js'

// ─── Config ──────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const ANON_KEY = process.env.SUPABASE_ANON_KEY
const JWT_SECRET = process.env.JWT_SECRET

const CLI_REDIRECT_URI = 'http://localhost:9876/callback'
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30 // 30 dias
const STATE_TTL_MS = 10 * 60 * 1000            // 10 minutos
const PAGE_SIZE_DEFAULT = 20
const PAGE_SIZE_MAX = 50

// ─── Supabase clients ─────────────────────────────────────────────────────────

function supabaseAdmin() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
}

function supabaseAnon() {
  return createClient(SUPABASE_URL, ANON_KEY)
}

// ─── CORS (CLI não é browser — aceita qualquer origem, mas bloqueia cookies) ──

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
    res.status(401).json({ error: 'Não autenticado. Execute /login primeiro.' })
    return null
  }
  const payload = verifyCliSession(token)
  if (!payload) {
    res.status(401).json({ error: 'Sessão expirada ou inválida. Execute /login.' })
    return null
  }
  return payload
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function err(res, status, message) {
  if (!res.headersSent) res.status(status).json({ error: message })
}

function requireEnv(key) {
  const v = process.env[key]
  if (!v) throw new Error(`Variável de ambiente ausente: ${key}`)
  return v
}

// ─── In-memory state store (PKCE state validation) ───────────────────────────
// Em produção com múltiplas instâncias, substituir por Redis/Upstash KV.
// Para um CLI single-user o risco é aceitável: cada fluxo tem TTL de 10 min.

const _stateStore = new Map() // state → { codeVerifier, expiresAt }

function storeState(state, codeVerifier) {
  // Limpa entradas expiradas periodicamente
  const now = Date.now()
  for (const [k, v] of _stateStore) {
    if (now > v.expiresAt) _stateStore.delete(k)
  }
  _stateStore.set(state, { codeVerifier, expiresAt: now + STATE_TTL_MS })
}

function consumeState(state) {
  const entry = _stateStore.get(state)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    _stateStore.delete(state)
    return null
  }
  _stateStore.delete(state)
  return entry.codeVerifier
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

/**
 * POST ?action=auth_init
 *
 * Gera URL de autorização OAuth PKCE para abrir no browser.
 *
 * Body: { code_verifier: string, state: string }
 * Resposta: { url: string, state: string }
 *
 * O CLI gera code_verifier e state localmente, envia ao backend para
 * armazenar o state→verifier e receber a URL do Supabase Auth.
 */
async function handleAuthInit(req, res) {
  if (req.method !== 'POST') return err(res, 405, 'Método não permitido.')

  const { code_verifier, state } = req.body ?? {}
  if (!code_verifier || !state) {
    return err(res, 400, 'code_verifier e state são obrigatórios.')
  }
  if (typeof code_verifier !== 'string' || code_verifier.length < 43) {
    return err(res, 400, 'code_verifier inválido (mínimo 43 chars).')
  }
  if (typeof state !== 'string' || state.length < 16) {
    return err(res, 400, 'state inválido (mínimo 16 chars).')
  }

  requireEnv('SUPABASE_URL')
  requireEnv('SUPABASE_ANON_KEY')

  // Deriva code_challenge (S256) — SHA-256(code_verifier) base64url
  const encoder = new TextEncoder()
  const data = encoder.encode(code_verifier)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = new Uint8Array(hashBuffer)
  const base64 = btoa(String.fromCharCode(...hashArray))
  const code_challenge = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

  storeState(state, code_verifier)

  const params = new URLSearchParams({
    client_id: 'your-client-id', // Supabase usa o project ref implicitamente no PKCE flow
    response_type: 'code',
    redirect_uri: CLI_REDIRECT_URI,
    code_challenge,
    code_challenge_method: 'S256',
    state,
  })

  // A URL canônica do Supabase Auth para PKCE
  const url = `${SUPABASE_URL}/auth/v1/authorize?${params.toString()}&provider=email`

  return res.status(200).json({ url, state })
}

/**
 * POST ?action=auth_exchange
 *
 * Troca o authorization code por tokens usando a API do Supabase.
 *
 * Body: { code: string, state: string }
 * Resposta: { session_token: string, user: { id, email } }
 */
async function handleAuthExchange(req, res) {
  if (req.method !== 'POST') return err(res, 405, 'Método não permitido.')

  const { code, state } = req.body ?? {}
  if (!code || !state) return err(res, 400, 'code e state são obrigatórios.')

  const codeVerifier = consumeState(state)
  if (!codeVerifier) {
    return err(res, 400, 'State inválido, expirado ou já utilizado. Inicie um novo login.')
  }

  // Troca o code pelo token via Supabase Auth REST
  const tokenRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=pkce`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': ANON_KEY,
    },
    body: JSON.stringify({
      auth_code: code,
      code_verifier: codeVerifier,
      redirect_uri: CLI_REDIRECT_URI,
    }),
  })

  if (!tokenRes.ok) {
    const body = await tokenRes.text().catch(() => '')
    console.error('[cli/auth_exchange] Supabase error:', tokenRes.status, body)
    return err(res, 401, 'Falha na autenticação. Código inválido ou expirado.')
  }

  const tokens = await tokenRes.json()
  const { access_token, refresh_token, user } = tokens

  if (!access_token || !user?.id) {
    return err(res, 502, 'Resposta inválida do Supabase Auth.')
  }

  const sessionToken = issueCliSession(user.id, refresh_token)

  return res.status(200).json({
    session_token: sessionToken,
    user: { id: user.id, email: user.email },
  })
}

/**
 * POST ?action=auth_refresh
 *
 * Renova a sessão CLI usando o refresh_token embutido no JWT atual.
 *
 * Header: Authorization: Bearer <session_token>
 * Resposta: { session_token: string }
 */
async function handleAuthRefresh(req, res) {
  if (req.method !== 'POST') return err(res, 405, 'Método não permitido.')

  const payload = requireAuth(req, res)
  if (!payload) return

  const { rt: refreshToken } = payload
  if (!refreshToken) return err(res, 401, 'Sessão sem refresh token. Execute /login.')

  const refreshRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': ANON_KEY,
    },
    body: JSON.stringify({ refresh_token: refreshToken }),
  })

  if (!refreshRes.ok) {
    return err(res, 401, 'Sessão expirada. Execute /login novamente.')
  }

  const tokens = await refreshRes.json()
  const { refresh_token: newRefreshToken, user } = tokens

  if (!user?.id) return err(res, 502, 'Resposta inválida do Supabase Auth.')

  const sessionToken = issueCliSession(user.id, newRefreshToken ?? refreshToken)
  return res.status(200).json({ session_token: sessionToken })
}

/**
 * GET ?action=me
 *
 * Retorna email e ID do usuário autenticado.
 */
async function handleMe(req, res) {
  if (req.method !== 'GET') return err(res, 405, 'Método não permitido.')

  const payload = requireAuth(req, res)
  if (!payload) return

  const sb = supabaseAdmin()
  const { data, error } = await sb
    .from('users')
    .select('id, email, name')
    .eq('id', payload.sub)
    .maybeSingle()

  if (error) return err(res, 500, 'Erro ao buscar usuário.')
  if (!data) return err(res, 404, 'Usuário não encontrado.')

  return res.status(200).json(data)
}

/**
 * POST ?action=logout
 *
 * Revoga o refresh_token no Supabase e instrui o CLI a descartar o JWT.
 */
async function handleLogout(req, res) {
  if (req.method !== 'POST') return err(res, 405, 'Método não permitido.')

  const payload = requireAuth(req, res)
  if (!payload) return

  const { rt: refreshToken } = payload

  if (refreshToken) {
    await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': ANON_KEY,
        'Authorization': `Bearer ${refreshToken}`,
      },
    }).catch(() => { }) // revogação best-effort
  }

  return res.status(200).json({ success: true })
}

/**
 * POST ?action=save_meeting
 *
 * Persiste análise estruturada em public.meetings.
 * Nunca escreve na coluna `analysis` (reservada para o webapp).
 *
 * Body: {
 *   idempotency_key: string,   // UUID gerado pelo CLI antes da chamada
 *   title: string,
 *   transcription: object,
 *   goal: 'success'|'partial'|'fail',
 *   size: string,
 *   analysis_data: object      // schema completo conforme spec
 * }
 */
async function handleSaveMeeting(req, res) {
  if (req.method !== 'POST') return err(res, 405, 'Método não permitido.')

  const payload = requireAuth(req, res)
  if (!payload) return

  const userId = payload.sub
  const body = req.body ?? {}

  const { idempotency_key, title, transcription, goal, size, analysis_data } = body

  if (!idempotency_key || typeof idempotency_key !== 'string') {
    return err(res, 400, 'idempotency_key é obrigatório.')
  }
  if (!title || typeof title !== 'string') {
    return err(res, 400, 'title é obrigatório.')
  }
  if (!analysis_data || typeof analysis_data !== 'object') {
    return err(res, 400, 'analysis_data é obrigatório e deve ser um objeto.')
  }

  const VALID_GOALS = new Set(['success', 'partial', 'fail'])
  const safeGoal = VALID_GOALS.has(goal) ? goal : 'partial'

  const sb = supabaseAdmin()

  // Idempotência: checa se já existe registro com este idempotency_key
  const { data: existing } = await sb
    .from('meetings')
    .select('id, title, created_at, analysis_data')
    .eq('id', idempotency_key)
    .eq('user_id', userId)
    .maybeSingle()

  if (existing) {
    // Já salvo — retorna o registro existente sem duplicar
    return res.status(200).json({ ...existing, already_existed: true })
  }

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
      // analysis: NÃO escrito aqui — reservado para o webapp
    })
    .select('id, title, created_at, analysis_data')
    .single()

  if (error) {
    console.error('[cli/save_meeting] Supabase error:', error.message)
    return err(res, 500, 'Falha ao salvar reunião: ' + error.message)
  }

  return res.status(201).json(data)
}

/**
 * GET ?action=list_meetings&page=1&page_size=20
 */
async function handleListMeetings(req, res) {
  if (req.method !== 'GET') return err(res, 405, 'Método não permitido.')

  const payload = requireAuth(req, res)
  if (!payload) return

  const page = Math.max(1, parseInt(req.query.page ?? '1', 10))
  const pageSize = Math.min(PAGE_SIZE_MAX, Math.max(1, parseInt(req.query.page_size ?? String(PAGE_SIZE_DEFAULT), 10)))
  const from = (page - 1) * pageSize
  const to = from + pageSize - 1

  const sb = supabaseAdmin()
  const { data, error, count } = await sb
    .from('meetings')
    .select('id, title, goal, size, created_at, analysis_data', { count: 'exact' })
    .eq('user_id', payload.sub)
    .order('created_at', { ascending: false })
    .range(from, to)

  if (error) return err(res, 500, 'Erro ao listar reuniões.')

  return res.status(200).json({ meetings: data, total: count, page, page_size: pageSize })
}

/**
 * GET ?action=get_meeting&id=<uuid>
 */
async function handleGetMeeting(req, res) {
  if (req.method !== 'GET') return err(res, 405, 'Método não permitido.')

  const payload = requireAuth(req, res)
  if (!payload) return

  const { id } = req.query
  if (!id) return err(res, 400, 'Parâmetro id é obrigatório.')

  const sb = supabaseAdmin()
  const { data, error } = await sb
    .from('meetings')
    .select('id, title, goal, size, transcription, analysis_data, created_at')
    .eq('id', id)
    .eq('user_id', payload.sub)
    .maybeSingle()

  if (error) return err(res, 500, 'Erro ao buscar reunião.')
  if (!data) return err(res, 404, 'Reunião não encontrada.')

  return res.status(200).json(data)
}

/**
 * DELETE ?action=delete_meeting&id=<uuid>
 */
async function handleDeleteMeeting(req, res) {
  if (req.method !== 'DELETE') return err(res, 405, 'Método não permitido.')

  const payload = requireAuth(req, res)
  if (!payload) return

  const { id } = req.query
  if (!id) return err(res, 400, 'Parâmetro id é obrigatório.')

  const sb = supabaseAdmin()

  // Verifica ownership
  const { data: record } = await sb
    .from('meetings')
    .select('id')
    .eq('id', id)
    .eq('user_id', payload.sub)
    .maybeSingle()

  if (!record) return err(res, 404, 'Reunião não encontrada.')

  const { error } = await sb
    .from('meetings')
    .delete()
    .eq('id', id)
    .eq('user_id', payload.sub)

  if (error) return err(res, 500, 'Erro ao excluir reunião.')

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
      case 'auth_init': return await handleAuthInit(req, res)
      case 'auth_exchange': return await handleAuthExchange(req, res)
      case 'auth_refresh': return await handleAuthRefresh(req, res)
      case 'me': return await handleMe(req, res)
      case 'logout': return await handleLogout(req, res)
      case 'save_meeting': return await handleSaveMeeting(req, res)
      case 'list_meetings': return await handleListMeetings(req, res)
      case 'get_meeting': return await handleGetMeeting(req, res)
      case 'delete_meeting': return await handleDeleteMeeting(req, res)
      default:
        return err(res, 400, `Ação desconhecida: "${action}". Verifique a documentação.`)
    }
  } catch (e) {
    console.error(`[cli/${action}] Erro inesperado:`, e.message)
    return err(res, 500, 'Erro interno do servidor.')
  }
}
