// ─────────────────────────────────────────────────────────
//  LoRRI.ai  ·  AI Config — OpenRouter
//  Replaces Google Gemini (quota issues)
//  Free models via openrouter.ai
// ─────────────────────────────────────────────────────────
import dotenv from "dotenv"
dotenv.config()

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY
const BASE_URL = "https://openrouter.ai/api/v1/chat/completions"

// openrouter/free = official free model router, auto-selects from available free models
// Falls back gracefully — never throws "no endpoints" errors
const MODEL = "openrouter/auto"

async function callOpenRouter(messages, systemPrompt = "") {
  const body = {
    model: MODEL,
    messages: [
      ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
      ...messages.map(m => ({
        role:    m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      })),
    ],
    max_tokens: 1024,
  }

  const res = await fetch(BASE_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type":  "application/json",
      "HTTP-Referer":  "http://localhost:3001",
      "X-Title":       "LoRRI.ai",
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err?.error?.message || `OpenRouter error ${res.status}`)
  }

  const data = await res.json()
  return data.choices?.[0]?.message?.content || "No response received."
}

// Drop-in replacements — no other file needs to change
export async function askGemini(prompt, systemPrompt = "") {
  return callOpenRouter([{ role: "user", content: prompt }], systemPrompt)
}

export async function chatGemini(messages, systemPrompt = "") {
  return callOpenRouter(messages, systemPrompt)
}

// Kept for any code that imports geminiModel directly
export const geminiModel = {
  generateContent: async (prompt) => ({
    response: { text: () => askGemini(prompt) }
  })
}

export default { askGemini, chatGemini }