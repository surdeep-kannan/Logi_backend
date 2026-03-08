import express from "express"
import { supabaseAdmin } from "../config/supabase.js"
import { requireAuth } from "../middleware/auth.js"

const router = express.Router()

const c = { reset:"\x1b[0m", green:"\x1b[32m", yellow:"\x1b[33m", red:"\x1b[31m", cyan:"\x1b[36m", dim:"\x1b[2m" }
const log = {
  ok:   (msg) => console.log(`${c.green}  ✓ ${msg}${c.reset}`),
  info: (msg) => console.log(`${c.cyan}  → ${msg}${c.reset}`),
  warn: (msg) => console.log(`${c.yellow}  ⚠ ${msg}${c.reset}`),
  err:  (msg) => console.log(`${c.red}  ✗ ${msg}${c.reset}`),
  dim:  (msg) => console.log(`${c.dim}    ${msg}${c.reset}`),
}

// ── POST /api/auth/signup ─────────────────────────────────
router.post("/signup", async (req, res) => {
  try {
    const { email, password, full_name, company_name, mobile_number, role } = req.body
    if (!email || !password) return res.status(400).json({ error: "Email and password required" })

    log.info(`Signup attempt: ${email}`)

    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name, company_name, mobile_number, role },
    })

    if (error) {
      log.warn(`Signup failed: ${error.message}`)
      return res.status(400).json({ error: error.message })
    }

    // Sign in immediately to get a session token
    const { data: session, error: signInErr } = await supabaseAdmin.auth.signInWithPassword({ email, password })
    if (signInErr) {
      log.warn(`Auto sign-in after signup failed: ${signInErr.message}`)
      return res.status(201).json({ message: "Account created. Please log in." })
    }

    log.ok(`Signup success: ${email}`)
    res.status(201).json({
      token: session.session.access_token,
      user:  { id: data.user.id, email: data.user.email },
    })
  } catch (err) {
    log.err(`Signup error: ${err.message}`)
    res.status(500).json({ error: "Internal server error" })
  }
})

// ── POST /api/auth/login ──────────────────────────────────
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body
    if (!email || !password) return res.status(400).json({ error: "Email and password required" })

    log.info(`Login: ${email}`)

    const { data, error } = await supabaseAdmin.auth.signInWithPassword({ email, password })

    if (error) {
      log.warn(`Login failed: ${email} — ${error.message}`)
      return res.status(401).json({ error: "Invalid email or password" })
    }

    log.ok(`Login success: ${email}`)
    res.json({
      token: data.session.access_token,
      user:  { id: data.user.id, email: data.user.email },
    })
  } catch (err) {
    log.err(`Login error: ${err.message}`)
    res.status(500).json({ error: "Internal server error" })
  }
})

// ── GET /api/auth/me ──────────────────────────────────────
router.get("/me", requireAuth, async (req, res) => {
  try {
    log.info(`GET /me  [${req.user.email}]`)

    // Fetch profile
    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("*")
      .eq("id", req.user.id)
      .single()

    // Fetch user preferences
    const { data: prefs } = await supabaseAdmin
      .from("user_preferences")
      .select("*")
      .eq("user_id", req.user.id)
      .single()

    // Fetch company if linked
    let company = null
    if (profile?.company_id) {
      const { data: co } = await supabaseAdmin
        .from("companies")
        .select("*")
        .eq("id", profile.company_id)
        .single()
      company = co
    }

    log.ok(`/me returned for ${req.user.email}`)

    res.json({
      user: {
        id:      req.user.id,
        email:   req.user.email,
        profile: {
          ...profile,
          user_preferences: prefs  || {},
          companies:        company || {},
        },
      },
    })
  } catch (err) {
    log.err(`/me error: ${err.message}`)
    res.status(500).json({ error: "Internal server error" })
  }
})

// ── PUT /api/auth/profile ─────────────────────────────────
router.put("/profile", requireAuth, async (req, res) => {
  try {
    const {
      full_name, mobile_number, role, avatar_url,
      // Company fields
      company_name, company_address, company_city,
      company_state, company_zip, company_country, tax_id,
      // Preferences
      email_notifications, shipment_updates, delay_alerts,
      cost_alerts, weekly_reports, market_insights,
      currency, weight_unit, volume_unit,
      timezone, language, date_format,
    } = req.body

    log.info(`PUT /profile  [${req.user.email}]`)

    // 1. Update profile
    const profileUpdate = {}
    if (full_name     !== undefined) profileUpdate.full_name     = full_name
    if (mobile_number !== undefined) profileUpdate.mobile_number = mobile_number
    if (role          !== undefined) profileUpdate.role          = role
    if (avatar_url    !== undefined) profileUpdate.avatar_url    = avatar_url

    if (Object.keys(profileUpdate).length > 0) {
      const { error: profileErr } = await supabaseAdmin
        .from("profiles")
        .upsert({ id: req.user.id, email: req.user.email, ...profileUpdate })

      if (profileErr) log.warn(`Profile update error: ${profileErr.message}`)
    }

    // 2. Update / create company
    const coFields = { company_name, company_address, company_city, company_state, company_zip, company_country, tax_id }
    const hasCoData = Object.values(coFields).some(v => v !== undefined)
    if (hasCoData) {
      // Get current profile to find company_id
      const { data: profile } = await supabaseAdmin
        .from("profiles").select("company_id").eq("id", req.user.id).single()

      const coUpdate = {}
      if (company_name    !== undefined) coUpdate.name    = company_name
      if (company_address !== undefined) coUpdate.address = company_address
      if (company_city    !== undefined) coUpdate.city    = company_city
      if (company_state   !== undefined) coUpdate.state   = company_state
      if (company_zip     !== undefined) coUpdate.zip     = company_zip
      if (company_country !== undefined) coUpdate.country = company_country
      if (tax_id          !== undefined) coUpdate.tax_id  = tax_id

      if (profile?.company_id) {
        await supabaseAdmin.from("companies").update(coUpdate).eq("id", profile.company_id)
      } else if (company_name) {
        // Create new company and link to profile
        const { data: newCo } = await supabaseAdmin
          .from("companies").insert({ ...coUpdate, owner_id: req.user.id }).select().single()
        if (newCo) {
          await supabaseAdmin.from("profiles").update({ company_id: newCo.id }).eq("id", req.user.id)
        }
      }
    }

    // 3. Update preferences
    const prefFields = {
      email_notifications, shipment_updates, delay_alerts,
      cost_alerts, weekly_reports, market_insights,
      currency, weight_unit, volume_unit,
      timezone, language, date_format,
    }
    const hasPrefs = Object.values(prefFields).some(v => v !== undefined)
    if (hasPrefs) {
      const prefUpdate = {}
      Object.entries(prefFields).forEach(([k, v]) => { if (v !== undefined) prefUpdate[k] = v })
      await supabaseAdmin
        .from("user_preferences")
        .upsert({ user_id: req.user.id, ...prefUpdate })
    }

    log.ok(`Profile updated for ${req.user.email}`)
    res.json({ message: "Profile updated successfully" })

  } catch (err) {
    log.err(`Profile update error: ${err.message}`)
    res.status(500).json({ error: "Internal server error" })
  }
})

// ── POST /api/auth/reset-password ────────────────────────
router.post("/reset-password", requireAuth, async (req, res) => {
  try {
    log.info(`Password reset request: ${req.user.email}`)
    const { error } = await supabaseAdmin.auth.resetPasswordForEmail(
      req.user.email,
      { redirectTo: `${process.env.FRONTEND_URL || "http://localhost:5173"}/reset-password` }
    )
    if (error) {
      log.warn(`Reset failed: ${error.message}`)
      return res.status(400).json({ error: error.message })
    }
    log.ok(`Reset email sent to ${req.user.email}`)
    res.json({ message: "Reset link sent" })
  } catch (err) {
    log.err(`Reset error: ${err.message}`)
    res.status(500).json({ error: "Internal server error" })
  }
})

// ── POST /api/auth/logout ─────────────────────────────────
router.post("/logout", requireAuth, async (req, res) => {
  try {
    log.info(`Logout: ${req.user.email}`)
    // JWTs are stateless — invalidation is handled client-side by discarding the token.
    // supabaseAdmin.auth.admin.signOut() does not exist in the JS SDK.
    log.ok(`Logged out: ${req.user.email}`)
    res.json({ message: "Logged out successfully" })
  } catch (err) {
    log.warn(`Logout error (non-fatal): ${err.message}`)
    res.json({ message: "Logged out" })
  }
})

export default router