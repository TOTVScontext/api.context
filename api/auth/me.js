import { supabase } from '../_lib/supabase.js'
import { getUserId } from '../_lib/auth.js'
import { applyCors } from '../_cors.js'

// ---------------------------------------------------------------------------
// Fields safe to expose to the client
// ---------------------------------------------------------------------------
const PUBLIC_FIELDS = [
  'id',
  'email',
  'settings',
  'profile',
  'created_at',
].join(', ')

// ---------------------------------------------------------------------------
// Security headers
// ---------------------------------------------------------------------------
function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  res.setHeader('Cache-Control', 'no-store')
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  if (applyCors(req, res)) return

  applySecurityHeaders(res)

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  // ── Auth ──────────────────────────────────────────────────────────────────
  const userId = getUserId(req)
  if (!userId) {
    return res.status(401).json({ error: 'Not authenticated' })
  }

  // ── Fetch — row is scoped to the authenticated user's id ──────────────────
  const { data, error } = await supabase
    .from('users')
    .select(PUBLIC_FIELDS)
    .eq('id', userId)
    .maybeSingle()             // returns null instead of throwing on no rows

  if (error) {
    console.error('[/api/me] Supabase error:', error.message)
    return res.status(500).json({ error: 'Failed to fetch user.' })
  }

  if (!data) {
    return res.status(404).json({ error: 'User not found.' })
  }

  return res.status(200).json(data)
}