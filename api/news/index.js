/**
 * /api/news/index.js
 * ===================
 * Leitura de Notícias — Vercel Serverless Function (Node.js, ESM)
 * Endpoint somente-leitura: não expõe criação, atualização ou remoção.
 *
 * Rotas  →  ?action=<ação>
 * ─────────────────────────────────────────────────────────────────────────────
 *  GET  ?action=list             Lista notícias (paginado, público)
 *  GET  ?action=get&id=<uuid>    Retorna uma notícia por ID (público)
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
 */

import { supabase } from '../_lib/supabase.js'
import { applyCors } from '../_cors.js'

// ─── Constantes ───────────────────────────────────────────────────────────────

const TABLE = 'new'
const PAGE_SIZE_DEFAULT = 20
const PAGE_SIZE_MAX = 50

const SELECT_COLUMNS = 'id, title, subtitle, content, redirection, created_at'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  res.setHeader('Cache-Control', 'no-store')
}

function sendError(res, status, message) {
  if (!res.headersSent) res.status(status).json({ error: message })
}

// ─── Banco de Dados ───────────────────────────────────────────────────────────

async function dbListNews(page, pageSize) {
  const from = (page - 1) * pageSize
  const to = from + pageSize - 1

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

// ─── Handlers ─────────────────────────────────────────────────────────────────

/** GET ?action=list */
async function handleList(req, res) {
  const page = Math.max(1, parseInt(req.query.page ?? '1', 10))
  const pageSize = Math.min(PAGE_SIZE_MAX,
    Math.max(1, parseInt(req.query.page_size ?? String(PAGE_SIZE_DEFAULT), 10)))

  const result = await dbListNews(page, pageSize)
  return res.status(200).json({ ...result, page, page_size: pageSize })
}

/** GET ?action=get&id=<uuid> */
async function handleGet(req, res) {
  const { id } = req.query
  if (!id) return sendError(res, 400, 'Parâmetro "id" é obrigatório.')

  const record = await dbGetNews(id)
  if (!record) return sendError(res, 404, 'Notícia não encontrada.')

  return res.status(200).json(record)
}

// ─── Handler Principal ────────────────────────────────────────────────────────

export default async function handler(req, res) {
  // CORS — reutiliza _cors.js do projeto
  if (applyCors(req, res)) return

  applySecurityHeaders(res)

  const { action } = req.query

  try {
    switch (action) {
      case 'list':
        if (req.method !== 'GET') return sendError(res, 405, 'Método não permitido.')
        return await handleList(req, res)

      case 'get':
        if (req.method !== 'GET') return sendError(res, 405, 'Método não permitido.')
        return await handleGet(req, res)

      default:
        return sendError(res, 400, `Ação desconhecida: "${action}".`)
    }
  } catch (err) {
    console.error(`[news/${action}] Erro inesperado:`, err.message)
    // Nunca expõe stack trace ao cliente
    return sendError(res, 500, 'Erro interno do servidor.')
  }
}