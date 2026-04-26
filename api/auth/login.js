import jwt from 'jsonwebtoken'
import { supabase } from '../_lib/supabase.js'
import { applyCors } from '../_cors.js'

// ---------------------------------------------------------------------------
// In-memory rate limiter (swap store for Redis/Upstash in production)
// ---------------------------------------------------------------------------
const loginAttempts = new Map() // key: IP → { count, firstAttempt, lockedUntil }

const RATE_LIMIT = {
  MAX_ATTEMPTS: 5,       // max failures before lockout
  WINDOW_MS: 15 * 60 * 1000,   // 15-minute sliding window
  LOCKOUT_MS: 30 * 60 * 1000,  // 30-minute lockout
}

function getClientIp(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0].trim() ||
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    'unknown'
  )
}

function checkRateLimit(ip) {
  const now = Date.now()
  const record = loginAttempts.get(ip)

  if (!record) return { allowed: true }

  // Locked out?
  if (record.lockedUntil && now < record.lockedUntil) {
    const retryAfter = Math.ceil((record.lockedUntil - now) / 1000)
    return { allowed: false, retryAfter }
  }

  // Window expired — reset
  if (now - record.firstAttempt > RATE_LIMIT.WINDOW_MS) {
    loginAttempts.delete(ip)
    return { allowed: true }
  }

  if (record.count >= RATE_LIMIT.MAX_ATTEMPTS) {
    record.lockedUntil = now + RATE_LIMIT.LOCKOUT_MS
    loginAttempts.set(ip, record)
    return { allowed: false, retryAfter: Math.ceil(RATE_LIMIT.LOCKOUT_MS / 1000) }
  }

  return { allowed: true }
}

function recordFailedAttempt(ip) {
  const now = Date.now()
  const record = loginAttempts.get(ip) || { count: 0, firstAttempt: now }
  record.count += 1
  loginAttempts.set(ip, record)
}

function clearAttempts(ip) {
  loginAttempts.delete(ip)
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function validateBody(body) {
  const { email, password } = body ?? {}

  if (!email || typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
    return 'Invalid email address.'
  }
  if (!password || typeof password !== 'string' || password.length < 8) {
    return 'Password must be at least 8 characters.'
  }
  return null
}

// ---------------------------------------------------------------------------
// Security headers
// ---------------------------------------------------------------------------
function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  if (applyCors(req, res)) return

  applySecurityHeaders(res)

  if (req.method !== 'POST') return res.status(405).end()

  // ── Rate limiting ─────────────────────────────────────────────────────────
  const ip = getClientIp(req)
  const { allowed, retryAfter } = checkRateLimit(ip)

  if (!allowed) {
    res.setHeader('Retry-After', retryAfter)
    return res.status(429).json({ error: 'Too many login attempts. Try again later.' })
  }

  // ── Input validation ──────────────────────────────────────────────────────
  const validationError = validateBody(req.body)
  if (validationError) {
    return res.status(400).json({ error: validationError })
  }

  const email = req.body.email.trim().toLowerCase()
  const { password } = req.body

  // ── Authenticate ──────────────────────────────────────────────────────────
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })

  if (error || !data?.user) {
    recordFailedAttempt(ip)
    // Generic message — never reveal whether email exists
    return res.status(401).json({ error: 'Invalid credentials.' })
  }

  clearAttempts(ip)

  // ── Issue JWT ─────────────────────────────────────────────────────────────
  const token = jwt.sign(
    { sub: data.user.id },
    process.env.JWT_SECRET,
    { expiresIn: '7d', algorithm: 'HS256' }
  )

  res.setHeader(
    'Set-Cookie',
    `session=${token}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=604800`
  )

  return res.status(200).json({ success: true })
}