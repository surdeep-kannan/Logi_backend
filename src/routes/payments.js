// ─────────────────────────────────────────────────────────
//  LoRRI.ai · Payments Route
//  src/routes/payments.js
//
//  POST /api/payments/capture   — verify PayPal order + save record
//  GET  /api/payments           — list payments for logged-in user
//  GET  /api/payments/:id       — single payment detail
// ─────────────────────────────────────────────────────────

import express        from "express"
import { supabase }   from "../config/supabase.js"
import { requireAuth } from "../middleware/auth.js"

const router = express.Router()

const PAYPAL_BASE = process.env.PAYPAL_ENV === "live"
  ? "https://api-m.paypal.com"
  : "https://api-m.sandbox.paypal.com"

const PAYPAL_CLIENT_ID     = process.env.PAYPAL_CLIENT_ID
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET

// ── Get PayPal access token ────────────────────────────────
async function getPayPalToken() {
  const creds  = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString("base64")
  const res    = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method:  "POST",
    headers: {
      Authorization:  `Basic ${creds}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error_description || "PayPal auth failed")
  return data.access_token
}

// ── Verify PayPal order ────────────────────────────────────
async function verifyPayPalOrder(orderId) {
  const token = await getPayPalToken()
  const res   = await fetch(`${PAYPAL_BASE}/v2/checkout/orders/${orderId}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const data  = await res.json()
  if (!res.ok) throw new Error(data.message || "PayPal order lookup failed")
  return data
}

// ─────────────────────────────────────────────────────────
//  POST /api/payments/capture
//  Body: { paypal_order_id, shipment_data, route_data, amount_inr }
// ─────────────────────────────────────────────────────────
router.post("/capture", requireAuth, async (req, res) => {
  try {
    const { paypal_order_id, shipment_data, route_data, amount_inr } = req.body

    if (!paypal_order_id) {
      return res.status(400).json({ error: "paypal_order_id is required" })
    }

    // 1. Verify order is COMPLETED with PayPal
    const ppOrder = await verifyPayPalOrder(paypal_order_id)

    if (ppOrder.status !== "COMPLETED") {
      return res.status(400).json({ error: `PayPal order status is ${ppOrder.status}, expected COMPLETED` })
    }

    const capture     = ppOrder.purchase_units?.[0]?.payments?.captures?.[0]
    const captureId   = capture?.id
    const paidAmtUSD  = parseFloat(capture?.amount?.value || 0)

    // 2. Create the shipment in DB
    let shipmentResult = null
    let trackingNumber = null

    if (shipment_data) {
      const { data, error } = await supabase
        .from("shipments")
        .insert({
          ...shipment_data,
          user_id: req.user.id,
        })
        .select("id, tracking_number")
        .single()

      if (error) {
        console.error("Shipment create error:", error)
        // Don't block payment record — shipment can be retried
      } else {
        shipmentResult = data
        trackingNumber = data.tracking_number
      }
    }

    // 3. Save payment record to Supabase
    const { data: payment, error: payErr } = await supabase
      .from("payments")
      .insert({
        user_id:          req.user.id,
        paypal_order_id,
        paypal_capture_id: captureId,
        amount_inr:       amount_inr || null,
        amount_usd:       paidAmtUSD,
        currency:         "USD",
        status:           "completed",
        shipment_id:      shipmentResult?.id || null,
        tracking_number:  trackingNumber,
        route_name:       route_data?.name       || null,
        route_carrier:    route_data?.carrier    || null,
        route_from:       route_data?.from       || null,
        route_to:         route_data?.to         || null,
        transit_days:     route_data?.transitDays || null,
        paypal_payload:   ppOrder,
      })
      .select()
      .single()

    if (payErr) {
      console.error("Payment insert error:", payErr)
      return res.status(500).json({ error: "Payment verified but failed to save record" })
    }

    res.json({
      success:         true,
      payment_id:      payment.id,
      tracking_number: trackingNumber,
      capture_id:      captureId,
    })

  } catch (err) {
    console.error("Payment capture error:", err)
    res.status(500).json({ error: err.message || "Payment processing failed" })
  }
})

// ─────────────────────────────────────────────────────────
//  GET /api/payments
//  Returns all payments for the logged-in user
// ─────────────────────────────────────────────────────────
router.get("/", requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("payments")
      .select("*")
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false })
      .limit(100)

    if (error) throw error
    res.json({ payments: data })
  } catch (err) {
    console.error("Payments list error:", err)
    res.status(500).json({ error: "Failed to fetch payments" })
  }
})

// ─────────────────────────────────────────────────────────
//  GET /api/payments/:id
// ─────────────────────────────────────────────────────────
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("payments")
      .select("*")
      .eq("id", req.params.id)
      .eq("user_id", req.user.id)
      .single()

    if (error || !data) return res.status(404).json({ error: "Payment not found" })
    res.json({ payment: data })
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch payment" })
  }
})

export default router