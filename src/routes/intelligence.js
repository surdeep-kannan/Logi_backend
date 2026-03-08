import express from "express"
import { supabaseAdmin } from "../config/supabase.js"
import { requireAuth } from "../middleware/auth.js"

const router = express.Router()

// ── GET /api/intelligence/ports ───────────────────────────
router.get("/ports", requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("port_congestion")
      .select("*")
      .order("congestion_pct", { ascending: false })

    if (error) return res.status(400).json({ error: error.message })
    res.json({ ports: data })
  } catch (err) {
    res.status(500).json({ error: "Internal server error" })
  }
})

// ── GET /api/intelligence/rates ───────────────────────────
router.get("/rates", requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("rate_benchmarks")
      .select("*")
      .order("route")

    if (error) return res.status(400).json({ error: error.message })
    res.json({ rates: data })
  } catch (err) {
    res.status(500).json({ error: "Internal server error" })
  }
})

// ── GET /api/intelligence/alerts ──────────────────────────
router.get("/alerts", requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("alerts")
      .select("*, shipments(tracking_number)")
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false })
      .limit(20)

    if (error) return res.status(400).json({ error: error.message })
    res.json({ alerts: data })
  } catch (err) {
    res.status(500).json({ error: "Internal server error" })
  }
})

// ── PUT /api/intelligence/alerts/:id/read ─────────────────
router.put("/alerts/:id/read", requireAuth, async (req, res) => {
  try {
    const { error } = await supabaseAdmin
      .from("alerts")
      .update({ is_read: true })
      .eq("id", req.params.id)
      .eq("user_id", req.user.id)

    if (error) return res.status(400).json({ error: error.message })
    res.json({ message: "Alert marked as read" })
  } catch (err) {
    res.status(500).json({ error: "Internal server error" })
  }
})

export default router