import express from "express"
import { supabaseAdmin } from "../config/supabase.js"
import { requireAuth } from "../middleware/auth.js"

const router = express.Router()

// ── GET /api/shipments ─────────────────────────────────────
// Get all shipments for current user
router.get("/", requireAuth, async (req, res) => {
  try {
    const { status, search, limit = 50, offset = 0 } = req.query

    let query = supabaseAdmin
      .from("shipments")
      .select(`*, shipment_timeline(*)`)
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1)

    if (status && status !== "all") query = query.eq("status", status)
    if (search) query = query.ilike("tracking_number", `%${search}%`)

    const { data, error } = await query

    if (error) return res.status(400).json({ error: error.message })

    res.json({ shipments: data, count: data.length })
  } catch (err) {
    console.error("Get shipments error:", err)
    res.status(500).json({ error: "Internal server error" })
  }
})

// ── GET /api/shipments/:id ─────────────────────────────────
// Get single shipment by tracking number or UUID
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params

    // Try tracking number first, then UUID
    let query = supabaseAdmin
      .from("shipments")
      .select(`*, shipment_timeline(* )`)
      .eq("user_id", req.user.id)

    const isUUID = id.includes("-") && id.length === 36
    query = isUUID
      ? query.eq("id", id)
      : query.eq("tracking_number", id)

    const { data, error } = await query.single()

    if (error || !data) return res.status(404).json({ error: "Shipment not found" })

    res.json({ shipment: data })
  } catch (err) {
    console.error("Get shipment error:", err)
    res.status(500).json({ error: "Internal server error" })
  }
})

// ── POST /api/shipments ────────────────────────────────────
// Create new shipment
router.post("/", requireAuth, async (req, res) => {
  try {
    const body = req.body

    // Generate tracking number
    const trackingNumber = `SHP-${new Date().getFullYear()}-${String(Date.now()).slice(-6)}`

    // Get user's company_id
    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("company_id")
      .eq("id", req.user.id)
      .single()

    const { data: shipment, error } = await supabaseAdmin
      .from("shipments")
      .insert({
        ...body,
        user_id:         req.user.id,
        company_id:      profile?.company_id,
        tracking_number: trackingNumber,
        status:          "pending",
        status_color:    "amber",
      })
      .select()
      .single()

    if (error) return res.status(400).json({ error: error.message })

    // Create initial timeline event
    await supabaseAdmin.from("shipment_timeline").insert({
      shipment_id: shipment.id,
      label:       "Order Booked",
      sub:         `${body.origin_city} • ${new Date().toLocaleDateString("en-IN")}`,
      status:      "done",
    })

    // Create alert for user
    await supabaseAdmin.from("alerts").insert({
      user_id:     req.user.id,
      type:        "success",
      message:     `New shipment ${trackingNumber} created — ${body.origin_city} → ${body.dest_city}`,
      shipment_id: shipment.id,
    })

    res.status(201).json({ shipment, tracking_number: trackingNumber })
  } catch (err) {
    console.error("Create shipment error:", err)
    res.status(500).json({ error: "Internal server error" })
  }
})

// ── GET /api/shipments/stats/summary ──────────────────────
// Dashboard KPI stats  (MUST be before /:id to avoid shadowing)
router.get("/stats/summary", requireAuth, async (req, res) => {
  try {
    const now   = new Date()
    const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()

    const { data: all, error } = await supabaseAdmin
      .from("shipments")
      .select("status, declared_value, transport_mode, created_at")
      .eq("user_id", req.user.id)

    if (error) return res.status(400).json({ error: error.message })

    const stats = {
      total:         all.length,
      active:        all.filter(s => !["delivered","cancelled"].includes(s.status)).length,
      in_transit:    all.filter(s => s.status === "in_transit").length,
      delivered:     all.filter(s => s.status === "delivered").length,
      delayed:       all.filter(s => s.status === "delayed").length,
      pending:       all.filter(s => s.status === "pending").length,
      // Only sum shipments created this calendar month
      monthly_spend: all
        .filter(s => s.created_at >= start)
        .reduce((sum, s) => sum + (s.declared_value || 0), 0),
    }

    res.json({ stats })
  } catch (err) {
    res.status(500).json({ error: "Internal server error" })
  }
})

// ── PUT /api/shipments/:id ─────────────────────────────────
// Update shipment (status, location etc.)
router.put("/:id", requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("shipments")
      .update(req.body)
      .eq("id", req.params.id)
      .eq("user_id", req.user.id)
      .select()
      .single()

    if (error) return res.status(400).json({ error: error.message })

    res.json({ shipment: data })
  } catch (err) {
    console.error("Update shipment error:", err)
    res.status(500).json({ error: "Internal server error" })
  }
})

// ── GET /api/shipments/:id/timeline ───────────────────────
router.get("/:id/timeline", requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("shipment_timeline")
      .select("*")
      .eq("shipment_id", req.params.id)
      .order("event_time", { ascending: true })

    if (error) return res.status(400).json({ error: error.message })

    res.json({ timeline: data })
  } catch (err) {
    res.status(500).json({ error: "Internal server error" })
  }
})

export default router