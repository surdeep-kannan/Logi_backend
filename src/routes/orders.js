import express from "express"
import { supabaseAdmin } from "../config/supabase.js"
import { requireAuth } from "../middleware/auth.js"

const router = express.Router()

// ── GET /api/orders ────────────────────────────────────────
router.get("/", requireAuth, async (req, res) => {
  try {
    const {
      status, search,
      sort  = "created_at",
      dir   = "desc",       // fixed: was "order" — now matches frontend
      page  = 1,
      limit = 10,
    } = req.query

    const offset = (Number(page) - 1) * Number(limit)

    let query = supabaseAdmin
      .from("shipments")
      .select("*", { count: "exact" })
      .eq("user_id", req.user.id)
      .order(sort, { ascending: dir === "asc" })
      .range(offset, offset + Number(limit) - 1)

    // Normalise: frontend sends "in-transit", DB stores "in_transit"
    if (status && status !== "all") {
      query = query.eq("status", status.replace(/-/g, "_"))
    }

    if (search) {
      query = query.or(
        `tracking_number.ilike.%${search}%,origin_city.ilike.%${search}%,dest_city.ilike.%${search}%,carrier.ilike.%${search}%`
      )
    }

    const { data, error, count } = await query
    if (error) return res.status(400).json({ error: error.message })

    // Counts across ALL shipments (no filter/pagination)
    const { data: allRows, error: cErr } = await supabaseAdmin
      .from("shipments")
      .select("status")
      .eq("user_id", req.user.id)

    const counts = { total: 0, delivered: 0, inTransit: 0, pending: 0, delayed: 0, cancelled: 0 }
    if (!cErr && allRows) {
      counts.total = allRows.length
      for (const row of allRows) {
        if (row.status === "delivered")  counts.delivered++
        if (row.status === "in_transit") counts.inTransit++
        if (row.status === "pending")    counts.pending++
        if (row.status === "delayed")    counts.delayed++
        if (row.status === "cancelled")  counts.cancelled++
      }
    }

    res.json({
      orders: data,
      total:  count,      // top-level so frontend reads data.total directly
      counts,
      pagination: { total: count, page: Number(page), limit: Number(limit), pages: Math.ceil(count / Number(limit)) },
    })
  } catch (err) {
    console.error("Get orders error:", err)
    res.status(500).json({ error: "Internal server error" })
  }
})

// ── GET /api/orders/export ─────────────────────────────────
router.get("/export", requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("shipments")
      .select("tracking_number,status,origin_city,dest_city,carrier,transport_mode,declared_value,currency,eta,created_at")
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false })

    if (error) return res.status(400).json({ error: error.message })

    const headers = ["Tracking No","Status","From","To","Carrier","Mode","Value","Currency","ETA","Created"]
    const rows = data.map(o => [
      o.tracking_number, o.status, o.origin_city, o.dest_city,
      o.carrier, o.transport_mode, o.declared_value, o.currency,
      o.eta, new Date(o.created_at).toLocaleDateString("en-IN"),
    ])
    const csv = [headers, ...rows].map(r => r.map(v => `"${v ?? ""}"`).join(",")).join("\n")

    res.setHeader("Content-Type", "text/csv")
    res.setHeader("Content-Disposition", "attachment; filename=lorri-orders.csv")
    res.send(csv)
  } catch (err) {
    res.status(500).json({ error: "Internal server error" })
  }
})

export default router