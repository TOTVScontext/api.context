/**
 * /api/cli/index.js
 * ==================
 * Backend do Context CLI — UMA única Vercel Function (Node.js, ESM) que atende
 * todas as rotas /api/cli/* via rewrite (vercel.json). Mantém o projeto dentro
 * do limite de 12 funções do plano Hobby.
 *
 * Autenticação (OAuth 2.0 Authorization Code + PKCE S256, sem segredo no CLI)
 *   GET   /api/cli/auth/authorize   Página de login/consentimento no navegador
 *   POST  /api/cli/auth/authorize   Valida credenciais e redireciona ao localhost com o code
 *   POST  /api/cli/auth/token       grant_type=authorization_code | refresh_token
 *   POST  /api/cli/auth/logout      Revoga a sessão remota
 *
 * Dados (Authorization: Bearer <access_token>)
 *   GET     /api/cli/me
 *   GET     /api/cli/analyses?limit=&titulo=&idExcluir=&full=1
 *   POST    /api/cli/analyses
 *   GET     /api/cli/analyses/:id
 *   PUT     /api/cli/analyses/:id        { "titulo": "novo_titulo" }
 *   DELETE  /api/cli/analyses/:id
 *   GET     /api/cli/dashboard           Último snapshot de desempenho geral
 *   GET     /api/cli/health
 *
 * Variáveis de ambiente (as mesmas do restante da API)
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY, JWT_SECRET
 *   Opcionais: CLI_CLIENT_ID, CLI_REDIRECT_URIS (lista separada por vírgula), CLI_JWT_SECRET
 */

import { applyCors } from '../_cors.js'
import { getUserId } from '../_lib/auth.js'
import { ALLOWED_REDIRECT_URIS, CLIENT_ID, CODE_TTL_S, FORM_TTL_S, LIMITS, ACCESS_TTL_S } from '../_lib/cli/config.js'
import {
    applySecurityHeaders, bearerToken, clientIp, createLimiter, isUuid, pathSegments, readBody, sendError,
} from '../_lib/cli/http.js'
import {
    formatRefreshToken, hashSecret, isValidCodeChallenge, issueAccessToken, markCodeUsed, newRefreshSecret,
    parseRefreshToken, safeEqual, signToken, verifyPkce, verifyToken,
} from '../_lib/cli/security.js'
import { authenticate, createSession, getSession, isSessionActive, revokeSession, rotateSession } from '../_lib/cli/sessions.js'
import { getUserProfile, verifyPassword } from '../_lib/cli/identity.js'
import { renderAuthorizePage, renderErrorPage } from '../_lib/cli/authorize-page.js'
import {
    deleteMeeting, getLatestDashboard, getMeeting, insertMeeting, listMeetings, parseCreateBody, renameMeeting,
    titleExists, toCliRecord, validateTitle,
} from '../_lib/cli/meetings.js'

const loginFailures = createLimiter({ max: LIMITS.loginFailures, windowMs: LIMITS.loginWindowMs })
const tokenCalls = createLimiter({ max: LIMITS.tokenPerMinute, windowMs: 60_000 })
const writeCalls = createLimiter({ max: LIMITS.writesPerMinute, windowMs: 60_000 })

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const STATE_RE = /^[A-Za-z0-9\-._~]{8,256}$/

// ─── Utilidades de resposta ───────────────────────────────────────────────────

function methodNotAllowed(res, allowed) {
    res.setHeader('Allow', allowed.join(', '))
    return sendError(res, 405, 'Método não permitido.')
}

function unauthorized(res) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="context-cli"')
    return sendError(res, 401, 'Não autenticado.', 'unauthenticated')
}

function oauthError(res, status, error, description) {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Pragma', 'no-cache')
    return res.status(status).json({ error, error_description: description })
}

function tooMany(res, retryAfter, message = 'Muitas requisições. Tente novamente em instantes.') {
    res.setHeader('Retry-After', String(retryAfter))
    return sendError(res, 429, message, 'rate_limited')
}

function sendHtml(res, status, html, extraHeaders = {}) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    for (const [key, value] of Object.entries(extraHeaders)) res.setHeader(key, value)
    return res.status(status).send(html)
}

function redirect(res, location) {
    res.setHeader('Location', location)
    return res.status(302).end()
}

// ─── Autorização (navegador) ──────────────────────────────────────────────────

function validateAuthorizeParams(query) {
    const { client_id, redirect_uri, response_type, state, code_challenge, code_challenge_method } = query

    if (client_id !== CLIENT_ID) return { error: 'Cliente não autorizado.' }
    if (!ALLOWED_REDIRECT_URIS.has(redirect_uri)) return { error: 'redirect_uri não permitido.' }
    if (response_type !== 'code') return { error: 'response_type deve ser "code".' }
    if (code_challenge_method !== 'S256') return { error: 'code_challenge_method deve ser "S256".' }
    if (!isValidCodeChallenge(code_challenge)) return { error: 'code_challenge inválido.' }
    if (typeof state !== 'string' || !STATE_RE.test(state)) return { error: 'state inválido.' }

    return { params: { cid: client_id, ru: redirect_uri, cc: code_challenge, state } }
}

/** CSP restrita: o único destino de formulário além da própria origem é o callback local permitido */
function authorizeCsp() {
    const origins = [...new Set([...ALLOWED_REDIRECT_URIS].map(uri => new URL(uri).origin))]
    return [
        "default-src 'none'",
        "style-src 'unsafe-inline'",
        `form-action 'self' ${origins.join(' ')}`,
        "frame-ancestors 'none'",
        "base-uri 'none'",
    ].join('; ')
}

async function renderForm(res, status, params, { sessionUser, error } = {}) {
    const formToken = signToken('cli_authz', params, FORM_TTL_S)
    return sendHtml(res, status, renderAuthorizePage({ formToken, sessionUser, error }), {
        'Content-Security-Policy': authorizeCsp(),
    })
}

async function sessionUserFromCookie(req) {
    const userId = getUserId(req)
    return userId ? getUserProfile(userId) : null
}

async function handleAuthorizeGet(req, res) {
    const { error, params } = validateAuthorizeParams(req.query)
    if (error) return sendHtml(res, 400, renderErrorPage(error), { 'Content-Security-Policy': authorizeCsp() })

    return renderForm(res, 200, params, { sessionUser: await sessionUserFromCookie(req) })
}

async function handleAuthorizePost(req, res) {
    if (req.headers['sec-fetch-site'] === 'cross-site') {
        return sendHtml(res, 403, renderErrorPage('Requisição não permitida.'), { 'Content-Security-Policy': authorizeCsp() })
    }

    const body = readBody(req)
    const claims = verifyToken(body.form_token, 'cli_authz')
    if (!claims) {
        return sendHtml(res, 400, renderErrorPage('A solicitação expirou. Volte ao terminal e execute o login novamente.'), {
            'Content-Security-Policy': authorizeCsp(),
        })
    }

    const params = { cid: claims.cid, ru: claims.ru, cc: claims.cc, state: claims.state }
    const target = new URL(params.ru)
    target.searchParams.set('state', params.state)

    if (body.mode === 'deny') {
        target.searchParams.set('error', 'access_denied')
        return redirect(res, target.toString())
    }

    const ip = clientIp(req)
    const blocked = loginFailures.isLimited(ip)
    if (blocked.limited) {
        res.setHeader('Retry-After', String(blocked.retryAfter))
        return renderForm(res, 429, params, { error: 'Muitas tentativas. Tente novamente mais tarde.' })
    }

    let userId = null

    if (body.mode === 'session') {
        userId = getUserId(req)
        if (!userId) return renderForm(res, 401, params, { error: 'Sua sessão expirou. Entre com e-mail e senha.' })
    } else {
        const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
        const password = typeof body.password === 'string' ? body.password : ''

        if (!EMAIL_RE.test(email) || !password || password.length > 200) {
            return renderForm(res, 400, params, { error: 'Informe um e-mail e uma senha válidos.' })
        }

        userId = await verifyPassword(email, password)
        if (!userId) {
            loginFailures.consume(ip)
            return renderForm(res, 401, params, { error: 'Credenciais inválidas.' })
        }
        loginFailures.reset(ip)
    }

    const code = signToken('cli_code', { sub: userId, cc: params.cc, ru: params.ru, cid: params.cid }, CODE_TTL_S)
    target.searchParams.set('code', code)
    return redirect(res, target.toString())
}

// ─── Token endpoint ───────────────────────────────────────────────────────────

function tokenResponse(res, userId, sessionId, refreshToken) {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Pragma', 'no-cache')
    return res.status(200).json({
        access_token: issueAccessToken(userId, sessionId),
        refresh_token: refreshToken,
        token_type: 'Bearer',
        expires_in: ACCESS_TTL_S,
    })
}

async function exchangeAuthorizationCode(req, res, body) {
    const claims = verifyToken(body.code, 'cli_code')
    if (!claims) return oauthError(res, 400, 'invalid_grant', 'Código inválido ou expirado.')
    if (claims.cid !== body.client_id || claims.ru !== body.redirect_uri) {
        return oauthError(res, 400, 'invalid_grant', 'Código não corresponde à solicitação.')
    }
    if (!verifyPkce(body.code_verifier, claims.cc)) {
        return oauthError(res, 400, 'invalid_grant', 'Falha na verificação PKCE.')
    }
    if (!markCodeUsed(claims.jti, claims.exp)) {
        return oauthError(res, 400, 'invalid_grant', 'Código já utilizado.')
    }

    const secret = newRefreshSecret()
    const sessionId = await createSession(claims.sub, hashSecret(secret), req.headers['user-agent'])
    return tokenResponse(res, claims.sub, sessionId, formatRefreshToken(sessionId, secret))
}

async function refreshSession(res, body) {
    const parsed = parseRefreshToken(body.refresh_token)
    if (!parsed || !isUuid(parsed.sessionId)) return oauthError(res, 400, 'invalid_grant', 'Refresh token inválido.')

    const session = await getSession(parsed.sessionId)
    if (!isSessionActive(session)) return oauthError(res, 400, 'invalid_grant', 'Sessão expirada ou revogada.')

    if (!safeEqual(hashSecret(parsed.secret), session.refresh_hash)) {
        // Token já rotacionado sendo reapresentado: trata como vazamento e encerra a sessão
        await revokeSession(session.id)
        return oauthError(res, 400, 'invalid_grant', 'Refresh token reutilizado. Faça login novamente.')
    }

    const secret = newRefreshSecret()
    if (!(await rotateSession(session, hashSecret(secret)))) {
        return oauthError(res, 400, 'invalid_grant', 'Sessão alterada por outra requisição. Tente novamente.')
    }
    return tokenResponse(res, session.user_id, session.id, formatRefreshToken(session.id, secret))
}

async function handleToken(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(res, ['POST'])

    const limited = tokenCalls.consume(clientIp(req))
    if (limited.limited) return tooMany(res, limited.retryAfter)

    const body = readBody(req)
    if (body.client_id !== CLIENT_ID) return oauthError(res, 401, 'invalid_client', 'Cliente desconhecido.')

    switch (body.grant_type) {
        case 'authorization_code': return exchangeAuthorizationCode(req, res, body)
        case 'refresh_token': return refreshSession(res, body)
        default: return oauthError(res, 400, 'unsupported_grant_type', 'grant_type não suportado.')
    }
}

async function handleLogout(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(res, ['POST'])

    let sessionId = null

    const access = verifyToken(bearerToken(req), 'cli_access')
    if (access?.sid) {
        sessionId = access.sid
    } else {
        const parsed = parseRefreshToken(readBody(req).refresh_token)
        const session = parsed && isUuid(parsed.sessionId) ? await getSession(parsed.sessionId) : null
        if (session && safeEqual(hashSecret(parsed.secret), session.refresh_hash)) sessionId = session.id
    }

    if (!sessionId) return unauthorized(res)

    await revokeSession(sessionId)
    return res.status(204).end()
}

// ─── Dados (Bearer) ───────────────────────────────────────────────────────────

async function handleMe(res, auth) {
    const profile = await getUserProfile(auth.userId)
    if (!profile) return sendError(res, 404, 'Usuário não encontrado.')
    return res.status(200).json(profile)
}

async function handleDashboard(res, auth) {
    return res.status(200).json({ dashboard: await getLatestDashboard(auth.userId) })
}

async function handleAnalysesCollection(req, res, auth) {
    if (req.method === 'GET') {
        const { titulo, idExcluir } = req.query

        // Contrato do CLI: com "idExcluir" presente (mesmo vazio) a resposta é um booleano em texto puro
        if (idExcluir !== undefined) {
            const title = validateTitle(titulo)
            const exists = title ? await titleExists(auth.userId, title, isUuid(idExcluir) ? idExcluir : null) : false
            res.setHeader('Content-Type', 'text/plain; charset=utf-8')
            return res.status(200).send(String(exists))
        }

        const requested = parseInt(req.query.limit ?? '', 10)
        const limit = Math.min(LIMITS.listMax, Math.max(1, Number.isFinite(requested) ? requested : LIMITS.listDefault))
        const full = req.query.full === '1' || Boolean(titulo)

        const { rows, total } = await listMeetings(auth.userId, { limit, titulo: validateTitle(titulo), full })
        res.setHeader('X-Total-Count', String(total))
        return res.status(200).json(rows.map(row => toCliRecord(row, { full })))
    }

    if (req.method === 'POST') {
        const limited = writeCalls.consume(auth.userId)
        if (limited.limited) return tooMany(res, limited.retryAfter)

        const { error, value } = parseCreateBody(readBody(req))
        if (error) return sendError(res, 400, error, 'invalid_request')

        if (await titleExists(auth.userId, value.title)) {
            return sendError(res, 409, `Já existe uma análise com o título "${value.title}".`, 'title_taken')
        }

        const result = await insertMeeting(auth.userId, value)
        if (result.conflict) return sendError(res, 409, `Já existe uma análise com o título "${value.title}".`, 'title_taken')

        return res.status(201).json({ success: true, message: 'Registro salvo com sucesso', ...toCliRecord(result.row, { full: true }) })
    }

    return methodNotAllowed(res, ['GET', 'POST'])
}

async function handleAnalysisItem(req, res, auth, id) {
    if (!isUuid(id)) return sendError(res, 404, 'Análise não encontrada.', 'not_found')

    if (req.method === 'GET') {
        const row = await getMeeting(auth.userId, id)
        return row ? res.status(200).json(toCliRecord(row, { full: true })) : sendError(res, 404, 'Análise não encontrada.', 'not_found')
    }

    if (req.method === 'PUT' || req.method === 'PATCH') {
        const limited = writeCalls.consume(auth.userId)
        if (limited.limited) return tooMany(res, limited.retryAfter)

        const title = validateTitle(readBody(req).titulo)
        if (!title) return sendError(res, 400, 'O campo "titulo" é obrigatório.', 'invalid_request')

        if (await titleExists(auth.userId, title, id)) {
            return sendError(res, 409, `Já existe uma análise com o título "${title}".`, 'title_taken')
        }

        const result = await renameMeeting(auth.userId, id, title)
        if (result.conflict) return sendError(res, 409, `Já existe uma análise com o título "${title}".`, 'title_taken')
        if (!result.row) return sendError(res, 404, 'Análise não encontrada.', 'not_found')

        return res.status(200).json({ success: true, message: 'Título atualizado com sucesso', ...toCliRecord(result.row, { full: true }) })
    }

    if (req.method === 'DELETE') {
        const limited = writeCalls.consume(auth.userId)
        if (limited.limited) return tooMany(res, limited.retryAfter)

        return (await deleteMeeting(auth.userId, id))
            ? res.status(200).json({ success: true, message: 'Análise excluída com sucesso' })
            : sendError(res, 404, 'Análise não encontrada.', 'not_found')
    }

    return methodNotAllowed(res, ['GET', 'PUT', 'PATCH', 'DELETE'])
}

// ─── Roteador ─────────────────────────────────────────────────────────────────

async function route(req, res) {
    const [head, second, ...rest] = pathSegments(req)

    if (head === 'health' && !second) {
        return req.method === 'GET' ? res.status(200).json({ status: 'ok' }) : methodNotAllowed(res, ['GET'])
    }

    if (head === 'auth' && !rest.length) {
        if (second === 'authorize') {
            if (req.method === 'GET') return handleAuthorizeGet(req, res)
            if (req.method === 'POST') return handleAuthorizePost(req, res)
            return methodNotAllowed(res, ['GET', 'POST'])
        }
        if (second === 'token') return handleToken(req, res)
        if (second === 'logout') return handleLogout(req, res)
        return sendError(res, 404, 'Rota não encontrada.', 'not_found')
    }

    const isDataRoute =
        (head === 'me' && !second) ||
        (head === 'dashboard' && !second) ||
        (head === 'analyses' && !rest.length)

    if (!isDataRoute) return sendError(res, 404, 'Rota não encontrada.', 'not_found')

    const auth = await authenticate(req)
    if (!auth) return unauthorized(res)

    if (head === 'me') return req.method === 'GET' ? handleMe(res, auth) : methodNotAllowed(res, ['GET'])
    if (head === 'dashboard') return req.method === 'GET' ? handleDashboard(res, auth) : methodNotAllowed(res, ['GET'])
    return second ? handleAnalysisItem(req, res, auth, second) : handleAnalysesCollection(req, res, auth)
}

export default async function handler(req, res) {
    if (applyCors(req, res)) return

    applySecurityHeaders(res)

    try {
        return await route(req, res)
    } catch (err) {
        console.error(`[cli/${pathSegments(req).join('/')}] Erro inesperado:`, err.message)
        return sendError(res, 500, 'Erro interno do servidor.')
    }
}
