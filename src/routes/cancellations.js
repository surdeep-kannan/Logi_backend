import express from "express"
import { supabaseAdmin } from "../config/supabase.js"
import { requireCompanyAuth } from "../middleware/requireCompanyAuth.js"
const router = express.Router()

// GET /api/cancellations — all cancellation requests with shipment + user info
router.get("/", requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("cancellation_requests")
      .select(`
        *,
        shipments (
          tracking_number,
          origin_city,
          destination_city,
          status
        ),
        profiles (
          full_name,
          email
        )
      `)
      .order("created_at", { ascending: false })

    if (error) throw error
    res.json(data || [])
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/cancellations/:id/approve
router.post("/:id/approve", requireAuth, async (req, res) => {
  try {
    const { id } = req.params

    // Update cancellation status
    const { error: cancelError } = await supabaseAdmin
      .from("cancellation_requests")
      .update({ status: "approved", reviewed_at: new Date().toISOString() })
      .eq("id", id)

    if (cancelError) throw cancelError

    // Also update the shipment status to cancelled
    const { data: cancelReq } = await supabaseAdmin
      .from("cancellation_requests")
      .select("shipment_id")
      .eq("id", id)
      .single()

    if (cancelReq?.shipment_id) {
      await supabaseAdmin
        .from("shipments")
        .update({ status: "cancelled" })
        .eq("id", cancelReq.shipment_id)
    }

    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/cancellations/:id/reject
router.post("/:id/reject", requireAuth, async (req, res) => {
  try {
    const { id } = req.params
    const { reason } = req.body

    if (!reason) return res.status(400).json({ error: "Rejection reason is required" })

    const { error } = await supabaseAdmin
      .from("cancellation_requests")
      .update({
        status: "rejected",
        rejection_reason: reason,
        reviewed_at: new Date().toISOString(),
      })
      .eq("id", id)

    if (error) throw error
    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default router