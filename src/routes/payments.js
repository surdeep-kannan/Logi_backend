/**
 * payments.js — LoRRI.ai backend
 *
 * POST /api/payments/capture   — verify PayPal capture, save payment + create shipment
 * GET  /api/payments           — list user's payments (newest first)
 * GET  /api/payments/:id       — single payment detail
 */

import express from "express"
import { supabaseAdmin } from "../config/supabase.js"
import { requireAuth } from "../middleware/auth.js"

const router = express.Router()

// ── PayPal config ─────────────────────────────────────────────────────────────
const PP_CLIENT_ID     = process.env.PAYPAL_CLIENT_ID     || ""
const PP_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || ""
const PP_BASE          = (process.env.PAYPAL_ENV || "sandbox") === "live"
  ? "https://api-m.paypal.com"
  : "https://api-m.sandbox.paypal.com"

const USD_TO_INR = 83.5   // fallback exchange rate

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getPayPalToken() {
  const creds = Buffer.from(`${PP_CLIENT_ID}:${PP_CLIENT_SECRET}`).toString("base64")
  const res   = await fetch(`${PP_BASE}/v1/oauth2/token`, {
    method:  "POST",
    headers: {
      Authorization:  `Basic ${creds}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`PayPal token error ${res.status}: ${text}`)
  }
  const data = await res.json()
  return data.access_token
}

async function verifyPayPalOrder(orderId) {
  const token = await getPayPalToken()
  const res   = await fetch(`${PP_BASE}/v2/checkout/orders/${orderId}`, {
    headers: {
      Authorization:  `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`PayPal verify error ${res.status}: ${text}`)
  }
  return res.json()
}

function generateTrackingNumber() {
  const ts   = Date.now().toString(36).toUpperCase()
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase()
  return `LRR-${ts}-${rand}`
}

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/payments/capture
//
//  Body: {
//    paypal_order_id : string
//    amount_inr      : number
//    route_data      : { name, carrier, from, to, transitDays }
//    shipment_data   : { origin_*, dest_*, cargo fields... }
//  }
// ─────────────────────────────────────────────────────────────────────────────
router.post("/capture", requireAuth, async (req, res) => {
  const userId = req.user.id
  const {
    paypal_order_id,
    amount_inr,
    route_data    = {},
    shipment_data = {},
  } = req.body

  if (!paypal_order_id) {
    return res.status(400).json({ error: "paypal_order_id is required" })
  }

  try {
    // ── 1. Verify with PayPal ─────────────────────────────────────────────
    let captureId     = null
    let amountUSD     = null
    let paypalPayload = {}

    if (PP_CLIENT_SECRET) {
      const ppOrder = await verifyPayPalOrder(paypal_order_id)
      paypalPayload = ppOrder

      if (ppOrder.status !== "COMPLETED") {
        return res.status(400).json({
          error: `Payment not COMPLETED — PayPal status: ${ppOrder.status}`,
        })
      }

      const capture = ppOrder?.purchase_units?.[0]?.payments?.captures?.[0]
      captureId     = capture?.id || null
      amountUSD     = parseFloat(capture?.amount?.value) || null
    } else {
      // Dev mode — no secret set, skip verification
      console.warn("⚠ PAYPAL_CLIENT_SECRET not set — skipping PayPal verification (dev mode)")
      amountUSD = amount_inr ? parseFloat((amount_inr / USD_TO_INR).toFixed(2)) : null
      captureId = `DEV-CAPTURE-${Date.now()}`
    }

    const finalINR       = amount_inr
      ? parseFloat(amount_inr)
      : (amountUSD ? Math.round(amountUSD * USD_TO_INR) : null)
    const trackingNumber = generateTrackingNumber()

    // ── 2. Save payment record ────────────────────────────────────────────
    // supabaseAdmin (service role) bypasses RLS — matches your
    // "Service role manages payments" policy
    const { data: payment, error: paymentError } = await supabaseAdmin
      .from("payments")
      .insert({
        user_id:           userId,
        paypal_order_id,
        paypal_capture_id: captureId,
        amount_inr:        finalINR,
        amount_usd:        amountUSD,
        currency:          "USD",
        status:            "completed",
        tracking_number:   trackingNumber,
        route_name:        route_data.name        || null,
        route_carrier:     route_data.carrier     || null,
        route_from:        route_data.from        || null,
        route_to:          route_data.to          || null,
        transit_days:      route_data.transitDays || null,
        paypal_payload:    paypalPayload,
      })
      .select()
      .single()

    if (paymentError) {
      // Don't block — PayPal already captured money, just log it
      console.error("⚠ Payment DB insert failed:", paymentError.message)
    }

    // ── 3. Create shipment record ─────────────────────────────────────────
    const { data: shipment, error: shipmentError } = await supabaseAdmin
      .from("shipments")
      .insert({
        user_id:              userId,
        tracking_number:      trackingNumber,
        status:               "booked",

        // Origin
        origin_company:       shipment_data.origin_company       || null,
        origin_contact:       shipment_data.origin_contact       || null,
        origin_phone:         shipment_data.origin_phone         || null,
        origin_email:         shipment_data.origin_email         || null,
        origin_address:       shipment_data.origin_address       || null,
        origin_city:          shipment_data.origin_city          || null,
        origin_state:         shipment_data.origin_state         || null,
        origin_zip:           shipment_data.origin_zip           || null,
        origin_country:       shipment_data.origin_country       || "India",

        // Destination
        dest_company:         shipment_data.dest_company         || null,
        dest_contact:         shipment_data.dest_contact         || null,
        dest_phone:           shipment_data.dest_phone           || null,
        dest_email:           shipment_data.dest_email           || null,
        dest_address:         shipment_data.dest_address         || null,
        dest_city:            shipment_data.dest_city            || null,
        dest_state:           shipment_data.dest_state           || null,
        dest_zip:             shipment_data.dest_zip             || null,
        dest_country:         shipment_data.dest_country         || "India",

        // Cargo
        cargo_type:           shipment_data.cargo_type           || "general",
        commodity:            shipment_data.commodity            || null,
        hs_code:              shipment_data.hs_code              || null,
        pieces:               parseInt(shipment_data.pieces)     || 1,
        weight:               parseFloat(shipment_data.weight)   || null,
        weight_unit:          shipment_data.weight_unit          || "kg",
        dimensions:           shipment_data.dimensions           || null,
        volume:               parseFloat(shipment_data.volume)   || null,
        volume_unit:          shipment_data.volume_unit          || "cbm",
        declared_value:       parseFloat(shipment_data.declared_value) || null,
        currency:             shipment_data.currency             || "INR",

        // Logistics
        carrier:              shipment_data.carrier || route_data.carrier || null,
        service_level:        shipment_data.service_level        || "express",
        transport_mode:       shipment_data.transport_mode       || "road",
        equipment_type:       shipment_data.equipment_type       || null,
        incoterms:            shipment_data.incoterms            || null,
        special_instructions: shipment_data.special_instructions || null,
        insurance_required:   shipment_data.insurance_required   || false,
        insurance_value:      parseFloat(shipment_data.insurance_value) || null,
        po_number:            shipment_data.po_number            || null,
        invoice_number:       shipment_data.invoice_number       || null,

        // Payment linkage
        payment_id:           payment?.id || null,
        amount_paid_inr:      finalINR,
      })
      .select()
      .single()

    if (shipmentError) {
      console.error("⚠ Shipment DB insert failed:", shipmentError.message)
    }

    // ── 4. Add "Booked" timeline event ────────────────────────────────────
    if (shipment?.id) {
      await supabaseAdmin
        .from("shipment_timeline")
        .insert({
          shipment_id: shipment.id,
          status:      "booked",
          title:       "Shipment Booked",
          description: `Booking confirmed via PayPal. Carrier: ${route_data.carrier || "TBD"}`,
          timestamp:   new Date().toISOString(),
        })
        .catch(err => console.error("Timeline insert failed:", err.message))
    }

    // ── 5. Back-link payment → shipment ───────────────────────────────────
    if (payment?.id && shipment?.id) {
      await supabaseAdmin
        .from("payments")
        .update({ shipment_id: shipment.id })
        .eq("id", payment.id)
        .catch(err => console.error("Payment shipment_id update failed:", err.message))
    }

    return res.json({
      success:         true,
      tracking_number: trackingNumber,
      payment_id:      payment?.id  || null,
      shipment_id:     shipment?.id || null,
      amount_inr:      finalINR,
      amount_usd:      amountUSD,
    })

  } catch (err) {
    console.error("Payment capture error:", err)
    return res.status(500).json({ error: err.message || "Payment processing failed" })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/payments
// ─────────────────────────────────────────────────────────────────────────────
router.get("/", requireAuth, async (req, res) => {
  const userId = req.user.id
  const limit  = parseInt(req.query.limit)  || 50
  const offset = parseInt(req.query.offset) || 0

  try {
    const { data, error, count } = await supabaseAdmin
      .from("payments")
      .select("*", { count: "exact" })
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1)

    if (error) throw error

    return res.json({
      payments: data  || [],
      total:    count || 0,
      limit,
      offset,
    })
  } catch (err) {
    console.error("Payments list error:", err)
    return res.status(500).json({ error: err.message || "Failed to fetch payments" })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/payments/:id
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:id", requireAuth, async (req, res) => {
  const userId    = req.user.id
  const paymentId = req.params.id

  try {
    const { data, error } = await supabaseAdmin
      .from("payments")
      .select("*")
      .eq("id", paymentId)
      .eq("user_id", userId)
      .single()

    if (error || !data) {
      return res.status(404).json({ error: "Payment not found" })
    }

    return res.json({ payment: data })
  } catch (err) {
    console.error("Payment detail error:", err)
    return res.status(500).json({ error: err.message })
  }
})

export default router