import express from "express"
import { askGemini } from "../config/gemini.js"
import { supabaseAdmin } from "../config/supabase.js"

const router = express.Router()

async function requireCarrier(req, res, next) {
  try {
    const apiKey = req.headers["x-api-key"]
    if (!apiKey) return res.status(401).json({ error: "API key required" })

    const { data: carrier, error } = await supabaseAdmin
      .from("carrier_companies")
      .select("*")
      .eq("api_key", apiKey)
      .eq("is_active", true)
      .single()

    if (error || !carrier) return res.status(401).json({ error: "Invalid API key" })
    req.carrier = carrier
    next()
  } catch (err) {
    res.status(500).json({ error: "Authentication error" })
  }
}

// ── POST /api/carrier/login ────────────────────────────────
router.post("/login", async (req, res) => {
  try {
    const { email } = req.body
    if (!email) return res.status(400).json({ error: "Email required" })

    const { data: carrier, error } = await supabaseAdmin
      .from("carrier_companies")
      .select("id, name, email") // ✅ api_key excluded — never expose in response
      .eq("email", email)
      .eq("is_active", true)
      .single()

    if (error || !carrier) return res.status(404).json({ error: "Carrier not found" })
    res.json({ carrier })
  } catch (err) {
    res.status(500).json({ error: "Internal server error" })
  }
})

// ── GET /api/carrier/shipments ─────────────────────────────
router.get("/shipments", requireCarrier, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("shipments")
      .select("id, tracking_number, status, origin_city, dest_city, current_location, eta, transport_mode")
      .eq("carrier", req.carrier.name)
      .not("status", "eq", "delivered")
      .order("created_at", { ascending: false })

    if (error) return res.status(400).json({ error: error.message })
    res.json({ shipments: data })
  } catch (err) {
    res.status(500).json({ error: "Internal server error" })
  }
})

// ── POST /api/carrier/update ───────────────────────────────
router.post("/update", requireCarrier, async (req, res) => {
  try {
    const { message } = req.body
    if (!message) return res.status(400).json({ error: "Message is required" })

    const { data: shipments } = await supabaseAdmin
      .from("shipments")
      .select("id, tracking_number, status, origin_city, dest_city, current_location, eta")
      .eq("carrier", req.carrier.name)
      .not("status", "eq", "delivered")
      .limit(20)

    const prompt = `You are a freight management AI. Carrier "${req.carrier.name}" sent this update:
"${message}"

Active shipments for this carrier:
${JSON.stringify(shipments, null, 2)}

Return ONLY valid JSON, no markdown:
{
  "shipment_id": "uuid",
  "tracking_number": "string",
  "updates": {
    "status": "in_transit|at_checkpoint|loading|at_sea|delivered|delayed|pending",
    "current_location": "string",
    "current_lat": 0.0,
    "current_lng": 0.0,
    "completed_km": 0,
    "remaining_km": 0,
    "eta": "YYYY-MM-DD or null"
  },
  "timeline_event": {
    "label": "string",
    "sub": "Location • Date",
    "status": "done"
  },
  "ai_interpretation": "one sentence summary"
}
If shipment not identifiable return: {"error": "Could not identify shipment"}`

    const text   = await askGemini(prompt)
    const clean  = text.replace(/```json|```/g, "").trim()
    const parsed = JSON.parse(clean)

    if (parsed.error) return res.status(400).json({ error: parsed.error })

    // ✅ Whitelist only known safe fields — never spread raw AI output to DB
    const ALLOWED_UPDATE_FIELDS = ["status", "current_location", "current_lat", "current_lng", "completed_km", "remaining_km", "eta"]
    const updatePayload = {}
    for (const field of ALLOWED_UPDATE_FIELDS) {
      if (parsed.updates?.[field] !== undefined) updatePayload[field] = parsed.updates[field]
    }
    // Only include eta if it's a non-empty value
    if (!updatePayload.eta) delete updatePayload.eta

    // Run DB updates concurrently for speed
    const [updateResult] = await Promise.all([
      supabaseAdmin.from("shipments").update(updatePayload).eq("id", parsed.shipment_id),
      parsed.timeline_event
        ? supabaseAdmin.from("shipment_timeline").insert({
            shipment_id: parsed.shipment_id,
            label:       parsed.timeline_event.label,
            sub:         parsed.timeline_event.sub,
            status:      "done",
          })
        : Promise.resolve(),
      supabaseAdmin.from("shipment_updates").insert({
        shipment_id:       parsed.shipment_id,
        carrier_id:        req.carrier.id,
        raw_message:       message,
        ai_interpretation: parsed.ai_interpretation,
        fields_updated:    parsed.updates,
      }),
    ])

    if (updateResult.error) return res.status(400).json({ error: updateResult.error.message })

    // Alert the shipment owner — non-blocking
    supabaseAdmin
      .from("shipments")
      .select("user_id, tracking_number")
      .eq("id", parsed.shipment_id)
      .single()
      .then(({ data: shipment }) => {
        if (shipment) {
          supabaseAdmin.from("alerts").insert({
            user_id:     shipment.user_id,
            type:        parsed.updates.status === "delayed" ? "warning" : "info",
            message:     `${shipment.tracking_number}: ${parsed.ai_interpretation}`,
            shipment_id: parsed.shipment_id,
          }).then(() => {}).catch(console.error)
        }
      })

    res.json({
      message:         "Shipment updated successfully",
      tracking_number: parsed.tracking_number,
      interpretation:  parsed.ai_interpretation,
      updates_applied: parsed.updates,
    })
  } catch (err) {
    console.error("Carrier update error:", err)
    res.status(500).json({ error: "AI update failed" })
  }
})

export default router