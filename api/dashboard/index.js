/**
 * /api/dashboard/index.js
 * ========================
 * Análise Geral de Desempenho — Vercel Serverless Function (Node.js, ESM)
 *
 * Consolida as métricas de todas as análises (`meetings`) do usuário em um
 * snapshot de desempenho geral (métricas em JSON + relatório em Markdown) e o
 * persiste na tabela `dashboard`. A leitura pelo front é feita direto no banco.
 *
 * Rotas  →  ?action=<ação>
 * ─────────────────────────────────────────────────────────────────────────────
 *  POST   ?action=generate   Gera manualmente a análise geral (usuário autenticado)
 *  GET    ?action=cron       Execução semanal para todos os usuários (Vercel Cron)
 *
 * Tabela Supabase: `dashboard`
 *  id                uuid (PK)
 *  user_id           uuid
 *  analysis          text     (relatório em Markdown, pronto para PDF)
 *  analysis_data     jsonb    (métricas consolidadas)
 *  performance_rate  numeric  (% de variação da média geral vs. análise anterior;
 *                              100 quando não há análise anterior)
 *  total_analyses    numeric  (transcrições com métricas usadas na consolidação)
 *  created_at        timestamptz
 *
 * Variáveis de Ambiente (Vercel → Settings → Environment Variables)
 * ─────────────────────────────────────────────────────────────────
 *  OPENROUTER_API_KEY        Chave de API do OpenRouter (obrigatória)
 *  OPENROUTER_MODEL          Modelo a usar (padrão: nvidia/nemotron-3-ultra-550b-a55b:free)
 *  DASHBOARD_MAX_TOKENS      Tokens máximos do relatório (padrão: 4096)
 *  SUPABASE_URL              URL do projeto Supabase (obrigatória)
 *  SUPABASE_SERVICE_ROLE_KEY Chave service role do Supabase (obrigatória)
 *  JWT_SECRET                Segredo para verificação do JWT de sessão (obrigatória)
 *  CRON_SECRET               Segredo enviado pela Vercel no header Authorization do cron (obrigatória)
 */

import { timingSafeEqual } from 'node:crypto'
import { supabase } from '../_lib/supabase.js'
import { getUserId } from '../_lib/auth.js'
import { applyCors } from '../_cors.js'

// ─── Constantes ───────────────────────────────────────────────────────────────

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const OPENROUTER_TIMEOUT_MS = 75_000
const REPORT_MAX_ATTEMPTS = 2

const PAGE_SIZE = 1000
const TIMELINE_MAX_WEEKS = 12
const HIGHLIGHTS_COUNT = 3
const TIMEZONE = 'America/Sao_Paulo'

const CRON_CONCURRENCY = 3
const CRON_TIME_BUDGET_MS = 120_000   // não inicia novos usuários após esse tempo (maxDuration = 300s)

const VALID_GOALS = ['success', 'partial', 'fail']

// Estrutura das métricas por reunião (`meetings.analysis_data`)
const METRIC_SCHEMA = {
    meeting_analysis: ['effectiveness', 'productivity', 'goal_achievement', 'decision_quality'],
    engagement: ['overall', 'participation', 'interaction', 'attention'],
    communication: ['clarity', 'objectivity', 'persuasion', 'active_listening', 'objection_handling'],
    sentiment: ['client', 'team', 'positivity', 'negativity'],
    customer: ['satisfaction', 'trust', 'engagement_level', 'pain_understanding', 'solution_fit'],
    business: ['deal_progress', 'conversion_likelihood', 'perceived_value', 'expected_value', 'urgency'],
    execution: ['time_management', 'agenda_adherence', 'next_steps_clarity', 'follow_up_quality'],
    risk: ['churn', 'deal_loss', 'objection', 'disengagement'],
    intelligence: ['alignment', 'buying_signal', 'decision_momentum', 'stakeholder_influence'],
    summary_scores: ['overall_score', 'client_health', 'deal_health'],
}

// Métricas em que um valor MAIOR é PIOR
const INVERTED_METRICS = new Set([
    'risk.churn', 'risk.deal_loss', 'risk.objection', 'risk.disengagement', 'sentiment.negativity',
])

// ─── Prompt do Sistema ────────────────────────────────────────────────────────

const SYSTEM_PROMPT_DASHBOARD = JSON.stringify({
    papel: 'Consultor sênior de performance comercial B2B e análise de operações de vendas.',
    objetivo: 'Produzir um relatório executivo de desempenho geral da empresa, enxuto, bem fundamentado ' +
        'e não repetitivo, baseado exclusivamente nas métricas consolidadas fornecidas.',
    principios_de_analise: [
        'Toda afirmação relevante deve citar os valores das métricas fornecidas (ex.: "clareza em 72.4") — nunca generalidades sem número.',
        'Nunca invente métricas, clientes, reuniões, causas, datas ou números que não estejam nos dados. Relações de causa e efeito devem ser apresentadas como hipóteses ("sugere", "indica"), nunca como fato.',
        'Todas as métricas usam escala de 0 a 100. Em risk.* e sentiment.negativity, um valor MAIOR é PIOR: interprete essas métricas de forma inversa.',
        'overall.growth_rate é a variação percentual da média geral (overall.average) em relação à análise anterior (overall.previous_average). Quando previous_average for null, esta é a primeira análise: o valor 100 é apenas convenção de linha de base e NÃO deve ser apresentado como crescimento real.',
        'Se total_analyses for menor que 5, ou se a timeline tiver menos de 3 semanas, declare a limitação da amostra e evite conclusões fortes de tendência.',
        'Se excluded_without_scores for maior que zero, informe em uma frase que essas análises ficaram fora do cálculo por não possuírem métricas.',
        'Cada seção deve agregar informação nova: não repita a mesma conclusão, métrica ou evidência em mais de uma seção.',
        'Tom executivo, direto, sem floreios e sem emojis.',
    ],
    formato_de_saida: {
        tipo: 'markdown',
        proibido: ['JSON', 'HTML', 'comentários HTML', 'blocos de código ```', 'emojis', 'itálico decorativo'],
        proposito: 'Este documento será convertido diretamente em PDF.',
        regras_de_formatacao: [
            'Um único H1 no topo com o título "Relatório de Desempenho Geral".',
            'H2 para cada seção principal, sem numeração manual.',
            'Uma única tabela Markdown consolidando as métricas-chave — não repetir esses números em prosa nas seções seguintes.',
            'Usar blockquote (>) somente para o risco mais crítico e para o veredito final — nunca para texto comum.',
            'Negritar (**termo**) apenas termos que sustentam diretamente uma conclusão.',
            'Usar "---" apenas para separar o bloco de métricas do restante do relatório.',
            'Responder apenas com o Markdown do relatório, sem texto antes ou depois.',
        ],
    },
    estrutura_do_relatorio: [
        '# Relatório de Desempenho Geral',
        '## Sumário Executivo — nível geral de desempenho, evolução, principal força, principal ponto de atenção e recomendação prioritária, em no máximo 4 frases.',
        '## Panorama de Métricas — tabela Markdown (Métrica | Média | Leitura) com as 6-8 métricas mais decisivas, incluindo overall_score, client_health, deal_health e a taxa de objetivos cumpridos (goals.success.rate); cada leitura em uma frase objetiva.',
        '---',
        '## Evolução — leitura da timeline semanal e da variação em relação à análise anterior, separando tendência de ruído conforme o tamanho da amostra.',
        '## Pontos Fortes — até 3 forças (highlights.strengths) com valores e o porquê de sustentarem o resultado.',
        '## Pontos de Atenção — até 3 fragilidades (highlights.weaknesses) com valores e impacto provável.',
        '## Riscos Críticos — no máximo 3 riscos, cada um com evidência numérica; o mais crítico em blockquote.',
        '## Recomendações Prioritárias — de 3 a 5 ações priorizadas, cada uma ligada à métrica que a justifica e com uma meta numérica sugerida.',
        '> **Veredito de desempenho:** parágrafo curto com a conclusão geral e a evidência que a sustenta.',
    ],
}, null, 2)

// ─── Helpers ──────────────────────────────────────────────────────────────────

function requireEnv(key) {
    const v = process.env[key]
    if (!v) throw new Error(`Variável de ambiente ausente: ${key}`)
    return v
}

function optEnv(key, fallback = '') {
    return process.env[key] ?? fallback
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

const round1 = n => Math.round(n * 10) / 10
const round2 = n => Math.round(n * 100) / 100
const mean = values => values.reduce((sum, v) => sum + v, 0) / values.length
const toScore = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
})

/** Segunda-feira (YYYY-MM-DD) da semana em que a data ocorre, no fuso do negócio */
function weekStart(isoDate) {
    const [y, m, d] = dateFormatter.format(new Date(isoDate)).split('-').map(Number)
    const day = new Date(Date.UTC(y, m - 1, d))
    day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7))
    return day.toISOString().slice(0, 10)
}

// ─── Banco de Dados ───────────────────────────────────────────────────────────

async function dbFetchMeetings(userId) {
    const meetings = []

    for (let from = 0; ; from += PAGE_SIZE) {
        const { data, error } = await supabase
            .from('meetings')
            .select('id, title, goal, analysis_data, created_at')
            .eq('user_id', userId)
            .order('created_at', { ascending: true })
            .order('id', { ascending: true })
            .range(from, from + PAGE_SIZE - 1)

        if (error) throw new Error(`Supabase meetings: ${error.message}`)
        meetings.push(...data)
        if (data.length < PAGE_SIZE) break
    }

    return meetings
}

async function dbGetLatestDashboard(userId) {
    const { data, error } = await supabase
        .from('dashboard')
        .select('id, analysis_data, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

    if (error) throw new Error(`Supabase dashboard select: ${error.message}`)
    return data
}

async function dbSaveDashboard(userId, analysis, analysisData, performanceRate, totalAnalyses) {
    const { data, error } = await supabase
        .from('dashboard')
        .insert({
            user_id: userId,
            analysis,
            analysis_data: analysisData,
            performance_rate: performanceRate,
            total_analyses: totalAnalyses,
        })
        .select('id, performance_rate, total_analyses, created_at')
        .single()

    if (error) throw new Error(`Supabase dashboard insert: ${error.message}`)
    return data
}

async function dbListUserIds() {
    const ids = []

    for (let from = 0; ; from += PAGE_SIZE) {
        const { data, error } = await supabase
            .from('users')
            .select('id')
            .order('id', { ascending: true })
            .range(from, from + PAGE_SIZE - 1)

        if (error) throw new Error(`Supabase users: ${error.message}`)
        ids.push(...data.map(u => u.id))
        if (data.length < PAGE_SIZE) break
    }

    return ids
}

// ─── Consolidação das Métricas ────────────────────────────────────────────────

/** Uma análise só entra no cálculo se possuir ao menos uma métrica positiva */
function hasScores(data) {
    if (!data || typeof data !== 'object') return false
    return Object.entries(METRIC_SCHEMA).some(([section, keys]) =>
        keys.some(key => toScore(data[section]?.[key]) > 0))
}

/** Variação percentual da média geral; 100 quando não há análise anterior comparável */
function computeGrowthRate(current, previous) {
    if (previous === null) return 100
    if (previous === 0) return current > 0 ? 100 : 0
    return round2(((current - previous) / previous) * 100)
}

function meetingOverall(meeting) {
    return toScore(meeting.analysis_data?.summary_scores?.overall_score)
}

function buildRankableMetrics(averages) {
    const metrics = []
    for (const [section, keys] of Object.entries(METRIC_SCHEMA)) {
        if (section === 'summary_scores') continue
        for (const key of keys) {
            const path = `${section}.${key}`
            const value = averages[section][key]
            const inverted = INVERTED_METRICS.has(path)
            metrics.push({
                path,
                value,
                direction: inverted ? 'lower_is_better' : 'higher_is_better',
                quality: inverted ? 100 - value : value,
            })
        }
    }
    return metrics.sort((a, b) => b.quality - a.quality)
}

function buildTimeline(scored) {
    const weeks = new Map()

    for (const meeting of scored) {
        const key = weekStart(meeting.created_at)
        if (!weeks.has(key)) weeks.set(key, [])
        weeks.get(key).push(meeting)
    }

    return [...weeks.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(-TIMELINE_MAX_WEEKS)
        .map(([week, items]) => ({
            week_start: week,
            meetings: items.length,
            overall_average: round1(mean(items.map(meetingOverall))),
            success_rate: round1((items.filter(m => m.goal === 'success').length / items.length) * 100),
        }))
}

function summarizeMeeting(meeting) {
    return {
        id: meeting.id,
        title: meeting.title,
        overall_score: meetingOverall(meeting),
        goal: meeting.goal,
        created_at: meeting.created_at,
    }
}

/**
 * Consolida todas as análises com métricas em um único snapshot.
 * Retorna null quando nenhuma análise possui métricas utilizáveis.
 */
function buildAnalysisData(meetings, previousAverage, trigger) {
    const scored = meetings.filter(m => hasScores(m.analysis_data))
    if (!scored.length) return null

    const averages = {}
    for (const [section, keys] of Object.entries(METRIC_SCHEMA)) {
        averages[section] = {}
        for (const key of keys) {
            averages[section][key] = round1(mean(scored.map(m => toScore(m.analysis_data[section]?.[key]))))
        }
    }

    const average = averages.summary_scores.overall_score
    const goals = {}
    for (const goal of VALID_GOALS) {
        const count = scored.filter(m => m.goal === goal).length
        goals[goal] = { count, rate: round1((count / scored.length) * 100) }
    }

    const ranked = buildRankableMetrics(averages)
    const pick = list => list.map(({ path, value, direction }) => ({ path, value, direction }))
    const byOverall = [...scored].sort((a, b) => meetingOverall(b) - meetingOverall(a))

    return {
        schema_version: 1,
        generated_at: new Date().toISOString(),
        trigger,
        total_analyses: scored.length,
        excluded_without_scores: meetings.length - scored.length,
        period: { from: scored[0].created_at, to: scored[scored.length - 1].created_at },
        overall: {
            average,
            previous_average: previousAverage,
            delta_points: previousAverage === null ? null : round1(average - previousAverage),
            growth_rate: computeGrowthRate(average, previousAverage),
        },
        averages,
        goals,
        highlights: {
            strengths: pick(ranked.slice(0, HIGHLIGHTS_COUNT)),
            weaknesses: pick(ranked.slice(-HIGHLIGHTS_COUNT).reverse()),
        },
        best_meeting: summarizeMeeting(byOverall[0]),
        worst_meeting: scored.length > 1 ? summarizeMeeting(byOverall[byOverall.length - 1]) : null,
        timeline: buildTimeline(scored),
    }
}

// ─── Geração do Relatório (OpenRouter) ────────────────────────────────────────

async function callOpenRouter(systemPrompt, userMessage, maxTokens) {
    const model = optEnv('OPENROUTER_MODEL', 'nvidia/nemotron-3-ultra-550b-a55b:free')

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
            temperature: 0.2,
        }),
        signal: AbortSignal.timeout(OPENROUTER_TIMEOUT_MS),
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

/** Remove raciocínio (<think>), code fences e qualquer texto anterior ao H1 */
function cleanReport(rawText) {
    const text = rawText
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/^\s*```(?:markdown|md)?[ \t]*\r?\n/i, '')
        .replace(/\r?\n```\s*$/, '')
        .trim()

    const start = text.search(/^# /m)
    if (start === -1) throw new Error('O relatório retornado não contém o título principal (H1).')

    return text.slice(start).trim()
}

async function generateReport(analysisData) {
    const maxTokens = parseInt(optEnv('DASHBOARD_MAX_TOKENS', '4096'), 10)
    const userPrompt = `MÉTRICAS CONSOLIDADAS DA EMPRESA:\n\n${JSON.stringify(analysisData, null, 2)}`
    let lastError

    for (let attempt = 1; attempt <= REPORT_MAX_ATTEMPTS; attempt++) {
        try {
            return cleanReport(await callOpenRouter(SYSTEM_PROMPT_DASHBOARD, userPrompt, maxTokens))
        } catch (err) {
            lastError = err
            console.warn(`[dashboard] Relatório — tentativa ${attempt}/${REPORT_MAX_ATTEMPTS} falhou:`, err.message)
        }
    }

    throw lastError
}

// ─── Orquestração ─────────────────────────────────────────────────────────────

const _inFlight = new Set()

/**
 * Executa a análise geral de um usuário.
 * Status: completed | up_to_date | no_data | generation_failed | in_progress
 */
async function runAnalysis(userId, trigger) {
    if (_inFlight.has(userId)) return { status: 'in_progress' }
    _inFlight.add(userId)

    try {
        const [meetings, previous] = await Promise.all([
            dbFetchMeetings(userId),
            dbGetLatestDashboard(userId),
        ])

        if (!meetings.length) return { status: 'no_data' }

        // Sem novas análises desde o último snapshot: evita duplicar registro e custo de modelo
        if (previous) {
            const lastGeneratedAt = new Date(previous.created_at)
            if (!meetings.some(m => new Date(m.created_at) > lastGeneratedAt)) {
                return { status: 'up_to_date', id: previous.id, created_at: previous.created_at }
            }
        }

        const previousAverage = previous?.analysis_data?.overall?.average
        const analysisData = buildAnalysisData(
            meetings,
            typeof previousAverage === 'number' ? previousAverage : null,
            trigger,
        )
        if (!analysisData) return { status: 'no_data' }

        let report
        try {
            report = await generateReport(analysisData)
        } catch (err) {
            console.error(`[dashboard] Falha ao gerar relatório (user ${userId}):`, err.message)
            return { status: 'generation_failed' }
        }

        const record = await dbSaveDashboard(
            userId, report, analysisData,
            analysisData.overall.growth_rate, analysisData.total_analyses,
        )

        return { status: 'completed', record }
    } finally {
        _inFlight.delete(userId)
    }
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

/**
 * POST ?action=generate
 *
 * Resposta (200 — status "completed"):
 * {
 *   "status":           "completed",
 *   "id":               "uuid",
 *   "performance_rate": 4.35,
 *   "total_analyses":   18,
 *   "created_at":       "ISO 8601"
 * }
 *
 * Resposta (200 — status "up_to_date"): nenhuma análise nova desde o último snapshot
 * { "status": "up_to_date", "id": "uuid", "created_at": "ISO 8601", "message": "..." }
 *
 * Erros: 409 (em andamento) | 422 (sem métricas) | 502 (falha do modelo)
 */
async function handleGenerate(res, userId) {
    const result = await runAnalysis(userId, 'manual')

    switch (result.status) {
        case 'completed':
            return res.status(200).json({ status: 'completed', ...result.record })

        case 'up_to_date':
            return res.status(200).json({
                status: 'up_to_date',
                id: result.id,
                created_at: result.created_at,
                message: 'Nenhuma análise nova desde a última geração.',
            })

        case 'no_data':
            return sendError(res, 422, 'Não há análises com métricas disponíveis para consolidar.')

        case 'in_progress':
            return sendError(res, 409, 'Já existe uma análise geral em andamento.')

        default:
            return sendError(res, 502, 'Falha ao gerar a análise geral. Tente novamente.')
    }
}

const CRON_SUMMARY_KEYS = {
    completed: 'generated',
    up_to_date: 'up_to_date',
    no_data: 'no_data',
    in_progress: 'skipped_in_progress',
    generation_failed: 'failed',
}

/** GET ?action=cron — executado pela Vercel Cron toda segunda-feira */
async function handleCron(res) {
    const startedAt = Date.now()
    const userIds = await dbListUserIds()
    const summary = {
        total_users: userIds.length,
        generated: 0,
        up_to_date: 0,
        no_data: 0,
        skipped_in_progress: 0,
        failed: 0,
        not_processed: 0,
    }

    let cursor = 0
    const worker = async () => {
        while (cursor < userIds.length && Date.now() - startedAt < CRON_TIME_BUDGET_MS) {
            const userId = userIds[cursor++]
            try {
                const { status } = await runAnalysis(userId, 'cron')
                summary[CRON_SUMMARY_KEYS[status]]++
            } catch (err) {
                summary.failed++
                console.error(`[dashboard/cron] Erro (user ${userId}):`, err.message)
            }
        }
    }

    await Promise.all(Array.from({ length: CRON_CONCURRENCY }, worker))

    summary.not_processed = userIds.length - cursor
    summary.duration_ms = Date.now() - startedAt
    console.info('[dashboard/cron] Resumo:', JSON.stringify(summary))

    return res.status(200).json(summary)
}

/** Valida o header Authorization enviado pela Vercel (falha fechada sem CRON_SECRET) */
function isValidCronRequest(req) {
    const secret = process.env.CRON_SECRET
    if (!secret) {
        console.error('[dashboard/cron] CRON_SECRET não configurado.')
        return false
    }

    const received = Buffer.from(req.headers.authorization ?? '')
    const expected = Buffer.from(`Bearer ${secret}`)
    return received.length === expected.length && timingSafeEqual(received, expected)
}

// ─── Handler Principal ────────────────────────────────────────────────────────

export default async function handler(req, res) {
    // CORS — reutiliza _cors.js do projeto
    if (applyCors(req, res)) return

    applySecurityHeaders(res)

    // A Vercel Cron chama o path sem query string: identifica a chamada pelo header do agendador
    const action = req.query.action ?? (req.headers['x-vercel-cron-schedule'] ? 'cron' : undefined)

    try {
        switch (action) {
            case 'cron':
                if (req.method !== 'GET') return sendError(res, 405, 'Método não permitido.')
                if (!isValidCronRequest(req)) return sendError(res, 401, 'Não autorizado.')
                return await handleCron(res)

            case 'generate': {
                if (req.method !== 'POST') return sendError(res, 405, 'Método não permitido.')

                // Autenticação via cookie de sessão JWT — mesmo padrão de analysis/index.js
                const userId = getUserId(req)
                if (!userId) return sendError(res, 401, 'Não autenticado.')

                return await handleGenerate(res, userId)
            }

            default:
                return sendError(res, 400, `Ação desconhecida: "${action}".`)
        }
    } catch (err) {
        console.error(`[dashboard/${action}] Erro inesperado:`, err.message)
        // Nunca expõe stack trace ao cliente
        return sendError(res, 500, 'Erro interno do servidor.')
    }
}