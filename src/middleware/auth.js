import { supabaseAdmin } from "../config/supabase.js"

// Verifies Supabase JWT from Authorization header
// Attaches user to req.user
export async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing or invalid authorization header" })
    }

    const token = authHeader.split(" ")[1]

    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token)

    if (error || !user) {
      return res.status(401).json({ error: "Invalid or expired token" })
    }

    req.user = user
    req.token = token
    next()
  } catch (err) {
    console.error("Auth middleware error:", err)
    res.status(500).json({ error: "Authentication error" })
  }
}