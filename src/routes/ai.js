import express from "express"
import { askGemini, chatGemini } from "../config/gemini.js"
import { supabaseAdmin } from "../config/supabase.js"
import { requireAuth } from "../middleware/auth.js"

const router = express.Router()

// ── Console colours ───────────────────────────────────────
const c = { reset:"\x1b[0m", green:"\x1b[32m", yellow:"\x1b[33m", red:"\x1b[31m", cyan:"\x1b[36m", dim:"\x1b[2m" }
const log = {
  ok:   (msg) => console.log(`${c.green}  ✓ ${msg}${c.reset}`),
  info: (msg) => console.log(`${c.cyan}  → ${msg}${c.reset}`),
  warn: (msg) => console.log(`${c.yellow}  ⚠ ${msg}${c.reset}`),
  err:  (msg) => console.log(`${c.red}  ✗ ${msg}${c.reset}`),
  dim:  (msg) => console.log(`${c.dim}    ${msg}${c.reset}`),
}

// ── Fetch user's live shipment data ───────────────────────
async function getUserShipmentContext(userId) {
  try {
    const { data: shipments } = await supabaseAdmin
      .from("shipments")
      .select(`
        tracking_number, status, origin_city, origin_state,
        dest_city, dest_state, transport_mode, carrier,
        eta, created_at, commodity, weight, declared_value
      `)
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(20)

    if (!shipments || shipments.length === 0) return null

    const summary = {
      total:      shipments.length,
      active:     shipments.filter(s => s.status === "in-transit").length,
      pending:    shipments.filter(s => s.status === "pending").length,
      delivered:  shipments.filter(s => s.status === "delivered").length,
      delayed:    shipments.filter(s => s.status === "delayed").length,
      shipments:  shipments.map(s => ({
        id:        s.tracking_number,
        status:    s.status,
        route:     `${s.origin_city}, ${s.origin_state} → ${s.dest_city}, ${s.dest_state}`,
        mode:      s.transport_mode,
        carrier:   s.carrier || "Not assigned",
        eta:       s.eta ? new Date(s.eta).toLocaleDateString("en-IN") : "Not set",
        cargo:     s.commodity || "General cargo",
        weight:    s.weight ? `${s.weight} kg` : "—",
        value:     s.declared_value ? `₹${Number(s.declared_value).toLocaleString("en-IN")}` : "—",
      }))
    }
    return summary
  } catch (e) {
    log.warn(`Could not fetch shipment context: ${e.message}`)
    return null
  }
}

// ── System prompt ─────────────────────────────────────────
const BASE_SYSTEM_PROMPT = `You are LoRRI, an expert AI freight intelligence assistant for LoRRI.ai — India's first AI-powered logistics intelligence platform.

You help with:
- Freight rate benchmarking and cost optimisation
- Route recommendations across India and global shipping lanes
- Carrier performance comparison (VRL, TCI, Blue Dart Cargo, Gati KWE, etc.)
- Port congestion alerts and delay predictions
- Customs and documentation guidance
- ESG / Scope 3 emissions tracking for freight
- Supply chain risk management
- Answering questions about the USER'S OWN shipments using the data provided to you

Key LoRRI facts: 2,000+ carrier network, 32% avg cost savings, 98% on-time delivery, 750+ Indian districts covered, 180+ ports monitored globally.

RULES:
- When asked about "my shipments", "my orders", "my containers" — use the SHIPMENT DATA provided below to answer specifically and accurately.
- If asked to navigate or open pages — say you can't do that but offer to help with the relevant data instead.
- Keep responses concise unless the user asks for detail.
- Always use ₹ for Indian Rupees.
- Be confident, data-driven, and actionable.
- If no shipment data is available, tell the user they have no shipments yet and suggest creating one.`

// ── POST /api/ai/chat ─────────────────────────────────────
router.post("/chat", requireAuth, async (req, res) => {
  const start = Date.now()
  try {
    const { message, shipment_context } = req.body
    if (!message) return res.status(400).json({ error: "Message is required" })

    log.info(`AI Chat  [${req.user.email || req.user.id}]`)
    log.dim(`User: "${message.slice(0, 80)}${message.length > 80 ? "…" : ""}"`)

    // Load chat history + live shipment data in parallel
    const [historyResult, liveContext] = await Promise.all([
      supabaseAdmin
        .from("chat_history")
        .select("role, content")
        .eq("user_id", req.user.id)
        .order("created_at", { ascending: false })
        .limit(20),
      getUserShipmentContext(req.user.id),
    ])

    const pastMessages = (historyResult.data || []).reverse()
    log.dim(`History: ${pastMessages.length} messages · Shipments: ${liveContext?.total ?? 0}`)

    // Build system prompt with live data injected
    let systemPrompt = BASE_SYSTEM_PROMPT

    const context = shipment_context || liveContext
    if (context) {
      systemPrompt += `\n\n━━ USER'S LIVE SHIPMENT DATA ━━\n`
      systemPrompt += `Total shipments: ${context.total}\n`
      systemPrompt += `In Transit: ${context.active} | Pending: ${context.pending} | Delivered: ${context.delivered} | Delayed: ${context.delayed}\n\n`
      systemPrompt += `Shipment details:\n`
      context.shipments?.forEach(s => {
        systemPrompt += `• ${s.id} — ${s.status.toUpperCase()} | ${s.route} | ${s.mode} | Carrier: ${s.carrier} | ETA: ${s.eta} | Cargo: ${s.cargo} ${s.weight}\n`
      })
      systemPrompt += `\nUse this data to answer questions about the user's shipments accurately.`
    } else {
      systemPrompt += `\n\nUSER SHIPMENT DATA: No shipments found for this user yet.`
    }

    const messages = [...pastMessages, { role: "user", content: message }]
    const reply = await chatGemini(messages, systemPrompt)

    const ms = Date.now() - start
    log.ok(`AI replied in ${ms}ms`)
    log.dim(`Reply: "${reply.slice(0, 80)}${reply.length > 80 ? "…" : ""}"`)

    // Save to DB — non-blocking
    supabaseAdmin.from("chat_history").insert([
      { user_id: req.user.id, role: "user",      content: message },
      { user_id: req.user.id, role: "assistant", content: reply   },
    ]).then(() => log.dim("Chat saved to DB"))
      .catch(e => log.warn(`DB save failed: ${e.message}`))

    res.json({ reply })

  } catch (err) {
    log.err(`AI chat error: ${err.message}`)
    console.error(err)
    res.status(500).json({ error: "AI service unavailable", detail: err.message })
  }
})

// ── GET /api/ai/chat/history ──────────────────────────────
router.get("/chat/history", requireAuth, async (req, res) => {
  try {
    log.info(`Chat history [${req.user.email || req.user.id}]`)
    const { data, error } = await supabaseAdmin
      .from("chat_history")
      .select("*")
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: true })
      .limit(100)

    if (error) return res.status(400).json({ error: error.message })
    log.ok(`Returned ${data.length} messages`)
    res.json({ history: data })
  } catch (err) {
    log.err(`Chat history error: ${err.message}`)
    res.status(500).json({ error: "Internal server error" })
  }
})

// ── DELETE /api/ai/chat/history ───────────────────────────
router.delete("/chat/history", requireAuth, async (req, res) => {
  try {
    log.warn(`Clearing chat history [${req.user.email || req.user.id}]`)
    await supabaseAdmin.from("chat_history").delete().eq("user_id", req.user.id)
    log.ok("Chat history cleared")
    res.json({ message: "Chat history cleared" })
  } catch (err) {
    log.err(`Clear history error: ${err.message}`)
    res.status(500).json({ error: "Internal server error" })
  }
})

// ── POST /api/ai/route ────────────────────────────────────
router.post("/route", requireAuth, async (req, res) => {
  const start = Date.now()
  try {
    const { origin, destination, cargo_type, weight, transport_mode, priority } = req.body
    log.info(`AI Route  ${origin} → ${destination}  [${cargo_type}, ${weight}kg]`)

    const prompt = `Generate 2 AI-optimized freight route recommendations for:
Origin: ${origin}, Destination: ${destination}, Cargo: ${cargo_type} ${weight}kg
Mode: ${transport_mode || "any"}, Priority: ${priority || "cost"}

Return ONLY valid JSON, no markdown:
{"routes":[{"id":"ai-1","name":"string","tag":"AI Recommended","carrier":"string","mode":"road","duration":"2 days","price":42500,"currency":"INR","savings_pct":18,"on_time_pct":97,"co2":245,"highlights":["h1","h2"]}]}`

    const text   = await askGemini(prompt)
    const clean  = text.replace(/```json|```/g, "").trim()
    const parsed = JSON.parse(clean)

    log.ok(`Route generated in ${Date.now() - start}ms`)
    res.json(parsed)
  } catch (err) {
    log.err(`AI route error: ${err.message}`)
    console.error(err)
    res.status(500).json({ error: "Route recommendation unavailable" })
  }
})


// ── POST /api/ai/company/chat ─────────────────────────────
// Company portal AI — uses passed context (all shipments, not user-filtered)
router.post("/company/chat", requireAuth, async (req, res) => {
  const start = Date.now()
  try {
    const { message, context } = req.body
    if (!message) return res.status(400).json({ error: "Message is required" })

    log.info(`Company AI Chat  [${req.user.email}]`)
    log.dim(`User: "${message.slice(0, 80)}${message.length > 80 ? "…" : ""}"`)

    // Build system prompt with full ops context
    let systemPrompt = `You are LoRRI OPS AI, an operations assistant for LoRRI.ai company staff.
You have full access to ALL customer shipments and cancellation requests.
You can take actions: update shipment status, approve/reject cancellations, assign carriers, flag delays.

When taking an action, respond with JSON:
{
  "message": "Human readable response",
  "action": {
    "type": "status_update" | "approve_cancel" | "reject_cancel" | "assign_carrier" | "flag_delay" | "none",
    "shipment_id": "tracking number or uuid",
    "cancellation_id": "uuid if applicable",
    "status": "pending|in_transit|delivered|cancelled|delayed",
    "carrier": "carrier name if assigning",
    "reason": "reason if rejecting"
  }
}

Status progression: pending → in_transit → delivered
"Move to next stage" means: pending→in_transit, in_transit→delivered

If no action needed, set action.type to "none" and just return the message as plain text.
Always use tracking numbers (SHP-XXXX) to refer to shipments.`

    if (context?.shipments?.length > 0) {
      systemPrompt += `

━━ ALL SHIPMENTS (${context.shipments.length} total) ━━
`
      context.shipments.forEach(s => {
        systemPrompt += `• ${s.tracking_number || s.id} — ${(s.status || "unknown").toUpperCase()} | ${s.route || `${s.origin_city}→${s.dest_city}`} | Customer: ${s.customer || "—"} | Carrier: ${s.carrier || "—"} | ETA: ${s.eta || "—"} | UUID: ${s.uuid || s.id}
`
      })
    } else {
      systemPrompt += `

No shipments found.`
    }

    if (context?.cancellations?.length > 0) {
      systemPrompt += `

━━ CANCELLATION REQUESTS (${context.cancellations.length} total) ━━
`
      context.cancellations.forEach(c => {
        systemPrompt += `• ${c.tracking_number || c.id} — ${(c.status || "pending").toUpperCase()} | Customer: ${c.customer || "—"} | Reason: ${c.reason || "—"} | UUID: ${c.id}
`
      })
    }

    const messages = [{ role: "user", content: message }]
    const reply = await chatGemini(messages, systemPrompt)

    log.ok(`Company AI replied in ${Date.now() - start}ms`)
    res.json({ reply })

  } catch (err) {
    log.err(`Company AI error: ${err.message}`)
    res.status(500).json({ error: "AI service unavailable", detail: err.message })
  }
})

export default router