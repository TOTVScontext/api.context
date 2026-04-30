const allowedOrigins = [
  'http://localhost:5173',
  'https://totvs-context.vercel.app'
]

export function applyCors(req, res) {
  const origin = req.headers.origin

  // ─────────────────────────────────────────────
  // Origin dinâmico (necessário para credentials)
  // ─────────────────────────────────────────────
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
  }

  // Evita cache incorreto entre origins diferentes
  res.setHeader('Vary', 'Origin')

  // ─────────────────────────────────────────────
  // Métodos permitidos
  // ─────────────────────────────────────────────
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET,POST,PATCH,DELETE,OPTIONS'
  )

  // ─────────────────────────────────────────────
  // Headers permitidos
  // ─────────────────────────────────────────────
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization'
  )

  // ─────────────────────────────────────────────
  // Cookies / sessão
  // ─────────────────────────────────────────────
  res.setHeader('Access-Control-Allow-Credentials', 'true')

  // ─────────────────────────────────────────────
  // CRÍTICO: expor headers usados no frontend
  // ─────────────────────────────────────────────
  res.setHeader(
    'Access-Control-Expose-Headers',
    'X-Chat-ID'
  )

  // ─────────────────────────────────────────────
  // IMPORTANTE: otimização de preflight
  // ─────────────────────────────────────────────
  res.setHeader('Access-Control-Max-Age', '86400') // 24h

  // ─────────────────────────────────────────────
  // Preflight request (OPTIONS)
  // ─────────────────────────────────────────────
  if (req.method === 'OPTIONS') {
    res.status(204).end()
    return true
  }

  return false
}