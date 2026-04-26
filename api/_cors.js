const allowedOrigins = [
  'http://localhost:5173',
  'https://totvs-context.vercel.app'
]

export function applyCors(req, res) {
  const origin = req.headers.origin

  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
  }

  res.setHeader('Vary', 'Origin')
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, POST, PUT, PATCH, DELETE, OPTIONS'
  )

  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization'
  )

  res.setHeader('Access-Control-Allow-Credentials', 'true')

  if (req.method === 'OPTIONS') {
    res.status(204).end()
    return true
  }

  return false
}