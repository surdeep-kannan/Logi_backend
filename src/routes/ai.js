import express from "express"
import { askGemini, chatGemini } from "../config/gemini.js"
import { supabaseAdmin } from "../config/supabase.js"
import { requireAuth } from "../middleware/auth.js"
import { geocodeAndDistance } from "../config/ors.js"   // ← NEW

const router = express.Router()

const SYSTEM_PROMPT = `You are LoRRI, an expert AI freight intelligence assistant for LoRRI.ai — India's first AI-powered logistics intelligence platform.
You help with freight rate benchmarking, route recommendations, port congestion, carrier comparison, Scope 3 emissions, and customs guidance.
Key facts: 2,000+ carrier network, 32% avg cost savings, 98% on-time delivery, covers all major Indian ports.
Always be concise and data-driven. Use ₹ for Indian Rupees.`

// ── POST /api/ai/chat ──────────────────────────────────────
router.post("/chat", requireAuth, async (req, res) => {
  try {
    const { message, shipment_context } = req.body
    if (!message) return res.status(400).json({ error: "Message is required" })

    let pastMessages = []
    try {
      const { data: history } = await Promise.race([
        supabaseAdmin
          .from("chat_history")
          .select("role, content")
          .eq("user_id", req.user.id)
          .order("created_at", { ascending: false })
          .limit(10),
        new Promise((_, rej) => setTimeout(() => rej(new Error("history timeout")), 3000))
      ])
      pastMessages = (history || []).reverse()
    } catch (e) {
      console.warn("chat history skip:", e.message)
    }

    let userShipments = []
    let userProfile = null
    try {
      const [{ data: shipments }, { data: profile }] = await Promise.all([
        supabaseAdmin
          .from("shipments")
          .select("id, tracking_number, origin_city, dest_city, status, carrierName, transport_mode, created_at, delivery_date")
          .eq("user_id", req.user.id)
          .order("created_at", { ascending: false })
          .limit(15),
        supabaseAdmin
          .from("profiles")
          .select("full_name, company_id")
          .eq("id", req.user.id)
          .single()
      ])
      userShipments = shipments || []
      userProfile = profile || {}
    } catch (e) {
      console.warn("User context fetch error:", e.message)
    }

    let systemPrompt = SYSTEM_PROMPT
    systemPrompt += `\n\nYou are talking to: ${userProfile?.full_name || "a User"}`
    if (userShipments.length > 0) {
      systemPrompt += `\n\nHere are their recent shipments in JSON format:\n${JSON.stringify(userShipments, null, 2)}`
      systemPrompt += `\nUse this data to answer questions about their specific shipments, statuses, and counts.`
    }
    if (shipment_context) {
      systemPrompt += `\n\nCurrent shipment context (frontend UI focus):\n${JSON.stringify(shipment_context, null, 2)}`
    }

    const messages = [...pastMessages, { role: "user", content: message }]
    const reply = await chatGemini(messages, systemPrompt)

    supabaseAdmin.from("chat_history").insert([
      { user_id: req.user.id, role: "user", content: message },
      { user_id: req.user.id, role: "assistant", content: reply },
    ]).then(() => { }).catch(() => { })

    res.json({ reply })
  } catch (err) {
    console.error("AI chat error:", err.message)
    res.status(500).json({ error: err.message || "AI service unavailable" })
  }
})

// ── GET /api/ai/chat/history ───────────────────────────────
router.get("/chat/history", requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("chat_history")
      .select("*")
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: true })
      .limit(100)

    if (error) return res.status(400).json({ error: error.message })
    res.json({ history: data })
  } catch (err) {
    res.status(500).json({ error: "Internal server error" })
  }
})

// ── DELETE /api/ai/chat/history ────────────────────────────
router.delete("/chat/history", requireAuth, async (req, res) => {
  try {
    await supabaseAdmin.from("chat_history").delete().eq("user_id", req.user.id)
    res.json({ message: "Chat history cleared" })
  } catch (err) {
    res.status(500).json({ error: "Internal server error" })
  }
})

// ── POST /api/ai/route ─────────────────────────────────────
// Now uses real ORS distance + 3 differentiated route strategies
router.post("/route", requireAuth, async (req, res) => {
  try {
    const {
      origin,           // city name OR full address string from frontend
      destination,      // city name OR full address string from frontend
      origin_address, origin_city, origin_state, origin_zip,   // structured fields (preferred)
      dest_address,   dest_city,   dest_state,   dest_zip,
      cargo_type, weight, transport_mode, priority,
    } = req.body

    if (!origin && !origin_city) return res.status(400).json({ error: "Origin is required" })
    if (!destination && !dest_city) return res.status(400).json({ error: "Destination is required" })

    // ── Step 1: Get real coordinates + road distance from ORS ──
    // Use structured fields if provided, fall back to plain city name strings
    const originParts = {
      address: origin_address || null,
      city:    origin_city    || origin,
      state:   origin_state   || null,
      zip:     origin_zip     || null,
    }
    const destParts = {
      address: dest_address || null,
      city:    dest_city    || destination,
      state:   dest_state   || null,
      zip:     dest_zip     || null,
    }

    const geoData = await geocodeAndDistance(originParts, destParts)

    // Log what we got — helpful for debugging
    if (geoData) {
      console.log(`✓ ORS route data: ${geoData.distanceKm}km | ${geoData.durationHrs}hrs drive time`)
    } else {
      console.warn("⚠ ORS unavailable — AI will estimate distance")
    }

    const fromLabel = origin_city || origin
    const toLabel   = dest_city   || destination

    // ── Step 2: Build a data-rich prompt with real numbers ─────
    // The AI now gets actual km + hrs, so it can reason about real
    // prices, real transit times, and real trade-offs per strategy
    const prompt = `You are a JSON API. You must respond with ONLY a valid JSON object, no explanations, no markdown, no calculations shown, no text before or after the JSON. Any non-JSON response will cause a system failure.

You are a senior Indian freight analyst for LoRRI.ai.

SHIPMENT DETAILS:
- Origin      : ${fromLabel}, India${origin_state ? `, ${origin_state}` : ""}
- Destination : ${toLabel}, India${dest_state ? `, ${dest_state}` : ""}
- Cargo type  : ${cargo_type || "general"}
- Weight      : ${weight || "unknown"} kg
- Preferred mode : ${transport_mode || "any"}
- Client priority: ${priority || "balanced"}

REAL ROUTE DATA FROM MAPPING ENGINE:
${geoData
  ? `- Road distance  : ${geoData.distanceKm} km (actual HGV road distance)
- HGV drive time : ${geoData.durationHrs} hours (includes real-world correction for traffic/stops)
- Origin coords  : [${geoData.origin.lat}, ${geoData.origin.lng}]
- Dest coords    : [${geoData.dest.lat}, ${geoData.dest.lng}]
${geoData.alternatives?.length > 0
  ? `- Alternative routes found:\n${geoData.alternatives.map(a => `  Route ${a.index + 1}: ${a.distanceKm}km, ${a.durationHrs}hrs (${a.label})`).join("\n")}`
  : "- No alternative routes available"
}`
  : `- Road distance  : estimate based on Indian geography (mapping engine unavailable)
- Use your knowledge of Indian road networks to estimate realistic distances`
}

PRICING — CALCULATE FROM ACTUAL WEIGHT AND DISTANCE:
Weight: ${weight || "unknown"} kg | Distance: ${geoData?.distanceKm || "estimate"} km

Road FTL express  : ₹22/km flat (good for heavy cargo like this)
Road FTL standard : ₹16/km flat
Road LTL economy  : ₹30/kg (consolidation)
Rail freight      : ₹12/kg (30% cheaper, +2 days terminal time)
Air freight       : ₹110/kg (fastest, weight × rate)
Add handling fee  : Road ₹4,500 | Rail ₹8,000 | Air ₹12,000

CALCULATE each route price using the formula above with ACTUAL weight and distance.
For road: price = (distanceKm × rate_per_km) + handling
For air/rail: price = (weightKg × rate_per_kg) + handling
CO2 road: ~0.12 kg per tonne-km | rail: ~0.03 | air: ~0.60

Generate EXACTLY 3 route options with DIFFERENT strategies:

ROUTE 1 — "Express Premium"
- Strategy: Absolute fastest delivery, price is secondary
- Use air freight OR dedicated express road with top carrier (DTDC, Blue Dart, FedEx)
- No consolidation, no stops, direct service
- Tag: "Fastest"

ROUTE 2 — "Economy Saver"  
- Strategy: Lowest possible cost, client is flexible on time
- Use rail+road multimodal OR LTL road consolidation/groupage
- Accepts 30–50% longer transit time in exchange for savings
- Tag: "Cheapest"

ROUTE 3 — "AI Recommended"
- Strategy: Best balance of speed, cost, reliability — this is your strategic pick
- This is the route LoRRI recommends based on the lane and cargo
- Tag: "Best Value"

Use the REAL distance and time from the mapping engine above to calculate transit days accurately.
For road: assume avg truck speed 400–500 km/day on Indian highways.
For rail: add 1–2 days for loading/unloading + terminal time.
For air: same day or next day.

Return ONLY valid JSON, no markdown, no explanation:
{
  "routes": [
    {
      "id": "express-1",
      "name": "Express Premium",
      "tag": "Fastest",
      "tagColor": "blue",
      "carrier": "Blue Dart / FedEx",
      "mode": "air",
      "distanceKm": ${geoData?.distanceKm || "null"},
      "duration": "1 day",
      "transitDays": 1,
      "price": 0,
      "currency": "INR",
      "savings_pct": 0,
      "on_time_pct": 99,
      "co2": 0,
      "pros": ["Fastest available", "Real-time tracking", "Premium handling"],
      "cons": ["Higher cost", "Not suitable for bulk cargo"],
      "highlights": ["Direct air freight", "Door-to-door", "Same-day booking cutoff 3PM"]
    },
    {
      "id": "economy-2",
      "name": "Economy Saver",
      "tag": "Cheapest",
      "tagColor": "green",
      "carrier": "Indian Railways / GATI",
      "mode": "multimodal",
      "distanceKm": ${geoData?.distanceKm || "null"},
      "duration": "X days",
      "transitDays": 5,
      "price": 0,
      "currency": "INR",
      "savings_pct": 0,
      "on_time_pct": 88,
      "co2": 0,
      "pros": ["Lowest cost", "Eco-friendly", "Good for bulk"],
      "cons": ["Slower transit", "Terminal handling time"],
      "highlights": ["Rail + last mile road", "Groupage available", "Best for non-urgent cargo"]
    },
    {
      "id": "ai-3",
      "name": "AI Recommended",
      "tag": "Best Value",
      "tagColor": "purple",
      "carrier": "Delhivery / TCI",
      "mode": "road",
      "distanceKm": ${geoData?.distanceKm || "null"},
      "duration": "X days",
      "transitDays": 3,
      "price": 0,
      "currency": "INR",
      "savings_pct": 0,
      "on_time_pct": 96,
      "co2": 0,
      "pros": ["Best speed-cost ratio", "Reliable carrier", "Live GPS tracking"],
      "cons": ["Slightly higher than economy"],
      "highlights": ["Dedicated FTL", "LoRRI carrier partner", "98% on-time on this lane"]
    }
  ],
  "route_context": {
    "distance_km": ${geoData?.distanceKm || null},
    "duration_hrs": ${geoData?.durationHrs || null},
    "origin_lat": ${geoData?.origin?.lat || null},
    "origin_lng": ${geoData?.origin?.lng || null},
    "dest_lat": ${geoData?.dest?.lat || null},
    "dest_lng": ${geoData?.dest?.lng || null},
    "lane_analysis": "one sentence about this freight lane — congestion, typical carriers, seasonal factors"
  }
}`

    // ── Step 3: Call AI with the data-rich prompt ───────────
    const text = await askGemini(prompt)

    // Guard: model returned empty or fallback string
    if (!text || text === "No response received." || text.trim().length < 10) {
      throw new Error("AI model returned empty response — model may be overloaded, try again")
    }

    // Strip markdown fences
    let clean = text.replace(/```json[\s\S]*?```|```[\s\S]*?```|```json|```/g, "").trim()

    // Extract JSON object even if model added extra text around it
    const jsonMatch = clean.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      console.error("AI raw response (first 300 chars):", text.slice(0, 300))
      throw new Error("AI response did not contain valid JSON")
    }

    let jsonStr = jsonMatch[0]

    // Fix common JSON issues from AI models:
    // 1. Remove trailing commas before } or ]
    jsonStr = jsonStr.replace(/,(\s*[}\]])/g, "$1")
    // 2. Fix unquoted keys (rare but happens)
    jsonStr = jsonStr.replace(/([{,]\s*)(\w+)(\s*:)/g, '$1"$2"$3')
    // 3. Remove any control characters
    jsonStr = jsonStr.replace(/[-]/g, " ")

    let parsed
    try {
      parsed = JSON.parse(jsonStr)
    } catch (parseErr) {
      console.error("JSON parse failed. Raw (first 500):", text.slice(0, 500))
      throw new Error(`JSON parse error: ${parseErr.message}`)
    }

    res.json(parsed)

  } catch (err) {
    console.error("AI route error:", err.message)
    res.status(500).json({ error: err.message || "Route recommendation unavailable" })
  }
})

export default router