import express from "express"
import { supabaseAdmin, supabase } from "../config/supabase.js"

const router = express.Router()

// POST /api/company/auth/login
// Uses Supabase Auth — company staff must exist in both auth.users + company_staff table
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body
    if (!email || !password) return res.status(400).json({ error: "Email and password required" })

    // Sign in with Supabase Auth
    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({ email, password })
    if (authError) return res.status(401).json({ error: "Invalid credentials" })

    // Verify they exist in company_staff table
    const { data: staff, error: staffError } = await supabaseAdmin
      .from("company_staff")
      .select("id, email, full_name, role, is_active")
      .eq("auth_user_id", authData.user.id)
      .single()

    if (staffError || !staff) return res.status(403).json({ error: "Not authorised as company staff" })
    if (!staff.is_active)    return res.status(403).json({ error: "Account is inactive" })

    res.json({
      token: authData.session.access_token,
      user: {
        id:        staff.id,
        email:     staff.email,
        full_name: staff.full_name,
        role:      staff.role,
      }
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default router