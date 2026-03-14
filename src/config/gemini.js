// ─────────────────────────────────────────────────────
//  LoRRI.ai  ·  config/gemini.js (FIXED)
//  OpenRouter with Multi-Model Fallback & Retry Logic
//
//  IMPROVEMENTS:
//  1. Tries multiple models (free → fallback → fallback 2)
//  2. Retry logic with exponential backoff
//  3. Better error handling
//  4. Graceful degradation
// ─────────────────────────────────────────────────────
import dotenv from "dotenv"
dotenv.config()

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY
const BASE_URL = "https://openrouter.ai/api/v1/chat/completions"

if (!OPENROUTER_API_KEY) {
  console.warn("⚠️ OPENROUTER_API_KEY is missing. AI features will not work.");
}

// ─────────────────────────────────────────────────────
//  Multi-Model Strategy
//  Try free first, fall back to reliable paid models
// ─────────────────────────────────────────────────────
const MODELS_FOR_JSON = [
  "openrouter/free",                          // Free (sometimes unreliable)
  "mistralai/mistral-7b-instruct",           // Fallback: reliable, cheap
  "meta-llama/llama-2-70b-chat",            // Fallback 2: quality
]

const MODEL_FOR_CHAT = "openrouter/auto"      // Auto-select for chat (more forgiving)

// ─────────────────────────────────────────────────────
//  callOpenRouter: Main API call with retry & fallback
// ─────────────────────────────────────────────────────
async function callOpenRouter(messages, systemPrompt = "", modelOverride = null) {
  const modelsToTry = modelOverride ? [modelOverride] : MODELS_FOR_JSON
  let lastError = null

  for (const model of modelsToTry) {
    // Try up to 3 times per model with exponential backoff
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        if (attempt === 1) {
          console.log(`🤖 AI: Trying model "${model}"`)
        } else {
          console.log(`🤖 AI: Retry ${attempt}/3 with "${model}"`)
        }

        const body = {
          model,
          messages: [
            ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
            ...messages.map(m => ({
              role: m.role === "assistant" ? "assistant" : "user",
              content: m.content,
            })),
          ],
          max_tokens: 3000,
          temperature: 0.7,
          top_p: 0.9,
          response_format: { type: "json_object" },  // Force JSON output
        }

        const res = await fetch(BASE_URL, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "http://localhost:3001",
            "X-Title": "LoRRI.ai",
          },
          body: JSON.stringify(body),
        })

        // Handle non-200 responses
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          const errorMsg = err?.error?.message || `HTTP ${res.status}`

          // 500 error: retry if not last attempt
          if (res.status === 500 && attempt < 3) {
            const backoffMs = 1000 * attempt  // 1s, 2s, 3s
            console.warn(`⚠️ Server error (500), waiting ${backoffMs}ms before retry...`)
            await new Promise(r => setTimeout(r, backoffMs))
            continue  // Retry this model
          }

          // Rate limit or other error: try next model
          console.warn(`❌ ${model} failed: ${errorMsg} (HTTP ${res.status})`)
          lastError = new Error(`${model}: ${errorMsg}`)
          break  // Try next model
        }

        // Parse response
        const data = await res.json()
        const text = data.choices?.[0]?.message?.content

        if (!text || text.trim().length === 0) {
          if (attempt < 3) {
            console.warn(`⚠️ Empty response, retrying...`)
            await new Promise(r => setTimeout(r, 500))
            continue
          }
          lastError = new Error("Empty response from model")
          break  // Try next model
        }

        // Success!
        console.log(`✅ Success with "${model}" on attempt ${attempt}`)
        return text

      } catch (err) {
        const isLastAttempt = attempt === 3
        const isLastModel = model === modelsToTry[modelsToTry.length - 1]

        if (isLastAttempt || isLastModel) {
          lastError = err
        }

        if (!isLastAttempt) {
          console.warn(`⚠️ Error on attempt ${attempt}: ${err.message}, retrying...`)
          await new Promise(r => setTimeout(r, 500 * attempt))
        } else {
          console.warn(`⚠️ Giving up on "${model}" after 3 attempts`)
        }
      }
    }
  }

  // All models exhausted
  throw lastError || new Error("All models failed to generate response")
}

// ─────────────────────────────────────────────────────
//  askGemini: For JSON-structured responses
// ─────────────────────────────────────────────────────
export async function askGemini(prompt, systemPrompt = "") {
  try {
    return await callOpenRouter([{ role: "user", content: prompt }], systemPrompt)
  } catch (err) {
    console.error("❌ AI route generation failed:", err.message)
    
    // Return sensible fallback instead of crashing
    console.log("📋 Returning fallback route recommendation...")
    return JSON.stringify({
      routes: [
        {
          id: "fallback-1",
          name: "Standard Road Freight",
          tag: "Available",
          tagColor: "blue",
          carrier: "Available Carrier",
          mode: "road",
          distanceKm: 1231,
          duration: "3 days",
          transitDays: 3,
          price: 25000,
          currency: "INR",
          savings_pct: 0,
          on_time_pct: 92,
          co2: 175,
          pros: ["Reliable carrier", "Standard delivery"],
          cons: ["Not AI-optimized"],
          highlights: ["Standard rates available"],
        }
      ],
      route_context: {
        distance_km: null,
        duration_hrs: null,
        lane_analysis: "AI analysis currently unavailable. Please try again in a moment.",
      }
    })
  }
}

// ─────────────────────────────────────────────────────
//  chatGemini: For conversational responses
// ─────────────────────────────────────────────────────
export async function chatGemini(messages, systemPrompt = "") {
  const maxRetries = 3
  let lastError = null

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`💬 Chat: Attempt ${attempt}/${maxRetries}`)

      const body = {
        model: MODEL_FOR_CHAT,  // Auto-select more forgiving model
        messages: [
          ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
          ...messages.map(m => ({
            role: m.role === "assistant" ? "assistant" : "user",
            content: m.content,
          })),
        ],
        max_tokens: 1024,
        temperature: 0.5,
        top_p: 0.9,
      }

      const res = await fetch(BASE_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "http://localhost:3001",
          "X-Title": "LoRRI.ai",
        },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        const errorMsg = err?.error?.message || `HTTP ${res.status}`

        if (res.status === 500 && attempt < maxRetries) {
          const backoffMs = 1000 * attempt
          console.warn(`⚠️ Server error, waiting ${backoffMs}ms...`)
          await new Promise(r => setTimeout(r, backoffMs))
          continue
        }

        throw new Error(`OpenRouter error ${res.status}: ${errorMsg}`)
      }

      const data = await res.json()
      const text = data.choices?.[0]?.message?.content

      if (!text) {
        if (attempt < maxRetries) {
          console.warn(`⚠️ Empty response, retrying...`)
          await new Promise(r => setTimeout(r, 1000))
          continue
        }
        throw new Error("No response content from OpenRouter")
      }

      console.log(`✅ Chat response received on attempt ${attempt}`)
      return text

    } catch (err) {
      lastError = err
      if (attempt === maxRetries) break
      console.warn(`⚠️ Attempt ${attempt} error: ${err.message}`)
    }
  }

  throw lastError || new Error("ChatGemini failed after all retries")
}

// ─────────────────────────────────────────────────────
//  Legacy exports (compatibility)
// ─────────────────────────────────────────────────────
export const geminiModel = {
  generateContent: async (prompt) => ({
    response: { text: () => askGemini(prompt) }
  })
}

export default { askGemini, chatGemini }