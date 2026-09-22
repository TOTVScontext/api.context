/**
 * /api/news/index.js
 * ===================
 * CRUD de Notícias — Vercel Serverless Function (Node.js, ESM)
 *
 * Rotas  →  ?action=<ação>
 * ─────────────────────────────────────────────────────────────────────────────
 *  GET    ?action=list                 Lista notícias (paginado, público)
 *  GET    ?action=get&id=<uuid>        Retorna uma notícia por ID (público)
 *  POST   ?action=create               Cria uma notícia (autenticado)
 *  PATCH  ?action=update&id=<uuid>     Atualiza uma notícia (autenticado)
 *  DELETE ?action=delete&id=<uuid>     Remove uma notícia (autenticado)
 *
 * Tabela Supabase: `new`
 *  id           uuid / identity (PK)
 *  title        text
 *  subtitle     text
 *  content      text
 *  redirection  text (URL de redirecionamento)
 *  created_at   timestamptz
 *
 * Variáveis de Ambiente (Vercel → Settings → Environment Variables)
 * ─────────────────────────────────────────────────────────────────
 *  SUPABASE_URL              URL do projeto Supabase (obrigatória)
 *  SUPABASE_SERVICE_ROLE_KEY Chave service role do Supabase (obrigatória)
 *  JWT_SECRET                Segredo para verificação do JWT de sessão (obrigatória)
 */

import { supabase }  from '../_lib/supabase.js'
import { getUserId } from '../_lib/auth.js'
import { applyCors } from '../_cors.js'

// ─── Constantes ───────────────────────────────────────────────────────────────

const TABLE              = 'new'
const MAX_TITLE_LEN      = 255
const MAX_SUBTITLE_LEN   = 500
const MAX_CONTENT_LEN    = 50_000
const MAX_REDIRECT_LEN   = 2048
const PAGE_SIZE_DEFAULT  = 20
const PAGE_SIZE_MAX      = 50

const SELECT_COLUMNS = 'id, title, subtitle, content, redirection, created_at'

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Remove null bytes e caracteres de controle (preserva espaço, tab, newline) */
function sanitize(str, maxLen) {
  if (typeof str !== 'string') return ''
  return str
    .replace(/\0/g, '')
    .replace(/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .slice(0, maxLen)
    .trim()
}

function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  res.setHeader('Cache-Control', 'no-store')
}

function sendError(res, status, message) {
  if (!res.headersSent) res.status(status).json({ error: message })
}

/** Valida se uma string é uma URL http(s) bem formada */
function isValidUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** Valida e normaliza o payload de criação/atualização */
function validatePayload(body, { partial = false } = {}) {
  const errors = []
  const clean  = {}

  const hasTitle = Object.prototype.hasOwnProperty.call(body, 'title')
  if (!partial || hasTitle) {
    const title = sanitize(body.title, MAX_TITLE_LEN)
    if (!title) errors.push('O campo "title" é obrigatório.')
    else clean.title = title
  }

  if (!partial || Object.prototype.hasOwnProperty.call(body, 'subtitle')) {
    clean.subtitle = sanitize(body.subtitle ?? '', MAX_SUBTITLE_LEN) || null
  }

  if (!partial || Object.prototype.hasOwnProperty.call(body, 'content')) {
    const content = sanitize(body.content ?? '', MAX_CONTENT_LEN)
    if (!partial && !content) errors.push('O campo "content" é obrigatório.')
    clean.content = content || null
  }

  if (!partial || Object.prototype.hasOwnProperty.call(body, 'redirection')) {
    const redirection = sanitize(body.redirection ?? '', MAX_REDIRECT_LEN)
    if (redirection && !isValidUrl(redirection)) {
      errors.push('O campo "redirection" deve ser uma URL válida (http/https).')
    }
    clean.redirection = redirection || null
  }

  return { errors, clean }
}

// ─── Banco de Dados ───────────────────────────────────────────────────────────

async function dbListNews(page, pageSize) {
  const from = (page - 1) * pageSize
  const to   = from + pageSize - 1

  const { data, error, count } = await supabase
    .from(TABLE)
    .select(SELECT_COLUMNS, { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, to)

  if (error) throw new Error(`Supabase list: ${error.message}`)
  return { news: data, total: count }
}

async function dbGetNews(id) {
  const { data, error } = await supabase
    .from(TABLE)
    .select(SELECT_COLUMNS)
    .eq('id', id)
    .maybeSingle()

  if (error) throw new Error(`Supabase select: ${error.message}`)
  return data
}

async function dbCreateNews(payload) {
  const { data, error } = await supabase
    .from(TABLE)
    .insert(payload)
    .select(SELECT_COLUMNS)
    .single()

  if (error) throw new Error(`Supabase insert: ${error.message}`)
  return data
}

async function dbUpdateNews(id, payload) {
  const { data, error } = await supabase
    .from(TABLE)
    .update(payload)
    .eq('id', id)
    .select(SELECT_COLUMNS)
    .maybeSingle()

  if (error) throw new Error(`Supabase update: ${error.message}`)
  return data
}

async function dbDeleteNews(id) {
  const { error } = await supabase
    .from(TABLE)
    .delete()
    .eq('id', id)

  if (error) throw new Error(`Supabase delete: ${error.message}`)
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

/** GET ?action=list — público */
async function handleList(req, res) {
  const page     = Math.max(1, parseInt(req.query.page      ?? '1',                       10))
  const pageSize = Math.min(PAGE_SIZE_MAX,
                  Math.max(1, parseInt(req.query.page_size  ?? String(PAGE_SIZE_DEFAULT), 10)))

  const result = await dbListNews(page, pageSize)
  return res.status(200).json({ ...result, page, page_size: pageSize })
}

/** GET ?action=get&id=<uuid> — público */
async function handleGet(req, res) {
  const { id } = req.query
  if (!id) return sendError(res, 400, 'Parâmetro "id" é obrigatório.')

  const record = await dbGetNews(id)
  if (!record)  return sendError(res, 404, 'Notícia não encontrada.')

  return res.status(200).json(record)
}

/**
 * POST ?action=create — autenticado
 *
 * Body (application/json):
 * {
 *   "title":       "string"  // obrigatório
 *   "subtitle":    "string"  // opcional
 *   "content":     "string"  // obrigatório
 *   "redirection": "string"  // opcional — URL http(s)
 * }
 */
async function handleCreate(req, res) {
  const body = req.body ?? {}
  const { errors, clean } = validatePayload(body)

  if (errors.length) return sendError(res, 400, errors.join(' '))

  const record = await dbCreateNews(clean)
  return res.status(201).json(record)
}

/** PATCH ?action=update&id=<uuid> — autenticado, campos parciais */
async function handleUpdate(req, res) {
  const { id } = req.query
  if (!id) return sendError(res, 400, 'Parâmetro "id" é obrigatório.')

  const existing = await dbGetNews(id)
  if (!existing) return sendError(res, 404, 'Notícia não encontrada.')

  const body = req.body ?? {}
  const { errors, clean } = validatePayload(body, { partial: true })

  if (errors.length) return sendError(res, 400, errors.join(' '))
  if (Object.keys(clean).length === 0) {
    return sendError(res, 400, 'Nenhum campo válido informado para atualização.')
  }

  const record = await dbUpdateNews(id, clean)
  return res.status(200).json(record)
}

/** DELETE ?action=delete&id=<uuid> — autenticado */
async function handleDelete(req, res) {
  const { id } = req.query
  if (!id) return sendError(res, 400, 'Parâmetro "id" é obrigatório.')

  const existing = await dbGetNews(id)
  if (!existing) return sendError(res, 404, 'Notícia não encontrada.')

  await dbDeleteNews(id)
  return res.status(200).json({ success: true })
}

// ─── Handler Principal ────────────────────────────────────────────────────────

const PUBLIC_ACTIONS = new Set(['list', 'get'])

export default async function handler(req, res) {
  // CORS — reutiliza _cors.js do projeto
  if (applyCors(req, res)) return

  applySecurityHeaders(res)

  const { action } = req.query

  // Leitura é pública; escrita exige sessão autenticada (mesmo padrão de auth/login.js)
  if (!PUBLIC_ACTIONS.has(action)) {
    const userId = getUserId(req)
    if (!userId) return sendError(res, 401, 'Não autenticado.')
  }

  try {
    switch (action) {
      case 'list':
        if (req.method !== 'GET')    return sendError(res, 405, 'Método não permitido.')
        return await handleList(req, res)

      case 'get':
        if (req.method !== 'GET')    return sendError(res, 405, 'Método não permitido.')
        return await handleGet(req, res)

      case 'create':
        if (req.method !== 'POST')   return sendError(res, 405, 'Método não permitido.')
        return await handleCreate(req, res)

      case 'update':
        if (req.method !== 'PATCH')  return sendError(res, 405, 'Método não permitido.')
        return await handleUpdate(req, res)

      case 'delete':
        if (req.method !== 'DELETE') return sendError(res, 405, 'Método não permitido.')
        return await handleDelete(req, res)

      default:
        return sendError(res, 400, `Ação desconhecida: "${action}".`)
    }
  } catch (err) {
    console.error(`[news/${action}] Erro inesperado:`, err.message)
    // Nunca expõe stack trace ao cliente
    return sendError(res, 500, 'Erro interno do servidor.')
  }
}