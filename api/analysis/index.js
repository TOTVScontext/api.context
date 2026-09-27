/**
 * /api/analysis/index.js
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
 *  OPENROUTER_MAX_TOKENS     Tokens máximos do relatório (padrão: 3072)
 *  SUPABASE_URL              URL do projeto Supabase (obrigatória)
 *  SUPABASE_SERVICE_ROLE_KEY Chave service role do Supabase (obrigatória)
 *  JWT_SECRET                Segredo para verificação do JWT de sessão (obrigatória)
 *
 * Notas desta revisão
 * ─────────────────────────────────────────────────────────────────
 *  • O relatório narrativo agora é gerado como JSON estruturado (mais compacto,
 *    mais rápido de gerar e mais fácil de renderizar/exportar para PDF depois).
 *  • As duas chamadas ao modelo (relatório + scores) rodam em paralelo
 *    (Promise.allSettled), reduzindo a latência total quase pela metade.
 *  • Novos campos persistidos e retornados: `size` (tamanho da transcrição),
 *    `goal` (cumprimento do objetivo da reunião) e `transcription` (transcrição
 *    original, preservada integralmente).
 */

import { supabase } from '../_lib/supabase.js'
import { getUserId } from '../_lib/auth.js'
import { applyCors } from '../_cors.js'

// ─── Constantes ───────────────────────────────────────────────────────────────

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const MAX_TRANSCRIPT_LEN = 120_000   // ~30k tokens de contexto de entrada
const MAX_TITLE_LEN = 255
const PAGE_SIZE_DEFAULT = 20
const PAGE_SIZE_MAX = 50

// Rate limit em memória por userId (evita sobrecarga e custo excessivo de API)
const _rlMap = new Map()
const RL_WINDOW_MS = 60_000   // janela de 1 minuto
const RL_MAX_REQS = 10       // análises são pesadas — limite conservador

const VALID_GOALS = new Set(['success', 'partial', 'fail'])

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
 * Especificação estruturada (JSON) do relatório narrativo corporativo (coluna
 * `analysis`). A instrução é escrita como JSON — mais determinística e fácil de
 * versionar do que um bloco de texto livre — mas o CONTEÚDO GERADO pelo modelo
 * deve ser Markdown puro, pronto para conversão em PDF seguindo um sistema
 * visual inspirado no IBM Carbon Design (fundo predominantemente branco, texto
 * em preto/cinza-escuro, e um dourado usado com extrema sobriedade apenas em
 * pontos de destaque). O objetivo da reunião ("success" | "partial" | "fail")
 * vem embutido em um comentário HTML de metadados no fim do documento, para
 * ser extraído programaticamente sem poluir o corpo visível do relatório.
 */
const SYSTEM_PROMPT_ANALYSIS = JSON.stringify({
    papel: 'Consultor sênior de vendas B2B e diagnóstico de reuniões corporativas.',
    objetivo: 'Produzir um diagnóstico executivo enxuto, bem fundamentado e não repetitivo, ' +
        'baseado exclusivamente em evidências da transcrição fornecida.',
    principios_de_analise: [
        'Cada afirmação relevante deve se apoiar em uma evidência concreta da transcrição — nunca em generalidade vazia (ex.: "a reunião foi produtiva" sem evidência é inaceitável).',
        'Nunca invente fatos, participantes, números, datas ou trechos que não constem na transcrição.',
        'Se a transcrição não contiver elementos suficientes para avaliar um ponto, declare isso objetivamente em vez de preencher com texto genérico.',
        'Cada seção deve agregar informação nova: não repita a mesma conclusão, métrica ou evidência em mais de uma seção.',
        'Tom executivo, direto, sem floreios e sem emojis.',
    ],
    formato_de_saida: {
        tipo: 'markdown',
        proibido: ['JSON', 'HTML visível', 'blocos de código ```', 'emojis', 'itálico decorativo'],
        proposito: 'Este documento será convertido diretamente em PDF.',
        sistema_visual: {
            inspiracao: 'IBM Carbon Design System',
            paleta: {
                fundo: '50% branco',
                texto: '45% preto / cinza-grafite',
                destaque: '15% dourado — aplicado com extrema sutileza, apenas em elementos que o layout tratará como destaque',
            },
            elementos_que_recebem_destaque_dourado_na_diagramacao: [
                'blockquotes (>) — usar apenas para o veredito do objetivo da reunião e para o risco mais crítico',
                'a linha divisória (---) entre o bloco de métricas e o restante do relatório',
            ],
            regras_de_formatacao: [
                'Um único H1 no topo com o título "Relatório de Análise de Reunião".',
                'H2 para cada seção principal, sem numeração manual (o layout numera automaticamente).',
                'Uma única tabela Markdown consolidando as métricas-chave da reunião — não repetir esses números em prosa nas seções seguintes.',
                'Usar blockquote (>) somente para o veredito do objetivo da reunião e para, no máximo, um risco crítico — nunca para texto comum.',
                'Negritar (**termo**) apenas termos que sustentam diretamente uma conclusão, nunca frases inteiras ou seções completas.',
                'Usar "---" apenas para separar o bloco de métricas do restante do corpo do relatório.',
                'Fechar o documento com uma linha de metadados invisível ao leitor, no formato exato: <!--METADATA:{"objetivo_cumprido":"success"}--> (substituindo o valor por "success", "partial" ou "fail" conforme a avaliação).',
            ],
        },
    },
    estrutura_do_relatorio: [
        '# Relatório de Análise de Reunião',
        '## Sumário Executivo — contexto, achados centrais e recomendação prioritária, em no máximo 4 frases.',
        '## Panorama de Métricas — tabela Markdown com as 5-6 métricas mais decisivas da reunião, cada uma com uma leitura objetiva de uma frase.',
        '---',
        '## Engajamento & Comunicação — síntese única cobrindo participação, clareza, escuta ativa e manejo de objeções, sem repetir o panorama de métricas.',
        '## Saúde do Cliente & Progresso Comercial — sinais de satisfação, confiança, aderência da solução e avanço no ciclo de vendas.',
        '## Riscos Críticos — no máximo 3 riscos, cada um com evidência e impacto estimado; o mais crítico em blockquote.',
        '## Inteligência Comercial & Próximos Passos — sinais de compra, momentum de decisão e recomendações acionáveis (responsável, prazo e objetivo quando a transcrição permitir inferi-los).',
        '> **Objetivo da reunião:** veredito em um parágrafo curto (cumprido, parcial ou não cumprido), com a evidência que sustenta essa conclusão.',
    ],
    objetivo_cumprido: {
        campo: 'objetivo_cumprido (embutido no comentário de metadados final, nunca no corpo visível)',
        criterio: 'Avaliação exclusiva com base em evidências da transcrição, sobre o objetivo declarado ou implícito da reunião.',
        valores: {
            success: 'objetivo claramente cumprido',
            partial: 'parcialmente cumprido ou resultado misto',
            fail: 'não cumprido, ou reunião sem avanço/definição relevante',
        },
    },
}, null, 2)

/**
 * Instrução para geração do JSON de métricas (coluna `analysis_data`).
 * Resposta DEVE ser JSON puro — sem Markdown, sem explicação.
 */
const SYSTEM_PROMPT_SCORES = `\
Você é um sistema de pontuação quantitativa de reuniões comerciais. Sua única
tarefa é converter evidências da transcrição em métricas numéricas objetivas.

REGRAS ABSOLUTAS:
• Responda APENAS com o objeto JSON do schema abaixo — sem texto adicional,
  sem blocos de código, sem explicação, sem comentários.
• Todos os valores são numeros Reais entre 0 e 100, onde:
  0–20   = Muito baixo / crítico
  21–40  = Baixo / abaixo do esperado
  41–60  = Médio / aceitável
  61–80  = Bom / acima da média
  81–100 = Excelente / referência
• Cada pontuação deve ser uma inferência fiel e proporcional às evidências
  concretas presentes na transcrição — nunca uma estimativa genérica.
• Se a transcrição não contiver evidência suficiente para uma métrica específica,
  atribua 0 a essa métrica em vez de estimar ou arredondar para cima.
• Não infle pontuações para parecer "positivo": a fidelidade ao dado tem
  prioridade absoluta sobre qualquer tom favorável.

SCHEMA OBRIGATÓRIO (preencha todos os campos):
{
  "meeting_analysis": {
    "effectiveness": <bool>,
    "productivity": <bool>,
    "goal_achievement": <bool>,
    "decision_quality": <bool>
  },
  "engagement": {
    "overall": <bool>,
    "participation": <bool>,
    "interaction": <bool>,
    "attention": <bool>
  },
  "communication": {
    "clarity": <bool>,
    "objectivity": <bool>,
    "persuasion": <bool>,
    "active_listening": <bool>,
    "objection_handling": <bool>
  },
  "sentiment": {
    "client": <bool>,
    "team": <bool>,
    "positivity": <bool>,
    "negativity": <bool>
  },
  "customer": {
    "satisfaction": <bool>,
    "trust": <bool>,
    "engagement_level": <bool>,
    "pain_understanding": <bool>,
    "solution_fit": <bool>
  },
  "business": {
    "deal_progress": <bool>,
    "conversion_likelihood": <bool>,
    "perceived_value": <bool>,
    "expected_value": <bool>,
    "urgency": <bool>
  },
  "execution": {
    "time_management": <bool>,
    "agenda_adherence": <bool>,
    "next_steps_clarity": <bool>,
    "follow_up_quality": <bool>
  },
  "risk": {
    "churn": <bool>,
    "deal_loss": <bool>,
    "objection": <bool>,
    "disengagement": <bool>
  },
  "intelligence": {
    "alignment": <bool>,
    "buying_signal": <bool>,
    "decision_momentum": <bool>,
    "stakeholder_influence": <bool>
  },
  "summary_scores": {
    "overall_score": <bool>,
    "client_health": <bool>,
    "deal_health": <bool>
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

/** Formata o tamanho em bytes para uma string legível, ex: "14.2 KB" */
function formatSize(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
    const units = ['B', 'KB', 'MB', 'GB']
    let value = bytes
    let unitIndex = 0
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024
        unitIndex++
    }
    const formatted = unitIndex === 0 ? String(Math.round(value)) : value.toFixed(1)
    return `${formatted} ${units[unitIndex]}`
}

// ─── Rate Limiting ────────────────────────────────────────────────────────────

function checkRateLimit(userId) {
    const now = Date.now()
    let entry = _rlMap.get(userId)

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
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${requireEnv('OPENROUTER_API_KEY')}`,
            'Content-Type': 'application/json',
            'X-Title': 'MeetingAnalyzer',
        },
        body: JSON.stringify({
            model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userMessage },
            ],
            stream: false,
            max_tokens: maxTokens,
            temperature: 0.2,   // análises requerem consistência e fidelidade ao dado
        }),
    })

    if (!response.ok) {
        const body = await response.text().catch(() => '(sem corpo)')
        throw new Error(`OpenRouter ${response.status}: ${body}`)
    }

    const data = await response.json()
    const content = data?.choices?.[0]?.message?.content

    if (typeof content !== 'string' || !content.trim()) {
        throw new Error('OpenRouter retornou uma resposta vazia ou inválida.')
    }

    return content.trim()
}

/** Remove blocos de código Markdown (```json ... ```) que o modelo às vezes adiciona */
function stripCodeFence(rawText) {
    return rawText
        .replace(/^```(?:json)?\s*/im, '')
        .replace(/\s*```$/im, '')
        .trim()
}

// ─── Parsing e Validação do JSON de Scores ────────────────────────────────────

/**
 * Extrai e valida o JSON de scores retornado pelo modelo.
 * Garante que todos os campos existam e sejam inteiros 0-100.
 */
function parseAndValidateScores(rawText) {
    const cleaned = stripCodeFence(rawText)

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

/**
 * Extrai o veredito do objetivo (`objetivo_cumprido`) do comentário de
 * metadados embutido ao final do relatório Markdown, e retorna o Markdown já
 * limpo desse comentário (o comentário não deve ser persistido/exibido).
 *
 * Formato esperado ao final do documento:
 *   <!--METADATA:{"objetivo_cumprido":"success"}-->
 */
function extractGoalAndCleanReport(rawText) {
    const cleaned = stripCodeFence(rawText)
    const metadataRegex = /<!--\s*METADATA:\s*(\{[^]*?\})\s*-->/i
    const match = cleaned.match(metadataRegex)

    let goal = 'partial'
    if (match) {
        try {
            const parsedMeta = JSON.parse(match[1])
            if (VALID_GOALS.has(parsedMeta?.objetivo_cumprido)) {
                goal = parsedMeta.objetivo_cumprido
            }
        } catch {
            // Metadados malformados — mantém o fallback "partial" sem abortar a análise
        }
    }

    const markdown = cleaned.replace(metadataRegex, '').trimEnd()

    if (!markdown) {
        throw new Error('O relatório retornado pelo modelo está vazio após a remoção dos metadados.')
    }

    return { markdown, goal }
}

// ─── Banco de Dados ───────────────────────────────────────────────────────────

async function dbSaveAnalysis(userId, meetingId, title, analysisData, analysisScores, size, goal, transcription) {
    const { data, error } = await supabase
        .from('meetings')
        .upsert(
            {
                id: meetingId,
                user_id: userId,
                title: sanitize(title, MAX_TITLE_LEN),
                analysis: analysisData,
                analysis_data: analysisScores,
                size,
                goal,
                transcription,
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
        .select('id, title, analysis, analysis_data, size, goal, transcription, created_at')
        .eq('id', meetingId)
        .eq('user_id', userId)   // ← ownership check — crítico para segurança
        .maybeSingle()

    if (error) throw new Error(`Supabase select: ${error.message}`)
    return data   // null se não encontrado ou não autorizado
}

async function dbListAnalyses(userId, page, pageSize) {
    const from = (page - 1) * pageSize
    const to = from + pageSize - 1

    // A lista não traz `transcription` (potencialmente grande) — apenas metadados leves
    const { data, error, count } = await supabase
        .from('meetings')
        .select('id, title, size, goal, created_at', { count: 'exact' })
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
 *   "title":      "string"  // (opcional) — título da análise
 * }
 *
 * Resposta (200):
 * {
 *   "id":            "uuid",
 *   "title":         "string",
 *   "analysis":      "# Relatório de Análise de Reunião\n\n...(Markdown pronto para PDF)...",
 *   "analysis_data": { ... scores ... },
 *   "size":          "14.2 KB",
 *   "goal":          "success" | "partial" | "fail",
 *   "transcription": { ... transcrição original ... },
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

    const meetingId = crypto.randomUUID()
    const rawTitle = sanitize(body.title ?? '', MAX_TITLE_LEN)

    // Converte o JSON de transcrição em texto para o modelo
    const transcriptStr = JSON.stringify(body.transcript, null, 2)
    if (transcriptStr.length < 50) {
        return sendError(res, 400, 'A transcrição está vazia ou muito curta para ser analisada.')
    }
    const transcriptSafe = sanitize(transcriptStr)
    const transcriptSize = formatSize(Buffer.byteLength(transcriptStr, 'utf8'))

    // ── Configura tokens máximos ──────────────────────────────────────────────
    // Relatório em Markdown enxuto (sem repetição entre seções) — teto de tokens
    // moderado, suficiente para a tabela de métricas e as seções concisas, sem
    // abrir espaço para prolixidade.
    const maxTokensAnalysis = parseInt(optEnv('OPENROUTER_MAX_TOKENS', '3584'), 10)
    const maxTokensScores = 2048   // JSON de scores é compacto

    // ── Prompt de usuário compartilhado ──────────────────────────────────────
    const userPrompt = `TRANSCRIÇÃO DA REUNIÃO:\n\n${transcriptSafe}`

    // ── Chamadas ao modelo em PARALELO (ganho de latência) ────────────────────
    const [analysisSettled, scoresSettled] = await Promise.allSettled([
        callOpenRouter(SYSTEM_PROMPT_ANALYSIS, userPrompt, maxTokensAnalysis),
        callOpenRouter(SYSTEM_PROMPT_SCORES, userPrompt, maxTokensScores),
    ])

    // Relatório narrativo é o núcleo da entrega — se falhar, aborta a requisição
    if (analysisSettled.status !== 'fulfilled') {
        console.error('[analyze] Erro ao gerar relatório narrativo:', analysisSettled.reason?.message)
        return sendError(res, 502, 'Falha ao gerar o relatório de análise. Tente novamente.')
    }

    let reportMarkdown
    let goal
    try {
        const parsed = extractGoalAndCleanReport(analysisSettled.value)
        reportMarkdown = parsed.markdown
        goal = parsed.goal
    } catch (err) {
        console.error('[analyze] Erro ao interpretar relatório narrativo:', err.message)
        return sendError(res, 502, 'Falha ao interpretar o relatório de análise. Tente novamente.')
    }

    // Scores são um complemento quantitativo — falha não aborta a requisição
    let analysisData
    if (scoresSettled.status === 'fulfilled') {
        try {
            analysisData = parseAndValidateScores(scoresSettled.value)
        } catch (err) {
            console.error('[analyze] Erro ao interpretar scores (usando defaults):', err.message)
            analysisData = { ...DEFAULT_ANALYSIS_DATA }
        }
    } else {
        console.error('[analyze] Erro ao gerar scores (usando defaults):', scoresSettled.reason?.message)
        analysisData = { ...DEFAULT_ANALYSIS_DATA }
    }

    // ── Deriva título automático se não fornecido ──────────────────────────────
    const finalTitle = rawTitle || deriveTitle(body.transcript)

    // ── Persiste no Supabase ───────────────────────────────────────────────────
    let savedRecord
    try {
        savedRecord = await dbSaveAnalysis(
            userId, meetingId, finalTitle,
            reportMarkdown, analysisData,
            transcriptSize, goal, body.transcript,
        )
    } catch (err) {
        console.error('[analyze] Erro ao salvar no Supabase:', err.message)
        // Retorna a análise mesmo sem persistência — o cliente ainda recebe o resultado
        return res.status(200).json({
            id: meetingId,
            title: finalTitle,
            analysis: reportMarkdown,
            analysis_data: analysisData,
            size: transcriptSize,
            goal,
            transcription: body.transcript,
            created_at: new Date().toISOString(),
            warning: 'Análise gerada com sucesso, mas houve falha ao persistir no banco de dados.',
        })
    }

    return res.status(200).json({
        id: savedRecord?.id ?? meetingId,
        title: savedRecord?.title ?? finalTitle,
        analysis: reportMarkdown,
        analysis_data: analysisData,
        size: transcriptSize,
        goal,
        transcription: body.transcript,
        created_at: savedRecord?.created_at ?? new Date().toISOString(),
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
        timeZone: 'America/Sao_Paulo',
    }).format(new Date())

    return `Análise de Reunião — ${date}`
}

/** GET ?action=get&id=<uuid> */
async function handleGet(req, res, userId) {
    const { id } = req.query
    if (!id) return sendError(res, 400, 'Parâmetro "id" é obrigatório.')

    const record = await dbGetAnalysis(userId, id)
    if (!record) return sendError(res, 404, 'Análise não encontrada.')

    return res.status(200).json(record)
}

/** GET ?action=list */
async function handleList(req, res, userId) {
    const page = Math.max(1, parseInt(req.query.page ?? '1', 10))
    const pageSize = Math.min(PAGE_SIZE_MAX,
        Math.max(1, parseInt(req.query.page_size ?? String(PAGE_SIZE_DEFAULT), 10)))

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
                if (req.method !== 'POST') return sendError(res, 405, 'Método não permitido.')
                return await handleAnalyze(req, res, userId)

            case 'get':
                if (req.method !== 'GET') return sendError(res, 405, 'Método não permitido.')
                return await handleGet(req, res, userId)

            case 'list':
                if (req.method !== 'GET') return sendError(res, 405, 'Método não permitido.')
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