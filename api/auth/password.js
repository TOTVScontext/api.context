import { applyCors } from '../_cors.js'
import { supabase, supabaseUser } from '../_lib/supabase.js'

export default async function handler(req, res) {
  if (applyCors(req, res)) return

  try {
    if (req.method === 'POST') {
      const { email } = req.body

      if (!email || typeof email !== 'string') {
        return res.status(400).json({ error: 'Invalid request' })
      }

      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: 'https://totvs-context.vercel.app/security/reset-password'
      })

      if (error) {
        return res.status(400).json({ error: 'Unable to send reset email' })
      }

      return res.status(200).json({ success: true })
    }

    if (req.method === 'PUT') {
      const { accessToken, refreshToken, newPassword } = req.body

      if (
        !accessToken ||
        !refreshToken ||
        !newPassword ||
        newPassword.length < 8
      ) {
        return res.status(400).json({ error: 'Invalid request' })
      }

      const supabaseClient = supabaseUser(accessToken)

      const { error: sessionError } = await supabaseClient.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken
      })

      if (sessionError) {
        return res.status(400).json({ error: 'Invalid or expired link' })
      }

      const { error } = await supabaseClient.auth.updateUser({
        password: newPassword
      })

      if (error) {
        return res.status(400).json({ error: 'Unable to reset password' })
      }

      return res.status(200).json({ success: true })
    }

    return res.status(405).json({ error: 'Method not allowed' })

  } catch (err) {
    console.error('Password reset handler error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}