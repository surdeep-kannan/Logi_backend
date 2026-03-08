import express from "express"
import { supabaseAdmin } from "../config/supabase.js"
import { requireAuth } from "../middleware/auth.js"

const router = express.Router()

// ── POST /api/roi/calculate ────────────────────────────────
// Calculate ROI and save to DB
router.post("/calculate", requireAuth, async (req, res) => {
  try {
    const {
      monthly_spend = 0,
      shipments_per_month = 0,
      manual_hours = 0,
      current_ontime_pct = 85,
      team_size = 1,
    } = req.body

    // --- Calculations ---
    const annualSpend     = monthly_spend * 12
    const costSaving      = annualSpend * 0.32                          // 32% freight rate reduction
    const labourSaving    = manual_hours * team_size * 600 * 12         // hours × team × ₹600/hr × 12mo
    const delayLossPct    = (100 - current_ontime_pct) / 100
    const delayAnnual     = annualSpend * delayLossPct * 0.15           // 15% of spend lost to delays
    const delaySaving     = delayAnnual * 0.78                          // LoRRI recovers 78% of delay cost
    const totalSaving     = costSaving + labourSaving + delaySaving
    const lorriFee        = Math.max(120000, annualSpend * 0.02)        // 2% of spend or ₹1.2L min
    const roiPct          = ((totalSaving - lorriFee) / lorriFee) * 100
    const paybackMonths   = Math.ceil((lorriFee / totalSaving) * 12)

    const result = {
      cost_saving:          Math.round(costSaving),
      labour_saving:        Math.round(labourSaving),
      delay_saving:         Math.round(delaySaving),
      total_annual_saving:  Math.round(totalSaving),
      lorri_fee:            Math.round(lorriFee),
      roi_pct:              Math.round(roiPct),
      payback_months:       paybackMonths,
    }

    // Save to DB
    await supabaseAdmin.from("roi_calculations").insert({
      user_id:             req.user.id,
      monthly_spend,
      shipments_per_month,
      manual_hours,
      current_ontime_pct,
      team_size,
      cost_saving:         result.cost_saving,
      labour_saving:       result.labour_saving,
      delay_saving:        result.delay_saving,
      total_annual_saving: result.total_annual_saving,
      roi_pct:             result.roi_pct,
      payback_months:      result.payback_months,
    })

    res.json({ result })
  } catch (err) {
    console.error("ROI calculate error:", err)
    res.status(500).json({ error: "Internal server error" })
  }
})

// ── GET /api/roi/history ───────────────────────────────────
// Get user's saved ROI calculations
router.get("/history", requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("roi_calculations")
      .select("*")
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false })
      .limit(10)

    if (error) return res.status(400).json({ error: error.message })
    res.json({ history: data })
  } catch (err) {
    res.status(500).json({ error: "Internal server error" })
  }
})

export default router