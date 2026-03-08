import express from "express"
import { askGemini, chatGemini } from "../config/gemini.js"
import { supabaseAdmin } from "../config/supabase.js"
import { requireAuth } from "../middleware/auth.js"

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

    // Fetch history — skip silently if table missing or timeout
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

    // Fetch context limits
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

    // Save to DB — fire and forget
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
router.post("/route", requireAuth, async (req, res) => {
  try {
    const { origin, destination, cargo_type, weight, transport_mode, priority } = req.body

    const prompt = `Generate 2 AI-optimized freight route recommendations for:
Origin: ${origin}, Destination: ${destination}, Cargo: ${cargo_type} ${weight}kg
Mode: ${transport_mode || "any"}, Priority: ${priority || "cost"}

Return ONLY valid JSON, no markdown:
{"routes":[{"id":"ai-1","name":"string","tag":"AI Recommended","carrier":"string","mode":"road","duration":"2 days","price":42500,"currency":"INR","savings_pct":18,"on_time_pct":97,"co2":245,"highlights":["h1","h2"]}]}`

    const text = await askGemini(prompt)
    const clean = text.replace(/```json|```/g, "").trim()
    const parsed = JSON.parse(clean)
    res.json(parsed)
  } catch (err) {
    console.error("AI route error:", err.message)
    res.status(500).json({ error: "Route recommendation unavailable" })
  }
})

export default router