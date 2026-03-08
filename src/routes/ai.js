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
      active:     shipments.filter(s => s.status === "in_transit").length,
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
// AI provides route names, carriers, highlights & reasoning.
// All pricing/transit is computed client-side with real NITI Aayog rates.
router.post("/route", requireAuth, async (req, res) => {
  const start = Date.now()
  try {
    const { origin, destination, cargo_type, weight, transport_mode, priority } = req.body
    log.info(`AI Route  ${origin} → ${destination}  [${cargo_type}, ${weight}kg]`)

    const systemPrompt = `You are a freight logistics expert for India. Always respond with ONLY a JSON object. No explanation. No markdown. No text before or after the JSON.`

    const prompt = `Shipment: ${origin} → ${destination}
Cargo: ${cargo_type}, ${weight}kg
Mode: ${transport_mode || "road"}
Priority: ${priority || "balanced"}

Give me 2 different route options. Use real Indian carriers and highway names.
Route 1 should be the fastest/most reliable option.
Route 2 should be a different corridor or carrier (cost-optimized, multi-modal, or alternate highway).

Respond with ONLY this JSON (fill in the angle bracket fields):
{"routes":[{"name":"<highway or corridor name, e.g. NH48 Express>","carrier":"<real Indian carrier>","highlights":["<3 to 5 word feature>","<3 to 5 word feature>","<3 to 5 word feature>"],"on_time_pct":<85 to 98>},{"name":"<different route name>","carrier":"<different real Indian carrier>","highlights":["<3 to 5 word feature>","<3 to 5 word feature>","<3 to 5 word feature>"],"on_time_pct":<82 to 95>}]}`

    const text  = await askGemini(prompt, systemPrompt)
    const clean = text.replace(/```json|```/g, "").trim()
    const jsonMatch = clean.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error("No JSON in response")

    const parsed = JSON.parse(jsonMatch[0])
    if (!Array.isArray(parsed?.routes) || parsed.routes.length < 2) throw new Error("Bad structure")

    // Sanitize — only keep the fields we trust from AI (never price/duration)
    const safe = {
      routes: parsed.routes.slice(0, 2).map(r => ({
        name:        String(r.name        || "").slice(0, 60),
        carrier:     String(r.carrier     || "").slice(0, 60),
        highlights:  Array.isArray(r.highlights) ? r.highlights.slice(0, 5).map(h => String(h).slice(0, 50)) : [],
        on_time_pct: Math.min(99, Math.max(80, parseInt(r.on_time_pct) || 92)),
      }))
    }

    log.ok(`Route generated in ${Date.now() - start}ms`)
    res.json(safe)
  } catch (err) {
    log.warn(`AI route skipped: ${err.message}`)
    res.json({ routes: null })   // frontend uses buildRoutes() fallback — no crash
  }
})

export default router