/**
 * /api/meetings/analyze.js
 * ========================
 * Análise de Transcrição de Reunião — Vercel Serverless Function (Node.js, ESM)
 *
 * Rotas  →  ?action=<ação>
 * ─────────────────────────────────────────────────────────────────────────────
 *  POST   ?action=analyze          Processa transcrição e gera análise completa
 *  GET    ?action=get&id=<uuid>    Retorna uma análise salva por ID
 *  GET    ?action=list             Lista análises do usuário (paginado)
 *  DELETE ?action=delete&id=<uuid> Remove uma análise
 *
 * Variáveis de Ambiente (Vercel → Settings → Environment Variables)
 * ─────────────────────────────────────────────────────────────────
 *  OPENROUTER_API_KEY        Chave de API do OpenRouter (obrigatória)
 *  OPENROUTER_MODEL          Modelo a usar (padrão: google/gemini-2.0-flash-001)
 *  OPENROUTER_MAX_TOKENS     Tokens máximos (padrão: 8192)
 *  SUPABASE_URL              URL do projeto Supabase (obrigatória)
 *  SUPABASE_SERVICE_ROLE_KEY Chave service role do Supabase (obrigatória)
 *  JWT_SECRET                Segredo para verificação do JWT de sessão (obrigatória)
 */

import { supabase }  from '../_lib/supabase.js'
import { getUserId } from '../_lib/auth.js'
import { applyCors } from '../_cors.js'

// ─── Constantes ───────────────────────────────────────────────────────────────

const OPENROUTER_URL     = 'https://openrouter.ai/api/v1/chat/completions'
const MAX_TRANSCRIPT_LEN = 120_000   // ~30k tokens de contexto de entrada
const MAX_TITLE_LEN      = 255
const PAGE_SIZE_DEFAULT  = 20
const PAGE_SIZE_MAX      = 50

// Rate limit em memória por userId (evita sobrecarga e custo excessivo de API)
const _rlMap       = new Map()
const RL_WINDOW_MS = 60_000   // janela de 1 minuto
const RL_MAX_REQS  = 10       // análises são pesadas — limite conservador

// ─── JSON padrão de métricas (scores 0-100) ───────────────────────────────────

const DEFAULT_ANALYSIS_DATA = {
  meeting_analysis: {
    effectiveness: 0, productivity: 0, goal_achievement: 0, decision_quality: 0,
  },
  engagement: {
    overall: 0, participation: 0, interaction: 0, attention: 0,
  },
  communication: {
    clarity: 0, objectivity: 0, persuasion: 0, active_listening: 0, objection_handling: 0,
  },
  sentiment: {
    client: 0, team: 0, positivity: 0, negativity: 0,
  },
  customer: {
    satisfaction: 0, trust: 0, engagement_level: 0, pain_understanding: 0, solution_fit: 0,
  },
  business: {
    deal_progress: 0, conversion_likelihood: 0, perceived_value: 0, expected_value: 0, urgency: 0,
  },
  execution: {
    time_management: 0, agenda_adherence: 0, next_steps_clarity: 0, follow_up_quality: 0,
  },
  risk: {
    churn: 0, deal_loss: 0, objection: 0, disengagement: 0,
  },
  intelligence: {
    alignment: 0, buying_signal: 0, decision_momentum: 0, stakeholder_influence: 0,
  },
  summary_scores: {
    overall_score: 0, client_health: 0, deal_health: 0,
  },
}

// ─── Prompts do Sistema ───────────────────────────────────────────────────────

/**
 * Instrução para geração do relatório narrativo corporativo (coluna `analysis`).
 * Formatação robusta para posterior conversão em PDF.
 */
const SYSTEM_PROMPT_ANALYSIS = `\
Você é um consultor sênior especializado em análise de reuniões comerciais e diagnóstico de vendas B2B.
Sua tarefa é produzir um RELATÓRIO DE ANÁLISE DE REUNIÃO completo, profissional e fundamentado.

REGRAS DE FORMATAÇÃO (obrigatórias — o documento será convertido em PDF):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. Use Markdown estrito. Nunca use HTML.
2. Estrutura obrigatória de seções (use os títulos exatamente como listados abaixo).
3. Cada seção deve ter no mínimo 2 parágrafos densos com análise fundamentada — sem frases vagas.
4. Cite trechos relevantes da transcrição entre aspas para embasar conclusões.
5. Use listas com marcadores (•) apenas dentro das seções que pedem pontos-chave.
6. Nunca use emojis. Mantenha tom executivo e objetivo.
7. Data e hora de geração devem aparecer no cabeçalho.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ESTRUTURA OBRIGATÓRIA DO RELATÓRIO:
───────────────────────────────────
# RELATÓRIO DE ANÁLISE DE REUNIÃO

**Data de Geração:** {{DATA}}
**Classificação:** Confidencial — Uso Interno

---

## 1. SUMÁRIO EXECUTIVO
[Visão geral em 3–4 parágrafos: contexto da reunião, principais achados e recomendação prioritária.]

## 2. ANÁLISE DE ENGAJAMENTO E PARTICIPAÇÃO
[Avalie a qualidade do engajamento dos participantes, nível de atenção, interação e contribuição efetiva.]

## 3. ANÁLISE DE COMUNICAÇÃO
[Clareza das mensagens, objetividade, escuta ativa, manejo de objeções e poder de persuasão demonstrados.]

## 4. ANÁLISE DE SENTIMENTO E CLIMA DA REUNIÃO
[Sentimento geral do cliente e da equipe interna. Identifique momentos de tensão, confiança ou resistência.]

## 5. SAÚDE DO CLIENTE E SATISFAÇÃO
[Avalie sinais de satisfação, confiança, dor compreendida e aderência da solução às necessidades do cliente.]

## 6. PROGRESSO COMERCIAL E ANÁLISE DE NEGÓCIO
[Avanço no ciclo de vendas, probabilidade de conversão, valor percebido pelo cliente e senso de urgência.]

## 7. EXECUÇÃO DA REUNIÃO
[Gestão do tempo, aderência à agenda, clareza dos próximos passos e qualidade do follow-up definido.]

## 8. RISCOS IDENTIFICADOS
[Liste e avalie riscos de churn, perda de negócio, objeções não resolvidas e sinais de desengajamento.]

### Pontos-chave de risco:
• [Risco 1 — descrição e impacto estimado]
• [Risco 2 — descrição e impacto estimado]
• [Risco 3 — descrição e impacto estimado]

## 9. INTELIGÊNCIA COMERCIAL
[Sinais de compra identificados, alinhamento de soluções, momentum de decisão e influência dos stakeholders.]

## 10. RECOMENDAÇÕES E PRÓXIMOS PASSOS
[Ações concretas e priorizadas para a equipe. Seja específico sobre responsáveis, prazos e objetivos.]

### Ações prioritárias:
• [Ação 1 — responsável | prazo | objetivo]
• [Ação 2 — responsável | prazo | objetivo]
• [Ação 3 — responsável | prazo | objetivo]

---
*Relatório gerado automaticamente com base na transcrição fornecida. Validação humana recomendada.*
`

/**
 * Instrução para geração do JSON de métricas (coluna `analysis_data`).
 * Resposta DEVE ser JSON puro — sem Markdown, sem explicação.
 */
const SYSTEM_PROMPT_SCORES = `\
Você é um sistema de pontuação de reuniões. Analise a transcrição fornecida e retorne EXCLUSIVAMENTE um JSON válido.

REGRAS ABSOLUTAS:
• Retorne APENAS o objeto JSON — sem texto adicional, sem blocos de código, sem explicação.
• Todos os valores são inteiros entre 0 e 100, onde:
  0–20  = Muito baixo / crítico
  21–40 = Baixo / abaixo do esperado
  41–60 = Médio / aceitável
  61–80 = Bom / acima da média
  81–100 = Excelente / referência
• Baseie CADA pontuação em evidências concretas da transcrição.
• Se a transcrição não contiver dados suficientes para uma métrica, use 0.

SCHEMA OBRIGATÓRIO (preencha todos os campos):
{
  "meeting_analysis": {
    "effectiveness": <int>,
    "productivity": <int>,
    "goal_achievement": <int>,
    "decision_quality": <int>
  },
  "engagement": {
    "overall": <int>,
    "participation": <int>,
    "interaction": <int>,
    "attention": <int>
  },
  "communication": {
    "clarity": <int>,
    "objectivity": <int>,
    "persuasion": <int>,
    "active_listening": <int>,
    "objection_handling": <int>
  },
  "sentiment": {
    "client": <int>,
    "team": <int>,
    "positivity": <int>,
    "negativity": <int>
  },
  "customer": {
    "satisfaction": <int>,
    "trust": <int>,
    "engagement_level": <int>,
    "pain_understanding": <int>,
    "solution_fit": <int>
  },
  "business": {
    "deal_progress": <int>,
    "conversion_likelihood": <int>,
    "perceived_value": <int>,
    "expected_value": <int>,
    "urgency": <int>
  },
  "execution": {
    "time_management": <int>,
    "agenda_adherence": <int>,
    "next_steps_clarity": <int>,
    "follow_up_quality": <int>
  },
  "risk": {
    "churn": <int>,
    "deal_loss": <int>,
    "objection": <int>,
    "disengagement": <int>
  },
  "intelligence": {
    "alignment": <int>,
    "buying_signal": <int>,
    "decision_momentum": <int>,
    "stakeholder_influence": <int>
  },
  "summary_scores": {
    "overall_score": <int>,
    "client_health": <int>,
    "deal_health": <int>
  }
}
`

// ─── Helpers ──────────────────────────────────────────────────────────────────

function requireEnv(key) {
  const v = process.env[key]
  if (!v) throw new Error(`Variável de ambiente ausente: ${key}`)
  return v
}

function optEnv(key, fallback = '') {
  return process.env[key] ?? fallback
}

/** Remove null bytes e caracteres de controle (preserva espaço, tab, newline) */
function sanitize(str, maxLen = MAX_TRANSCRIPT_LEN) {
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

/** Formata a data atual no padrão brasileiro para o relatório */
function formatDateBR() {
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone: 'America/Sao_Paulo',
  }).format(new Date())
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

// ─── Chamada ao OpenRouter (modo não-streaming) ───────────────────────────────

/**
 * Envia uma mensagem ao OpenRouter e aguarda a resposta completa.
 * Lança erro em caso de falha na API.
 */
async function callOpenRouter(systemPrompt, userMessage, maxTokens) {
  const model = optEnv('OPENROUTER_MODEL', 'google/gemini-2.0-flash-001')

  const response = await fetch(OPENROUTER_URL, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${requireEnv('OPENROUTER_API_KEY')}`,
      'Content-Type':  'application/json',
      'X-Title':       'MeetingAnalyzer',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userMessage  },
      ],
      stream:      false,
      max_tokens:  maxTokens,
      temperature: 0.3,   // análises requerem consistência — temperatura baixa
    }),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '(sem corpo)')
    throw new Error(`OpenRouter ${response.status}: ${body}`)
  }

  const data    = await response.json()
  const content = data?.choices?.[0]?.message?.content

  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('OpenRouter retornou uma resposta vazia ou inválida.')
  }

  return content.trim()
}

// ─── Parsing e Validação do JSON de Scores ────────────────────────────────────

/**
 * Extrai e valida o JSON de scores retornado pelo modelo.
 * Garante que todos os campos existam e sejam inteiros 0-100.
 */
function parseAndValidateScores(rawText) {
  // Remove possíveis blocos de código Markdown (```json ... ```)
  const cleaned = rawText
    .replace(/^```(?:json)?\s*/im, '')
    .replace(/\s*```$/im, '')
    .trim()

  let parsed
  try {
    parsed = JSON.parse(cleaned)
  } catch (err) {
    throw new Error(`JSON de scores inválido: ${err.message}. Raw: ${cleaned.slice(0, 200)}`)
  }

  // Valida e normaliza cada valor recursivamente contra o schema padrão
  function normalizeSection(defaults, received) {
    if (typeof received !== 'object' || received === null) return { ...defaults }
    const result = {}
    for (const key of Object.keys(defaults)) {
      const val = received[key]
      if (typeof val === 'number' && Number.isFinite(val)) {
        result[key] = Math.min(100, Math.max(0, Math.round(val)))
      } else {
        result[key] = defaults[key]   // fallback para 0 se ausente ou inválido
      }
    }
    return result
  }

  const validated = {}
  for (const section of Object.keys(DEFAULT_ANALYSIS_DATA)) {
    validated[section] = normalizeSection(
      DEFAULT_ANALYSIS_DATA[section],
      parsed[section],
    )
  }

  return validated
}

// ─── Banco de Dados ───────────────────────────────────────────────────────────

async function dbSaveAnalysis(userId, meetingId, title, analysisText, analysisData) {
  const { data, error } = await supabase
    .from('meetings')
    .upsert(
      {
        id:            meetingId,
        user_id:       userId,
        title:         sanitize(title, MAX_TITLE_LEN),
        analysis:      analysisText,
        analysis_data: analysisData,
      },
      { onConflict: 'id' },
    )
    .select('id, title, created_at')
    .maybeSingle()

  if (error) throw new Error(`Supabase upsert: ${error.message}`)
  return data
}

async function dbGetAnalysis(userId, meetingId) {
  const { data, error } = await supabase
    .from('meetings')
    .select('id, title, analysis, analysis_data, created_at')
    .eq('id', meetingId)
    .eq('user_id', userId)   // ← ownership check — crítico para segurança
    .maybeSingle()

  if (error) throw new Error(`Supabase select: ${error.message}`)
  return data   // null se não encontrado ou não autorizado
}

async function dbListAnalyses(userId, page, pageSize) {
  const from = (page - 1) * pageSize
  const to   = from + pageSize - 1

  const { data, error, count } = await supabase
    .from('meetings')
    .select('id, title, created_at', { count: 'exact' })
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .range(from, to)

  if (error) throw new Error(`Supabase list: ${error.message}`)
  return { analyses: data, total: count }
}

async function dbDeleteAnalysis(userId, meetingId) {
  const { error } = await supabase
    .from('meetings')
    .delete()
    .eq('id', meetingId)
    .eq('user_id', userId)   // ← ownership check

  if (error) throw new Error(`Supabase delete: ${error.message}`)
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

/**
 * POST ?action=analyze
 *
 * Body (application/json):
 * {
 *   "transcript": { ... }   // JSON da transcrição da reunião (obrigatório)
 *   "meeting_id": "uuid"    // (opcional) — se omitido, gera novo UUID
 *   "title":      "string"  // (opcional) — título da análise
 * }
 *
 * Resposta (200):
 * {
 *   "id":            "uuid",
 *   "title":         "string",
 *   "analysis":      "markdown string",
 *   "analysis_data": { ... scores ... },
 *   "created_at":    "ISO 8601"
 * }
 */
async function handleAnalyze(req, res, userId) {
  // ── Rate limit ────────────────────────────────────────────────────────────
  const rl = checkRateLimit(userId)
  if (rl.limited) {
    res.setHeader('Retry-After', String(rl.retryAfter))
    return sendError(res, 429, 'Muitas requisições. Aguarde antes de processar outra análise.')
  }

  // ── Validação do body ─────────────────────────────────────────────────────
  const body = req.body ?? {}

  if (!body.transcript || typeof body.transcript !== 'object') {
    return sendError(res, 400, 'O campo "transcript" é obrigatório e deve ser um objeto JSON.')
  }

  const meetingId = sanitize(body.meeting_id ?? crypto.randomUUID(), 36) || crypto.randomUUID()
  const rawTitle  = sanitize(body.title ?? '', MAX_TITLE_LEN)

  // Converte o JSON de transcrição em texto para o modelo
  const transcriptStr = JSON.stringify(body.transcript, null, 2)
  if (transcriptStr.length < 50) {
    return sendError(res, 400, 'A transcrição está vazia ou muito curta para ser analisada.')
  }
  const transcriptSafe = sanitize(transcriptStr)

  // ── Configura tokens máximos ──────────────────────────────────────────────
  const maxTokensAnalysis = parseInt(optEnv('OPENROUTER_MAX_TOKENS', '8192'), 10)
  const maxTokensScores   = 2048   // JSON de scores é compacto

  // ── Prompt de usuário compartilhado ──────────────────────────────────────
  const userPrompt = `TRANSCRIÇÃO DA REUNIÃO:\n\n${transcriptSafe}`

  // ── Chamada 1: relatório narrativo corporativo ────────────────────────────
  const systemWithDate = SYSTEM_PROMPT_ANALYSIS.replace('{{DATA}}', formatDateBR())
  let   analysisText

  try {
    analysisText = await callOpenRouter(systemWithDate, userPrompt, maxTokensAnalysis)
  } catch (err) {
    console.error('[analyze] Erro ao gerar relatório narrativo:', err.message)
    return sendError(res, 502, 'Falha ao gerar o relatório de análise. Tente novamente.')
  }

  // ── Chamada 2: JSON de scores numéricos ───────────────────────────────────
  let analysisData

  try {
    const scoresRaw = await callOpenRouter(SYSTEM_PROMPT_SCORES, userPrompt, maxTokensScores)
    analysisData    = parseAndValidateScores(scoresRaw)
  } catch (err) {
    // Score é secundário — não aborta se falhar; usa valores zerados
    console.error('[analyze] Erro ao gerar scores (usando defaults):', err.message)
    analysisData = { ...DEFAULT_ANALYSIS_DATA }
  }

  // ── Deriva título automático se não fornecido ──────────────────────────────
  const finalTitle = rawTitle || deriveTitle(body.transcript)

  // ── Persiste no Supabase ───────────────────────────────────────────────────
  let savedRecord
  try {
    savedRecord = await dbSaveAnalysis(userId, meetingId, finalTitle, analysisText, analysisData)
  } catch (err) {
    console.error('[analyze] Erro ao salvar no Supabase:', err.message)
    // Retorna a análise mesmo sem persistência — o cliente ainda recebe o resultado
    return res.status(200).json({
      id:            meetingId,
      title:         finalTitle,
      analysis:      analysisText,
      analysis_data: analysisData,
      created_at:    new Date().toISOString(),
      warning:       'Análise gerada com sucesso, mas houve falha ao persistir no banco de dados.',
    })
  }

  return res.status(200).json({
    id:            savedRecord?.id ?? meetingId,
    title:         savedRecord?.title ?? finalTitle,
    analysis:      analysisText,
    analysis_data: analysisData,
    created_at:    savedRecord?.created_at ?? new Date().toISOString(),
  })
}

/**
 * Deriva um título legível a partir do JSON da transcrição.
 * Tenta campos comuns; senão gera título com data.
 */
function deriveTitle(transcript) {
  const candidates = [
    transcript?.title,
    transcript?.meeting_title,
    transcript?.name,
    transcript?.subject,
    transcript?.meeting?.title,
    transcript?.meeting?.name,
  ]

  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) {
      return sanitize(c.trim(), MAX_TITLE_LEN)
    }
  }

  const date = new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeZone:  'America/Sao_Paulo',
  }).format(new Date())

  return `Análise de Reunião — ${date}`
}

/** GET ?action=get&id=<uuid> */
async function handleGet(req, res, userId) {
  const { id } = req.query
  if (!id) return sendError(res, 400, 'Parâmetro "id" é obrigatório.')

  const record = await dbGetAnalysis(userId, id)
  if (!record)  return sendError(res, 404, 'Análise não encontrada.')

  return res.status(200).json(record)
}

/** GET ?action=list */
async function handleList(req, res, userId) {
  const page     = Math.max(1, parseInt(req.query.page      ?? '1',                       10))
  const pageSize = Math.min(PAGE_SIZE_MAX,
                  Math.max(1, parseInt(req.query.page_size  ?? String(PAGE_SIZE_DEFAULT), 10)))

  const result = await dbListAnalyses(userId, page, pageSize)
  return res.status(200).json({ ...result, page, page_size: pageSize })
}

/** DELETE ?action=delete&id=<uuid> */
async function handleDelete(req, res, userId) {
  const { id } = req.query
  if (!id) return sendError(res, 400, 'Parâmetro "id" é obrigatório.')

  // Verifica ownership antes de deletar
  const record = await dbGetAnalysis(userId, id)
  if (!record) return sendError(res, 404, 'Análise não encontrada.')

  await dbDeleteAnalysis(userId, id)
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
      case 'analyze':
        if (req.method !== 'POST')   return sendError(res, 405, 'Método não permitido.')
        return await handleAnalyze(req, res, userId)

      case 'get':
        if (req.method !== 'GET')    return sendError(res, 405, 'Método não permitido.')
        return await handleGet(req, res, userId)

      case 'list':
        if (req.method !== 'GET')    return sendError(res, 405, 'Método não permitido.')
        return await handleList(req, res, userId)

      case 'delete':
        if (req.method !== 'DELETE') return sendError(res, 405, 'Método não permitido.')
        return await handleDelete(req, res, userId)

      default:
        return sendError(res, 400, `Ação desconhecida: "${action}".`)
    }
  } catch (err) {
    console.error(`[analyze/${action}] Erro inesperado:`, err.message)
    // Nunca expõe stack trace ao cliente
    return sendError(res, 500, 'Erro interno do servidor.')
  }
}