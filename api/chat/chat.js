/**
 * /api/chat/chat.js
 * =================
 * AI Chat — Vercel Serverless Function (Node.js runtime, ESM)
 *
 * Rotas  →  ?action=<ação>
 * ─────────────────────────────────────────────────────────────
 *  POST    ?action=send           Envia mensagem; resposta em SSE (streaming)
 *  GET     ?action=list           Lista chats do usuário (paginado)
 *  GET     ?action=get&id=<uuid>  Retorna chat completo por ID
 *  PATCH   ?action=title          Atualiza título de um chat
 *  DELETE  ?action=delete&id=<uuid> Apaga um chat
 *
 * Variáveis de Ambiente (Vercel → Settings → Environment Variables)
 * ─────────────────────────────────────────────────────────────────
 *  SYSTEM_PROMPT_OUTPUT      (opcional) Instrução de formato/saída no fim
 */

import { readFile }  from 'fs/promises'
import formidable    from 'formidable'
import { supabase }  from '../_lib/supabase.js'
import { getUserId } from '../_lib/auth.js'
import { applyCors } from '../_cors.js'

// ─── Constantes ───────────────────────────────────────────────────────────────

const OPENROUTER_URL   = 'https://openrouter.ai/api/v1/chat/completions'
const MAX_HISTORY_MSGS = 50           // msgs mantidas no contexto (user+assistant)
const MAX_MSG_LENGTH   = 32_000       // chars por mensagem
const MAX_TITLE_LEN    = 255
const MAX_FILE_BYTES   = 512 * 1024   // 512 KB por arquivo
const MAX_FILES        = 5
const PAGE_SIZE_DEFAULT = 20
const PAGE_SIZE_MAX    = 50

// Rate limit em memória por userId
const _rlMap       = new Map()
const RL_WINDOW_MS = 60_000
const RL_MAX_REQS  = 30

// Extensões aceitas — texto, código, dados (sem imagem/vídeo/binário)
const ALLOWED_EXTS = new Set([
  'txt','md','markdown','csv','tsv','json','jsonl','xml','yaml','yml',
  'toml','ini','conf','env','log','sql',
  'js','ts','jsx','tsx','mjs','cjs',
  'py','rb','go','rs','java','c','cpp','cc','h','hpp',
  'cs','php','swift','kt','scala','sh','bash','zsh','fish',
  'html','htm','css','scss','sass','less',
  'graphql','gql','proto','tf','hcl',
])

// ─── Helpers ──────────────────────────────────────────────────────────────────

function requireEnv(key) {
  const v = process.env[key]
  if (!v) throw new Error(`Env var ausente: ${key}`)
  return v
}

function optEnv(key, fallback = '') {
  return process.env[key] ?? fallback
}

/** Remove null bytes e chars de controle (preserva espaço, tab, newline) */
function sanitize(str, maxLen = MAX_MSG_LENGTH) {
  if (typeof str !== 'string') return ''
  return str
    .replace(/\0/g, '')
    .replace(/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .slice(0, maxLen)
    .trim()
}

function getExt(filename) {
  return (filename?.split('.').pop() ?? '').toLowerCase()
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

// ─── Rate Limiting ────────────────────────────────────────────────────────────

function checkRateLimit(userId) {
  const now   = Date.now()
  let   entry = _rlMap.get(userId)

  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RL_WINDOW_MS }
  }

  entry.count++
  _rlMap.set(userId, entry)

  if (entry.count > RL_MAX_REQS) {
    return { limited: true, retryAfter: Math.ceil((entry.resetAt - now) / 1000) }
  }
  return { limited: false }
}

// ─── Montagem de Mensagens para o modelo ─────────────────────────────────────

function buildMessages(history, userContent) {
  const systemInput  = optEnv('SYSTEM_PROMPT_INPUT')
  const systemOutput = optEnv('SYSTEM_PROMPT_OUTPUT')
  const messages     = []

  if (systemInput) {
    messages.push({ role: 'system', content: systemInput })
  }

  // Limita o histórico para não explodir a janela de contexto
  messages.push(...history.slice(-MAX_HISTORY_MSGS))

  messages.push({ role: 'user', content: userContent })

  // Instrução de formato/saída no final do contexto
  if (systemOutput) {
    messages.push({ role: 'system', content: systemOutput })
  }

  return messages
}

// ─── Streaming OpenRouter → SSE ───────────────────────────────────────────────

async function streamToClient(messages, res) {
  const model     = optEnv('OPENROUTER_MODEL', 'nvidia/nemotron-3-nano-30b-a3b:free')
  const maxTokens = parseInt(optEnv('OPENROUTER_MAX_TOKENS', '4096'), 10)

  const upstream = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${requireEnv('OPENROUTER_API_KEY')}`,
      'Content-Type':  'application/json',
      //'HTTP-Referer':  'https://totvs-context.vercel.app',
      'X-Title':       'TOTVScontext',
    },
    body: JSON.stringify({
      model,
      messages,
      stream:      true,
      max_tokens:  maxTokens,
      temperature: 0.7,
    }),
  })

  if (!upstream.ok) {
    const text = await upstream.text()
    throw new Error(`OpenRouter ${upstream.status}: ${text}`)
  }

  // Abre o stream SSE para o cliente
  res.setHeader('Content-Type',      'text/event-stream')
  res.setHeader('Cache-Control',     'no-cache, no-transform')
  res.setHeader('X-Accel-Buffering', 'no')
  res.setHeader('Connection',        'keep-alive')
  res.status(200)

  const reader      = upstream.body.getReader()
  const decoder     = new TextDecoder()
  let   fullContent = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      const chunk = decoder.decode(value, { stream: true })

      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data: ')) continue

        const raw = line.slice(6).trim()

        if (raw === '[DONE]') {
          res.write('data: [DONE]\n\n')
          continue
        }

        try {
          const parsed = JSON.parse(raw)
          const delta  = parsed.choices?.[0]?.delta?.content ?? ''
          if (delta) fullContent += delta
          // Repassa o chunk SSE original sem modificação
          res.write(`data: ${raw}\n\n`)
        } catch {
          // Linha malformada — ignora
        }
      }
    }
  } finally {
    reader.cancel()
  }

  return fullContent
}

// ─── Banco de Dados ───────────────────────────────────────────────────────────

async function dbGetChat(userId, chatId) {
  const { data, error } = await supabase
    .from('chat')
    .select('id, title, chat, created_at')
    .eq('id', chatId)
    .eq('user_id', userId)  // ← garante ownership — crítico para segurança
    .maybeSingle()

  if (error) throw new Error(error.message)
  return data  // null se não encontrado ou não autorizado
}

async function dbSaveChat(userId, chatId, title, messages) {
  const { error } = await supabase
    .from('chat')
    .upsert(
      { id: chatId, user_id: userId, title: sanitize(title, MAX_TITLE_LEN), chat: messages },
      { onConflict: 'id' }
    )

  if (error) throw new Error(error.message)
}

async function dbListChats(userId, page, pageSize) {
  const from = (page - 1) * pageSize
  const to   = from + pageSize - 1

  const { data, error, count } = await supabase
    .from('chat')
    .select('id, title, created_at', { count: 'exact' })
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .range(from, to)

  if (error) throw new Error(error.message)
  return { chats: data, total: count }
}

async function dbUpdateTitle(userId, chatId, title) {
  const { error } = await supabase
    .from('chat')
    .update({ title: sanitize(title, MAX_TITLE_LEN) })
    .eq('id', chatId)
    .eq('user_id', userId)  // ← ownership check

  if (error) throw new Error(error.message)
}

async function dbDeleteChat(userId, chatId) {
  const { error } = await supabase
    .from('chat')
    .delete()
    .eq('id', chatId)
    .eq('user_id', userId)  // ← ownership check

  if (error) throw new Error(error.message)
}

// ─── Handlers ────────────────────────────────────────────────────────────────

/** POST ?action=send */
async function handleSend(req, res, userId) {
  const rl = checkRateLimit(userId)
  if (rl.limited) {
    res.setHeader('Retry-After', String(rl.retryAfter))
    return sendError(res, 429, 'Muitas requisições. Aguarde alguns segundos.')
  }

  const contentType    = req.headers['content-type'] ?? ''
  const processedFiles = []
  let rawMessage = ''
  let chatId     = crypto.randomUUID()
  let history    = []

  // ── Parse do body ──────────────────────────────────────────────────────────
  if (contentType.includes('multipart/form-data')) {
    const form = formidable({
      maxFileSize: MAX_FILE_BYTES,
      maxFiles:    MAX_FILES,
      // Rejeita imagens e vídeos ainda no parser
      filter: ({ mimetype }) =>
        !mimetype?.startsWith('image/') && !mimetype?.startsWith('video/'),
    })

    const [fields, files] = await form.parse(req)

    rawMessage = sanitize(fields.message?.[0] ?? '')
    chatId     = sanitize(fields.chat_id?.[0] ?? chatId, 36) || chatId

    const historyRaw = fields.history?.[0]
    if (historyRaw) {
      try { history = JSON.parse(historyRaw) } catch { history = [] }
    }

    const uploadedFiles = Object.values(files).flat()
    for (const file of uploadedFiles) {
      const ext = getExt(file.originalFilename ?? '')

      if (!ALLOWED_EXTS.has(ext)) {
        return sendError(res, 400, `Arquivo "${file.originalFilename}" não é permitido.`)
      }

      const buffer  = await readFile(file.filepath)
      const content = new TextDecoder('utf-8', { fatal: false }).decode(buffer)

      processedFiles.push({
        name:    sanitize(file.originalFilename ?? 'arquivo', 256),
        content: sanitize(content, 100_000),
      })
    }
  } else {
    // JSON padrão
    const body = req.body ?? {}
    rawMessage = sanitize(body.message ?? '')
    chatId     = sanitize(body.chat_id  ?? chatId, 36) || chatId
    history    = Array.isArray(body.history) ? body.history : []
  }

  if (!rawMessage) {
    return sendError(res, 400, 'O campo "message" é obrigatório.')
  }

  // ── Carrega histórico do DB (se chat_id informado) ────────────────────────
  const existingChat = await dbGetChat(userId, chatId)
  if (existingChat) {
    history = Array.isArray(existingChat.chat) ? existingChat.chat : []
  }

  // Sanitiza histórico recebido
  history = history
    .filter(m => m && ['user', 'assistant', 'system'].includes(m.role))
    .map(m => ({ role: m.role, content: sanitize(String(m.content ?? ''), MAX_MSG_LENGTH) }))

  // ── Monta conteúdo do usuário com attachments inline ─────────────────────
  const attachmentBlock = processedFiles
    .map(f => `<attachment filename="${f.name}">\n${f.content}\n</attachment>`)
    .join('\n\n')

  const userContent = attachmentBlock
    ? `${rawMessage}\n\n${attachmentBlock}`
    : rawMessage

  const messages = buildMessages(history, userContent)

  // ── Stream para o cliente ─────────────────────────────────────────────────
  res.setHeader('X-Chat-ID', chatId)

  let assistantContent = ''
  try {
    assistantContent = await streamToClient(messages, res)
  } catch (err) {
    console.error('[chat/send] OpenRouter error:', err.message)
    if (!res.headersSent) return sendError(res, 502, 'Erro no serviço de IA.')
    res.write(`data: ${JSON.stringify({ error: 'Stream interrompido.' })}\n\n`)
    return res.end()
  }

  // ── Persiste no Supabase ──────────────────────────────────────────────────
  const updatedHistory = [
    ...history,
    { role: 'user',      content: rawMessage },        // armazena mensagem limpa (sem attachment raw)
    { role: 'assistant', content: assistantContent },
  ]

  const autoTitle =
    updatedHistory.find(m => m.role === 'user')?.content?.slice(0, 60) ?? 'Novo chat'

  try {
    await dbSaveChat(userId, chatId, existingChat?.title ?? autoTitle, updatedHistory)
  } catch (err) {
    // Não falha a requisição — usuário já recebeu a resposta
    console.error('[chat/send] DB save error:', err.message)
  }

  res.end()
}

/** GET ?action=list */
async function handleList(req, res, userId) {
  const page     = Math.max(1, parseInt(req.query.page      ?? '1',                       10))
  const pageSize = Math.min(PAGE_SIZE_MAX,
                  Math.max(1, parseInt(req.query.page_size  ?? String(PAGE_SIZE_DEFAULT), 10)))

  const result = await dbListChats(userId, page, pageSize)
  return res.status(200).json({ ...result, page, page_size: pageSize })
}

/** GET ?action=get&id=<uuid> */
async function handleGet(req, res, userId) {
  const { id } = req.query
  if (!id) return sendError(res, 400, 'Parâmetro "id" é obrigatório.')

  const chat = await dbGetChat(userId, id)
  if (!chat)  return sendError(res, 404, 'Chat não encontrado.')

  return res.status(200).json(chat)
}

/** PATCH ?action=title  —  body: { id, title } */
async function handleUpdateTitle(req, res, userId) {
  const { id, title } = req.body ?? {}
  if (!id)    return sendError(res, 400, '"id" é obrigatório.')
  if (!title) return sendError(res, 400, '"title" é obrigatório.')

  // Verifica ownership antes de atualizar
  const chat = await dbGetChat(userId, id)
  if (!chat) return sendError(res, 404, 'Chat não encontrado.')

  await dbUpdateTitle(userId, id, title)
  return res.status(200).json({ success: true })
}

/** DELETE ?action=delete&id=<uuid> */
async function handleDelete(req, res, userId) {
  const { id } = req.query
  if (!id) return sendError(res, 400, 'Parâmetro "id" é obrigatório.')

  // Verifica ownership antes de deletar
  const chat = await dbGetChat(userId, id)
  if (!chat) return sendError(res, 404, 'Chat não encontrado.')

  await dbDeleteChat(userId, id)
  return res.status(200).json({ success: true })
}

// ─── Handler Principal ────────────────────────────────────────────────────────

export default async function handler(req, res) {
  // CORS — reutiliza _cors.js do projeto
  if (applyCors(req, res)) return

  applySecurityHeaders(res)

  // Autenticação via cookie de sessão JWT — mesmo padrão de auth/login.js
  const userId = getUserId(req)
  if (!userId) return sendError(res, 401, 'Não autenticado.')

  const { action } = req.query

  try {
    switch (action) {
      case 'send':
        if (req.method !== 'POST')   return sendError(res, 405, 'Método não permitido.')
        return await handleSend(req, res, userId)

      case 'list':
        if (req.method !== 'GET')    return sendError(res, 405, 'Método não permitido.')
        return await handleList(req, res, userId)

      case 'get':
        if (req.method !== 'GET')    return sendError(res, 405, 'Método não permitido.')
        return await handleGet(req, res, userId)

      case 'title':
        if (req.method !== 'PATCH')  return sendError(res, 405, 'Método não permitido.')
        return await handleUpdateTitle(req, res, userId)

      case 'delete':
        if (req.method !== 'DELETE') return sendError(res, 405, 'Método não permitido.')
        return await handleDelete(req, res, userId)

      default:
        return sendError(res, 400, `Ação desconhecida: "${action}".`)
    }
  } catch (err) {
    console.error(`[chat/${action}] Erro:`, err.message)
    // Nunca expõe stack trace ao cliente
    return sendError(res, 500, 'Erro interno do servidor.')
  }
}