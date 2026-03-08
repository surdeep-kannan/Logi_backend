import express from "express"
import cors from "cors"
import dotenv from "dotenv"
dotenv.config()

// ── Routes ────────────────────────────────────────────────
import authRoutes        from "./routes/auth.js"
import shipmentRoutes    from "./routes/shipments.js"
import carrierRoutes     from "./routes/carrier.js"
import carrierAuthRoutes from "./routes/carrierAuth.js"
import aiRoutes          from "./routes/ai.js"
import orderRoutes       from "./routes/orders.js"
import uploadRoutes      from "./routes/upload.js"
import roiRoutes         from "./routes/roi.js"
import intelligenceRoutes from "./routes/intelligence.js"

const app  = express()
const PORT = process.env.PORT || 3001

// ── Middleware ────────────────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL || "*",
  credentials: true,
}))
app.use(express.json({ limit: "10mb" }))
app.use(express.urlencoded({ extended: true }))

// ── Health check ──────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ status: "ok", ts: new Date().toISOString() }))

// ── API routes ────────────────────────────────────────────
app.use("/api/auth",        authRoutes)
app.use("/api/shipments",   shipmentRoutes)
app.use("/api/carrier",     carrierRoutes)
app.use("/api/carrier/auth",carrierAuthRoutes)
app.use("/api/ai",          aiRoutes)
app.use("/api/orders",      orderRoutes)
app.use("/api/upload",      uploadRoutes)
app.use("/api/roi",         roiRoutes)
app.use("/api/intelligence",intelligenceRoutes)

// ── 404 handler ───────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: "Route not found" }))

// ── Error handler ─────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error(err)
  res.status(500).json({ error: err.message || "Internal server error" })
})

app.listen(PORT, () => {
  console.log(`LoRRI backend running on port ${PORT}`)
})