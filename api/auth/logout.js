import { applyCors } from '../_cors.js'

export default function handler(req, res) {
  if (applyCors(req, res)) return

  const isProd = process.env.NODE_ENV === 'production'

  res.setHeader(
    'Set-Cookie',
    `session=; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=0`
  )

  res.status(204).end()
}