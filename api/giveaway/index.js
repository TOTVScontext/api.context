/**
 * /api/giveaway/index.js
 * =======================
 * Giveaway — Vercel Serverless Function (Node.js, ESM)
 *
 * Rotas  →  ?action=<ação>
 * ─────────────────────────────────────────────────────────────────────────────
 *  POST  ?action=submit   Registra uma entrada no giveaway
 *
 * Tabela Supabase: `giveaway`
 *  id         uuid / identity (PK)
 *  name       text         — nome completo do participante
 *  email      text         — e-mail único do participante
 *  age        integer      — idade do participante
 *  gender     text         — gênero do participante
 *  size       text         — tamanho (ex.: P, M, G, GG)
 *  created_at timestamptz  — preenchido automaticamente pelo Supabase
 *
 * Variáveis de Ambiente (Vercel → Settings → Environment Variables)
 * ─────────────────────────────────────────────────────────────────
 *  SUPABASE_URL              URL do projeto Supabase (obrigatória)
 *  SUPABASE_SERVICE_ROLE_KEY Chave service role do Supabase (obrigatória)
 */

import { supabase } from '../_lib/supabase.js'
import { applyCors } from '../_cors.js'

// ─── Constantes ───────────────────────────────────────────────────────────────

const TABLE = 'giveaway'

const ALLOWED_GENDERS = ['male', 'female', 'non-binary', 'prefer not to say']
const ALLOWED_SIZES = ['PP', 'P', 'M', 'G', 'GG', 'XGG']

const AGE_MIN = 1
const AGE_MAX = 120

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

// ─── Validação ────────────────────────────────────────────────────────────────

function validate(body) {
    const { name, email, age, gender, size } = body

    if (!name || typeof name !== 'string' || name.trim().length < 2)
        return 'Campo Nome é obrigatório e deve ter ao menos 2 caracteres.'

    if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        return 'Campo E-mail inválido.'

    const parsedAge = Number(age)
    if (!age && age !== 0 || !Number.isInteger(parsedAge) || parsedAge < AGE_MIN || parsedAge > AGE_MAX)
        return `Campo Idade deve ser um número inteiro entre ${AGE_MIN} e ${AGE_MAX}.`

    if (!gender || !ALLOWED_GENDERS.includes(gender))
        return `Campo Gênero inválido. Valores aceitos: ${ALLOWED_GENDERS.join(', ')}.`

    if (!size || !ALLOWED_SIZES.includes(size))
        return `Campo Tamanho inválido. Valores aceitos: ${ALLOWED_SIZES.join(', ')}.`

    return null
}

// ─── Banco de Dados ───────────────────────────────────────────────────────────

async function dbCheckDuplicate(email) {
    const { data, error } = await supabase
        .from(TABLE)
        .select('id')
        .eq('email', email.trim().toLowerCase())
        .maybeSingle()

    if (error) throw new Error(`Supabase duplicate check: ${error.message}`)
    return !!data
}

async function dbInsertEntry({ name, email, age, gender, size }) {
    const { data, error } = await supabase
        .from(TABLE)
        .insert({
            name: name.trim(),
            email: email.trim().toLowerCase(),
            age: Number(age),
            gender,
            size,
        })
        .select('id, created_at')
        .single()

    if (error) throw new Error(`Supabase insert: ${error.message}`)
    return data
}

// ─── Handler ──────────────────────────────────────────────────────────────────

/** POST ?action=submit */
async function handleSubmit(req, res) {
    if (req.method !== 'POST') return sendError(res, 405, 'Método não permitido.')

    const validationError = validate(req.body ?? {})
    if (validationError) return sendError(res, 422, validationError)

    const { email } = req.body
    const isDuplicate = await dbCheckDuplicate(email)
    if (isDuplicate) return sendError(res, 409, 'Este e-mail já está registrado no sorteio.')

    const entry = await dbInsertEntry(req.body)

    return res.status(201).json({
        message: 'Inscrição realizada com sucesso.',
        id: entry.id,
        created_at: entry.created_at,
    })
}

// ─── Handler Principal ────────────────────────────────────────────────────────

export default async function handler(req, res) {
    if (applyCors(req, res)) return

    applySecurityHeaders(res)

    const { action } = req.query

    try {
        switch (action) {
            case 'submit':
                return await handleSubmit(req, res)

            default:
                return sendError(res, 400, `Ação desconhecida: "${action}".`)
        }
    } catch (err) {
        console.error(`[giveaway/${action}] Erro inesperado:`, err.message)
        return sendError(res, 500, 'Erro interno do servidor.')
    }
}