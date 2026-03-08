import express from "express"
import cors from "cors"
import helmet from "helmet"
import rateLimit from "express-rate-limit"
import dotenv from "dotenv"
import cancellationRoutes from "./routes/cancellations.js"
import companyAuthRoutes  from "./routes/companyAuth.js"
import authRoutes         from "./routes/routes_auth.js"
import shipmentRoutes     from "./routes/shipments.js"
import orderRoutes        from "./routes/orders.js"
import intelligenceRoutes from "./routes/intelligence.js"
import aiRoutes           from "./routes/ai.js"
import carrierRoutes      from "./routes/carrier.js"
import roiRoutes          from "./routes/roi.js"
import uploadRoutes       from "./routes/upload.js"

dotenv.config()

const app  = express()
const PORT = process.env.PORT || 3001

// ── Security ──────────────────────────────────────────────
app.use(helmet())

// ── CORS ──────────────────────────────────────────────────
app.use(cors({
  origin: [
    process.env.FRONTEND_URL,
    "http://localhost:5173",
    "http://localhost:3000",
    "https://logisticnowhack.vercel.app"
  ],
  credentials: true,
}))

// ── Rate limiting ─────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max:      100,
  message:  { error: "Too many requests, please try again later" },
})
app.use("/api", limiter)

// AI endpoints — stricter limit
const aiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max:      20,
  message:  { error: "AI rate limit exceeded, please wait" },
})
app.use("/api/ai", aiLimiter)
app.use("/api/carrier/update", aiLimiter)

// ── Body parsing ──────────────────────────────────────────
app.use(express.json({ limit: "10mb" }))
app.use(express.urlencoded({ extended: true }))

// ── Health check ──────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status:  "ok",
    service: "LoRRI.ai Backend API",
    version: "1.0.0",
    time:    new Date().toISOString(),
  })
})

app.get("/health", (req, res) => res.json({ status: "ok" }))

// ── Routes ────────────────────────────────────────────────
app.use("/api/auth",         authRoutes)
app.use("/api/shipments",    shipmentRoutes)
app.use("/api/orders",       orderRoutes)
app.use("/api/intelligence", intelligenceRoutes)
app.use("/api/ai",           aiRoutes)
app.use("/api/carrier",      carrierRoutes)
app.use("/api/roi",          roiRoutes)
app.use("/api/upload",       uploadRoutes)
app.use("/api/cancellations",  cancellationRoutes)
app.use("/api/company/auth",   companyAuthRoutes)

// ── 404 handler ───────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` })
})

// ── Global error handler ──────────────────────────────────
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err)
  res.status(500).json({ error: "Internal server error" })
})

// ── Start server ──────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
  ╔═══════════════════════════════════╗
  ║   LoRRI.ai Backend API            ║
  ║   Running on port ${PORT}            ║
  ║   http://localhost:${PORT}           ║
  ╚═══════════════════════════════════╝
  `)
})

export default app