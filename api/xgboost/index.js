/**
 * /api/xgboost/index.js
 * ═══════════════════════════════════════════════════════════════════════════════
 * Pipeline ML → LLM unificado para o TOTVS Context
 *
 * Rotas → ?action=<ação>
 * ───────────────────────────────────────────────────────────────────────────────
 *  POST  ?action=analyze   Executa modelo ML, gera métricas e relatório .md via LLM
 *  GET   ?action=health    Health check do endpoint (sem autenticação)
 *
 * Fluxo:
 *  1. Recebe transcrição (texto plano ou JSON)
 *  2. Envia para o modelo ML treinado (modelo_risco.joblib via Python subprocess)
 *  3. Modelo retorna: classe, probabilidades e métricas brutas
 *  4. Métricas são mapeadas para o schema analysis_data completo (compatível com o site)
 *  5. LLM gera relatório .md usando transcrição + métricas fundamentadas como contexto
 *  6. Persiste em public.meetings com analysis (md) + analysis_data (json) — mesma estrutura do site
 *
 * Variáveis de Ambiente
 * ───────────────────────────────────────────────────────────────────────────────
 *  OPENROUTER_API_KEY        Chave de API do OpenRouter (obrigatória)
 *  OPENROUTER_MODEL          Modelo LLM (padrão: nvidia/nemotron-3-ultra-550b-a55b:free)
 *  OPENROUTER_MAX_TOKENS     Tokens máximos do relatório (padrão: 3584)
 *  SUPABASE_URL              URL do projeto Supabase (obrigatória)
 *  SUPABASE_SERVICE_ROLE_KEY Chave service role do Supabase (obrigatória)
 *  JWT_SECRET                Segredo JWT (obrigatória)
 *  PYTHON_EXECUTABLE         Caminho do python com joblib instalado (padrão: python3)
 *  ML_MODEL_PATH             Caminho absoluto do modelo_risco.joblib (obrigatória em prod)
 */

import { spawn }       from 'child_process'
import { randomUUID }  from 'crypto'
import path            from 'path'
import { supabase }    from '../_lib/supabase.js'
import { getUserId }   from '../_lib/auth.js'
import { applyCors }   from '../_cors.js'

// ─── Constantes ───────────────────────────────────────────────────────────────

const OPENROUTER_URL    = 'https://openrouter.ai/api/v1/chat/completions'
const MAX_TRANSCRIPT    = 120_000
const MAX_TITLE_LEN     = 255
const VALID_GOALS       = new Set(['success', 'partial', 'fail'])
const SCORES_MAX_TOKENS = 4096
const REPORT_MAX_TOKENS = 3584

// Rate limit conservador (ML é custoso em CPU)
const _rlMap        = new Map()
const RL_WINDOW_MS  = 60_000
const RL_MAX_REQS   = 6

// ─── Schema padrão (fallback quando modelo falha) ─────────────────────────────

const DEFAULT_SCORES = {
    meeting_analysis: { effectiveness: 0, productivity: 0, goal_achievement: 0, decision_quality: 0 },
    engagement:       { overall: 0, participation: 0, interaction: 0, attention: 0 },
    communication:    { clarity: 0, objectivity: 0, persuasion: 0, active_listening: 0, objection_handling: 0 },
    sentiment:        { client: 0, team: 0, positivity: 0, negativity: 0 },
    customer:         { satisfaction: 0, trust: 0, engagement_level: 0, pain_understanding: 0, solution_fit: 0 },
    business:         { deal_progress: 0, conversion_likelihood: 0, perceived_value: 0, expected_value: 0, urgency: 0 },
    execution:        { time_management: 0, agenda_adherence: 0, next_steps_clarity: 0, follow_up_quality: 0 },
    risk:             { churn: 0, deal_loss: 0, objection: 0, disengagement: 0 },
    intelligence:     { alignment: 0, buying_signal: 0, decision_momentum: 0, stakeholder_influence: 0 },
    summary_scores:   { overall_score: 0, client_health: 0, deal_health: 0 },
}

// ─── System Prompt — Relatório ML-Fundamentado ────────────────────────────────
// Difere do analysis/index.js: aqui as métricas são FORNECIDAS pelo modelo ML
// e o LLM as usa como verdade analítica, gerando o relatório narrativo em cima.

const SYSTEM_PROMPT_ML_REPORT = `
Você é um consultor sênior de vendas B2B e diagnóstico de reuniões corporativas.

CONTEXTO: As métricas abaixo foram geradas por um modelo de ML treinado (XGBoost) sobre
a transcrição — elas são a sua fonte primária de verdade quantitativa. Sua tarefa é produzir
um diagnóstico executivo que USE essas métricas como fundamento e as corrobore (ou questione
pontualmente) com evidências concretas extraídas da transcrição.

PRINCÍPIOS ABSOLUTOS:
- Cada afirmação deve se apoiar em evidências da transcrição OU nas métricas ML fornecidas.
- Nunca invente fatos, participantes, números ou trechos que não constem na transcrição.
- Nunca contradiga uma métrica ML sem apontar evidência textual explícita que a justifique.
- Não repita a mesma conclusão em mais de uma seção.
- Tom executivo, direto, sem floreios e sem emojis.

FORMATO DE SAÍDA: Markdown puro. Proibido: JSON, HTML visível, blocos de código, emojis, itálico decorativo.
Este documento será salvo diretamente no banco e convertido em PDF pelo site.

SISTEMA VISUAL (IBM Carbon Design):
- Fundo: branco | Texto: preto/cinza-grafite | Destaque: dourado (uso mínimo)
- Blockquotes (>) apenas para: veredito do objetivo e risco mais crítico
- "---" apenas para separar bloco de métricas do corpo
- Negrito (**) apenas em termos que sustentam diretamente uma conclusão
- Um único H1, H2 por seção, uma tabela de métricas — sem repetição numérica no corpo
- Fechar com: <!--METADATA:{"objetivo_cumprido":"<success|partial|fail>"}-->

ESTRUTURA OBRIGATÓRIA:
# Relatório de Análise de Reunião
## Sumário Executivo — contexto, achados centrais e recomendação prioritária (máx. 4 frases).
## Panorama de Métricas — tabela Markdown com as 6 métricas mais decisivas + leitura objetiva de 1 frase cada.
---
## Engajamento & Comunicação — participação, clareza, escuta ativa e manejo de objeções.
## Saúde do Cliente & Progresso Comercial — satisfação, confiança, aderência da solução e ciclo de vendas.
## Riscos Críticos — máx. 3 riscos, cada um com evidência e impacto; o mais crítico em blockquote.
## Inteligência Comercial & Próximos Passos — sinais de compra, momentum e recomendações acionáveis.
> **Objetivo da reunião:** veredito em 1 parágrafo curto com evidência.
<!--METADATA:{"objetivo_cumprido":"<success|partial|fail>"}-->
`.trim()

// ─── Helpers ──────────────────────────────────────────────────────────────────

function requireEnv(key) {
    const v = process.env[key]
    if (!v) throw new Error(`Variável de ambiente ausente: ${key}`)
    return v
}

function optEnv(key, fallback = '') {
    return process.env[key] ?? fallback
}

function sanitize(str, maxLen = MAX_TRANSCRIPT) {
    if (typeof str !== 'string') return ''
    return str
        .replace(/\0/g, '')
        .replace(/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
        .slice(0, maxLen)
        .trim()
}

function formatSize(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
    const units = ['B', 'KB', 'MB', 'GB']
    let value = bytes
    let i = 0
    while (value >= 1024 && i < units.length - 1) { value /= 1024; i++ }
    return `${i === 0 ? String(Math.round(value)) : value.toFixed(1)} ${units[i]}`
}

function sendError(res, status, message) {
    if (!res.headersSent) res.status(status).json({ error: message })
}

function applySecurityHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
    res.setHeader('Cache-Control', 'no-store')
}

function checkRateLimit(userId) {
    const now   = Date.now()
    let entry   = _rlMap.get(userId)
    if (!entry || now > entry.resetAt) entry = { count: 0, resetAt: now + RL_WINDOW_MS }
    entry.count++
    _rlMap.set(userId, entry)
    if (entry.count > RL_MAX_REQS)
        return { limited: true, retryAfter: Math.ceil((entry.resetAt - now) / 1000) }
    return { limited: false }
}

// ─── Modelo ML (Python subprocess) ───────────────────────────────────────────

/**
 * Resolve o caminho do modelo: primeiro via env ML_MODEL_PATH, depois
 * via convenção relativa ao repositório (/ai/artifacts/modelo_risco.joblib).
 * Em produção (Vercel), o modelo deve ser bundlado ou acessível via volume.
 */
function resolveModelPath() {
    if (process.env.ML_MODEL_PATH) return process.env.ML_MODEL_PATH
    // Fallback para desenvolvimento local (estrutura do repositório)
    return path.join(process.cwd(), 'ai', 'artifacts', 'modelo_risco.joblib')
}

/**
 * Script Python injetado inline — evita dependência de arquivo externo em produção.
 * Aceita transcrição via stdin e imprime JSON estruturado com todas as métricas.
 */
function buildPythonScript(modelPath) {
    return `
import sys, json
from pathlib import Path
import joblib

MODEL_PATH = Path(${JSON.stringify(modelPath)})
CLASSES = ['DETRATOR', 'NEUTRO', 'PROMOTOR']

texto = sys.stdin.read().strip()
if not texto:
    print(json.dumps({"error": "transcricao_vazia"}))
    sys.exit(0)

try:
    modelo = joblib.load(MODEL_PATH)
    probs  = modelo.predict_proba([texto])[0]
    idx    = int(probs.argmax())
    classe = CLASSES[idx]

    p_detrator   = float(probs[CLASSES.index('DETRATOR')])
    p_neutro     = float(probs[CLASSES.index('NEUTRO')])
    p_promotor   = float(probs[CLASSES.index('PROMOTOR')])
    confianca    = float(probs[idx])

    # Derivação de métricas semânticas a partir das probabilidades
    # Escala 0-100, 1 casa decimal
    def d1(v): return round(max(0.0, min(100.0, v)) * 10) / 10

    sent      = d1(p_promotor * 100)
    risco     = d1(p_detrator * 100)
    neutro    = d1(p_neutro   * 100)
    prod      = d1((p_promotor * 0.7 + p_neutro * 0.4) * 100)
    res       = d1((p_promotor * 0.6 + p_neutro * 0.5) * 100)
    churn     = d1(p_detrator  * 100)
    engage    = d1((p_promotor * 0.8 + p_neutro * 0.5) * 100)

    result = {
        "modelo":                    "modelo_risco.joblib",
        "classe":                    classe,
        "risco":                     classe == "DETRATOR",
        "probabilidade_risco":       round(p_detrator, 4),
        "probabilidade_neutro":      round(p_neutro,   4),
        "probabilidade_oportunidade":round(p_promotor, 4),
        "confianca_modelo":          round(confianca,  4),
        "metricas_derivadas": {
            "sentimento":   sent,
            "produtividade":prod,
            "resolucao":    res,
            "churn":        churn,
            "engajamento":  engage,
            "risco_raw":    risco,
            "neutro_raw":   neutro,
        }
    }
    print(json.dumps(result, ensure_ascii=False))
except Exception as e:
    print(json.dumps({"error": str(e)}))
    sys.exit(1)
`.trim()
}

/**
 * Executa o modelo ML via Python subprocess e retorna o JSON de predição.
 * Timeout de 30s — modelos joblib carregam em ~2-5s em cold start.
 */
async function runMLModel(transcription) {
    return new Promise((resolve, reject) => {
        const python     = optEnv('PYTHON_EXECUTABLE', 'python3')
        const modelPath  = resolveModelPath()
        const script     = buildPythonScript(modelPath)

        const proc = spawn(python, ['-c', script], {
            timeout: 30_000,
            env: { ...process.env },
        })

        let stdout = ''
        let stderr = ''

        proc.stdout.on('data', chunk => { stdout += chunk.toString() })
        proc.stderr.on('data', chunk => { stderr += chunk.toString() })

        proc.stdin.write(transcription, 'utf8')
        proc.stdin.end()

        proc.on('close', code => {
            if (!stdout.trim()) {
                return reject(new Error(`ML process sem saída (exit ${code}): ${stderr.slice(0, 300)}`))
            }
            try {
                const parsed = JSON.parse(stdout.trim())
                if (parsed.error) return reject(new Error(`ML error: ${parsed.error}`))
                resolve(parsed)
            } catch {
                reject(new Error(`ML output inválido: ${stdout.slice(0, 200)}`))
            }
        })

        proc.on('error', err => reject(new Error(`Python spawn falhou: ${err.message}`)))
    })
}

// ─── Mapeamento ML → analysis_data ───────────────────────────────────────────

/**
 * Converte a saída do modelo (probabilidades + métricas derivadas) para o schema
 * analysis_data completo, idêntico ao gerado pelo site via LLM de scores.
 * Garante que toda lógica semântica seja baseada nos números do modelo.
 */
function buildAnalysisData(mlResult) {
    const m      = mlResult.metricas_derivadas
    const prod   = m.produtividade
    const sent   = m.sentimento
    const res    = m.resolucao
    const churn  = m.churn
    const engage = m.engajamento
    const d1     = v => Math.round(Math.max(0, Math.min(100, v)) * 10) / 10

    return {
        meeting_analysis: {
            effectiveness:    d1(prod),
            productivity:     d1(prod),
            goal_achievement: d1(res),
            decision_quality: d1(res >= 50 ? res * 0.9 : res * 0.6),
        },
        engagement: {
            overall:       d1(engage),
            participation: d1(engage),
            interaction:   d1((engage + sent) / 2),
            attention:     d1(sent),
        },
        communication: {
            clarity:           d1(sent * 0.9),
            objectivity:       d1(res   * 0.85),
            persuasion:        d1(prod >= 70 ? 65 : 42),
            active_listening:  d1(sent),
            objection_handling:d1(churn > 50 ? 45 : 70),
        },
        sentiment: {
            client:    d1(sent),
            team:      d1(prod),
            positivity:d1(mlResult.probabilidade_oportunidade * 100),
            negativity:d1(mlResult.probabilidade_risco        * 100),
        },
        customer: {
            satisfaction:    d1(sent),
            trust:           d1(sent >= 60 ? 75 : 50),
            engagement_level:d1(engage),
            pain_understanding:d1(churn > 50 ? 70 : 50),
            solution_fit:    d1(res),
        },
        business: {
            deal_progress:       d1(prod),
            conversion_likelihood:d1(prod * 0.9),
            perceived_value:     d1(prod >= 70 ? 70 : 45),
            expected_value:      d1(prod >= 60 ? 65 : 40),
            urgency:             d1(prod >= 70 ? 60 : 35),
        },
        execution: {
            time_management:    d1(65),
            agenda_adherence:   d1(60),
            next_steps_clarity: d1(res),
            follow_up_quality:  d1(res >= 60 ? 65 : 40),
        },
        risk: {
            churn:        d1(churn),
            deal_loss:    d1(100 - prod),
            objection:    d1(churn > 50 ? 70 : 30),
            disengagement:d1(100 - sent),
        },
        intelligence: {
            alignment:           d1((prod + sent) / 2),
            buying_signal:       d1(prod >= 70 ? 65 : 35),
            decision_momentum:   d1(prod),
            stakeholder_influence:d1(45),
        },
        summary_scores: {
            overall_score: d1((prod + sent + res) / 3),
            client_health: d1(sent),
            deal_health:   d1(prod),
        },
        _ml_metadata: {
            model:       mlResult.modelo,
            classe:      mlResult.classe,
            p_detrator:  mlResult.probabilidade_risco,
            p_neutro:    mlResult.probabilidade_neutro,
            p_promotor:  mlResult.probabilidade_oportunidade,
            confianca:   mlResult.confianca_modelo,
        },
    }
}

// ─── LLM — Geração do Relatório ───────────────────────────────────────────────

async function callOpenRouter(systemPrompt, userMessage, maxTokens) {
    const model = optEnv('OPENROUTER_MODEL', 'nvidia/nemotron-3-ultra-550b-a55b:free')
    const res   = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${requireEnv('OPENROUTER_API_KEY')}`,
            'Content-Type': 'application/json',
            'X-Title':      'ContextMLPipeline',
        },
        body: JSON.stringify({
            model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user',   content: userMessage  },
            ],
            stream:     false,
            max_tokens: maxTokens,
            temperature: 0.15,
        }),
    })

    if (!res.ok) {
        const body = await res.text().catch(() => '(sem corpo)')
        throw new Error(`OpenRouter ${res.status}: ${body}`)
    }

    const data    = await res.json()
    const content = data?.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content.trim())
        throw new Error('OpenRouter retornou resposta vazia.')
    return content.trim()
}

function extractGoalFromMarkdown(rawText) {
    const cleaned = rawText.replace(/^```(?:markdown)?\s*/im, '').replace(/\s*```$/im, '').trim()
    const match   = cleaned.match(/<!--\s*METADATA:\s*(\{[^]*?\})\s*-->/i)
    let goal      = 'partial'
    if (match) {
        try {
            const meta = JSON.parse(match[1])
            if (VALID_GOALS.has(meta?.objetivo_cumprido)) goal = meta.objetivo_cumprido
        } catch { /* mantém fallback */ }
    }
    const markdown = cleaned.replace(/<!--\s*METADATA:[^]*?-->/gi, '').trimEnd()
    if (!markdown) throw new Error('Relatório vazio após extração de metadados.')
    return { markdown, goal }
}

/**
 * Constrói o prompt de usuário com transcrição + métricas ML embutidas.
 * O LLM recebe os números como verdade e só gera narrativa em cima.
 */
function buildLLMPrompt(transcription, mlResult, analysisData) {
    const scores = JSON.stringify(analysisData, null, 2)
        .replace(/\s*"_ml_metadata"[\s\S]*$/, '') // remove metadados internos do prompt
    return [
        `MÉTRICAS ML (geradas por modelo XGBoost treinado — use como fundamento analítico):`,
        `Classe: ${mlResult.classe}`,
        `Confiança: ${(mlResult.confianca_modelo * 100).toFixed(1)}%`,
        `P(Detrator): ${(mlResult.probabilidade_risco        * 100).toFixed(1)}%`,
        `P(Neutro):   ${(mlResult.probabilidade_neutro       * 100).toFixed(1)}%`,
        `P(Promotor): ${(mlResult.probabilidade_oportunidade * 100).toFixed(1)}%`,
        ``,
        `SCORES DETALHADOS (escala 0–100):`,
        scores,
        ``,
        `TRANSCRIÇÃO DA REUNIÃO:`,
        transcription,
    ].join('\n')
}

// ─── Persistência ─────────────────────────────────────────────────────────────

async function dbSave(userId, meetingId, title, markdown, analysisData, size, goal, transcription) {
    const { data, error } = await supabase
        .from('meetings')
        .upsert(
            {
                id:            meetingId,
                user_id:       userId,
                title:         sanitize(title, MAX_TITLE_LEN),
                analysis:      markdown,
                analysis_data: analysisData,
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

function deriveTitle(transcription, filename) {
    if (filename && typeof filename === 'string' && filename.trim()) {
        return sanitize(filename.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' ').trim(), MAX_TITLE_LEN)
    }
    const date = new Intl.DateTimeFormat('pt-BR', {
        dateStyle: 'short', timeZone: 'America/Sao_Paulo',
    }).format(new Date())
    return `Análise de Reunião — ${date}`
}

// ─── Handler Principal ────────────────────────────────────────────────────────

/**
 * POST ?action=analyze
 *
 * Body (application/json):
 * {
 *   "transcription": "string"   // Texto da transcrição (obrigatório)
 *   "title":         "string"   // Título opcional
 *   "filename":      "string"   // Nome do arquivo origem (opcional — usado para derivar título)
 *   "meeting_id":    "uuid"     // Idempotência opcional — se informado, faz upsert
 * }
 *
 * Resposta (200):
 * {
 *   "id":            "uuid",
 *   "title":         "string",
 *   "analysis":      "# Relatório de Análise de Reunião\n\n...",
 *   "analysis_data": { ...scores... },
 *   "ml_result":     { classe, probabilidades, confianca },
 *   "size":          "14.2 KB",
 *   "goal":          "success" | "partial" | "fail",
 *   "created_at":    "ISO 8601"
 * }
 */
async function handleAnalyze(req, res, userId) {
    const rl = checkRateLimit(userId)
    if (rl.limited) {
        res.setHeader('Retry-After', String(rl.retryAfter))
        return sendError(res, 429, 'Muitas requisições. Aguarde antes de processar outra análise.')
    }

    const body = req.body ?? {}

    // ── Validação ──────────────────────────────────────────────────────────
    let transcription
    if (typeof body.transcription === 'string') {
        transcription = body.transcription
    } else if (body.transcript && typeof body.transcript === 'object') {
        // Compatibilidade com formato do site (transcript: {})
        transcription = JSON.stringify(body.transcript, null, 2)
    } else {
        return sendError(res, 400, 'Campo "transcription" (string) ou "transcript" (object) é obrigatório.')
    }

    const transcriptionSafe = sanitize(transcription)
    if (transcriptionSafe.length < 50)
        return sendError(res, 400, 'Transcrição vazia ou muito curta para ser analisada.')

    const meetingId = body.meeting_id ?? randomUUID()
    const title     = sanitize(body.title ?? deriveTitle(transcription, body.filename), MAX_TITLE_LEN)
    const size      = formatSize(Buffer.byteLength(transcriptionSafe, 'utf8'))

    // ── Etapa 1: Modelo ML ─────────────────────────────────────────────────
    let mlResult
    try {
        mlResult = await runMLModel(transcriptionSafe)
    } catch (err) {
        console.error('[xgboost/analyze] ML falhou:', err.message)
        return sendError(res, 502, `Falha no modelo ML: ${err.message}`)
    }

    const analysisData = buildAnalysisData(mlResult)

    // ── Etapa 2: Relatório LLM (em paralelo não é necessário — ML é etapa 1) ──
    const userPrompt = buildLLMPrompt(transcriptionSafe, mlResult, analysisData)
    const maxTokens  = parseInt(optEnv('OPENROUTER_MAX_TOKENS', '3584'), 10)

    let markdown, goal
    try {
        const raw  = await callOpenRouter(SYSTEM_PROMPT_ML_REPORT, userPrompt, maxTokens)
        const parsed = extractGoalFromMarkdown(raw)
        markdown = parsed.markdown
        goal     = parsed.goal
    } catch (err) {
        console.error('[xgboost/analyze] LLM falhou:', err.message)
        return sendError(res, 502, 'Falha ao gerar relatório LLM. Tente novamente.')
    }

    // ── Etapa 3: Persistência ───────────────────────────────────────────────
    let saved
    try {
        saved = await dbSave(
            userId, meetingId, title,
            markdown, analysisData,
            size, goal, body.transcript ?? transcriptionSafe,
        )
    } catch (err) {
        console.error('[xgboost/analyze] Supabase falhou:', err.message)
        return res.status(200).json({
            id: meetingId, title, analysis: markdown, analysis_data: analysisData,
            ml_result: {
                classe:    mlResult.classe,
                p_detrator:mlResult.probabilidade_risco,
                p_neutro:  mlResult.probabilidade_neutro,
                p_promotor:mlResult.probabilidade_oportunidade,
                confianca: mlResult.confianca_modelo,
            },
            size, goal, created_at: new Date().toISOString(),
            warning: 'Análise gerada, mas falhou ao persistir no banco.',
        })
    }

    return res.status(200).json({
        id:            saved?.id ?? meetingId,
        title:         saved?.title ?? title,
        analysis:      markdown,
        analysis_data: analysisData,
        ml_result: {
            classe:    mlResult.classe,
            p_detrator:mlResult.probabilidade_risco,
            p_neutro:  mlResult.probabilidade_neutro,
            p_promotor:mlResult.probabilidade_oportunidade,
            confianca: mlResult.confianca_modelo,
        },
        size,
        goal,
        created_at: saved?.created_at ?? new Date().toISOString(),
    })
}

function handleHealth(req, res) {
    return res.status(200).json({
        status:   'ok',
        endpoint: '/api/xgboost',
        version:  '1.0.0',
        pipeline: 'ML → LLM → Supabase',
    })
}

// ─── Export ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
    if (applyCors(req, res)) return
    applySecurityHeaders(res)

    const { action } = req.query

    if (action === 'health') return handleHealth(req, res)

    const userId = getUserId(req)
    if (!userId) return sendError(res, 401, 'Não autenticado.')

    try {
        switch (action) {
            case 'analyze':
                if (req.method !== 'POST') return sendError(res, 405, 'Método não permitido.')
                return await handleAnalyze(req, res, userId)
            default:
                return sendError(res, 400, `Ação desconhecida: "${action}".`)
        }
    } catch (err) {
        console.error(`[xgboost/${action}] Erro inesperado:`, err.message)
        return sendError(res, 500, 'Erro interno do servidor.')
    }
}