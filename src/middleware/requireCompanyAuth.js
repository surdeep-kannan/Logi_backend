import { supabaseAdmin } from "../config/supabase.js"

export async function requireCompanyAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "No token provided" })
    }

    const token = authHeader.split(" ")[1]

    // Verify JWT and get user
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token)
    if (error || !user) return res.status(401).json({ error: "Invalid token" })

    // Check they exist in company_staff by email and are active
    const { data: staff, error: staffError } = await supabaseAdmin
      .from("company_staff")
      .select("id, email, full_name, role, is_active")
      .eq("email", user.email)
      .single()

    if (staffError || !staff) {
      return res.status(403).json({ error: "Not authorised as company staff" })
    }

    if (!staff.is_active) {
      return res.status(403).json({ error: "Account is inactive" })
    }

    req.user  = user
    req.staff = staff
    next()
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
}