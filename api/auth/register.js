import { supabase } from '../_lib/supabase.js'
import { applyCors } from '../_cors.js'

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

  // ── Input validation ──────────────────────────────────────────────────────
  const validationError = validateBody(req.body)
  if (validationError) {
    return res.status(400).json({ error: validationError })
  }

  const email = req.body.email.trim().toLowerCase()
  const { password } = req.body

  // ── Check existing account ────────────────────────────────────────────────
  const { data: existing } = await supabase
    .from('users')
    .select('id')
    .eq('email', email)
    .maybeSingle()

  if (existing) {
    return res.status(409).json({ error: 'An account with this email already exists.' })
  }

  // ── Register ──────────────────────────────────────────────────────────────
  const { data, error } = await supabase.auth.signUp({ email, password })

  if (error) {
    return res.status(400).json({ error: error.message })
  }

  // ── Create user record ────────────────────────────────────────────────────
  const { error: insertError } = await supabase.from('users').insert({
    id: data.user.id,
    email,
    profile: {
      name: '',
      photo: '',
      gender: '',
      country: '',
      birthDate: '',
    },
  })

  if (insertError) {
    // Auth user created but profile failed — clean up to avoid orphaned auth records
    await supabase.auth.admin.deleteUser(data.user.id)
    return res.status(500).json({ error: 'Failed to create account. Please try again.' })
  }

  return res.status(201).json({ success: true })
}