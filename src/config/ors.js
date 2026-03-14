// ─────────────────────────────────────────────────────────────────────────────
//  LoRRI.ai  ·  config/ors.js (FIXED VERSION)
//
//  OpenRouteService + LocationIQ Structured Geocoding
//  SOLUTION: Use LocationIQ STRUCTURED API for Indian industrial areas
//
//  Free tier : 2,000 req/day (ORS), 5,000 req/day (LocationIQ)
//  Sign up   : https://openrouteservice.org/dev/#/login
//  LocationIQ: https://locationiq.com/docs/structured-search
//  .env keys : ORS_API_KEY, LOCATIONIQ_API_KEY
//
//  KEY FIX: Industrial estates like "Ambattur" exist in multiple states
//  Previous: Concatenated full address string → ambiguous, returned Delhi
//  Now:      Use STRUCTURED API → explicit city/state parameters
// ─────────────────────────────────────────────────────────────────────────────

import dotenv from "dotenv"
dotenv.config()

const ORS_API_KEY      = process.env.ORS_API_KEY
const LOCATIONIQ_KEY   = process.env.LOCATIONIQ_API_KEY
const ORS_BASE         = "https://api.openrouteservice.org"
const LOCATIONIQ_BASE  = "https://us1.locationiq.com/v1"

if (!ORS_API_KEY) {
  console.warn("⚠️  ORS_API_KEY missing — distance/matrix features will be skipped.")
}
if (!LOCATIONIQ_KEY) {
  console.warn("⚠️  LOCATIONIQ_API_KEY missing — geocoding will use Nominatim (slower).")
}

// ─────────────────────────────────────────────────────────────────────────────
//  geocodeAddressStructured({ address, city, state, zip })
//
//  **PROPER SOLUTION**: Use LocationIQ STRUCTURED SEARCH API
//  Sends address components as separate parameters, not concatenated string
//  This prevents ambiguity for industrial estates like "Ambattur" (Chennai, not Delhi)
//
//  Reference: https://docs.locationiq.com/reference/search-structured
// ─────────────────────────────────────────────────────────────────────────────
export async function geocodeAddressStructured({ address, city, state, zip }) {
  if (!LOCATIONIQ_KEY) {
    throw new Error("LOCATIONIQ_API_KEY not configured for structured geocoding")
  }

  try {
    // ── Step 1: Try structured API with explicit parameters ──
    // This is the PROPER way to geocode industrial areas in India
    // LocationIQ will parse city + state correctly and won't confuse "Ambattur Chennai" with "Ambattur Delhi"

    const params = new URLSearchParams({
      key:     LOCATIONIQ_KEY,
      format:  "json",
      limit:   "1",
      countrycodes: "in",  // India only
      addressdetails: "1",
    })

    // Build structured query parameters (LocationIQ API)
    // These are sent as separate params, not concatenated
    if (address) {
      // For industrial estates, strip plot numbers: "42, Area" → "Area"
      const areaName = address.replace(/^[0-9]+[A-Za-z/\-]*[\s,]+/, "").trim()
      params.append("street", areaName)
    }
    if (city)  params.append("city",     city)
    if (state) params.append("state",    state)
    if (zip)   params.append("postalcode", zip)

    console.log(`📍 Structured search: city="${city}" state="${state}" address="${address?.substring(0,40)}..."`)

    const res = await fetch(`${LOCATIONIQ_BASE}/search.php?${params.toString()}`, {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(8000),
    })

    if (!res.ok) {
      console.warn(`LocationIQ structured API returned ${res.status}`)
      throw new Error(`HTTP ${res.status}`)
    }

    const data = await res.json()

    if (data?.[0]) {
      const lat   = parseFloat(data[0].lat)
      const lng   = parseFloat(data[0].lon)
      const label = data[0].display_name?.split(",").slice(0, 3).join(",") || city
      const confidence = data[0].importance || 0.85

      console.log(`✓ Structured geocoded: "${city}, ${state}" → [${lat}, ${lng}] (confidence: ${confidence})`)

      // Validate result is actually in the correct state
      const resultState = data[0].address?.state || ""
      if (state && !resultState.toLowerCase().includes(state.toLowerCase())) {
        console.warn(`⚠️  Result state "${resultState}" doesn't match requested "${state}" — may be wrong location`)
      }

      return {
        lat,
        lng,
        coords:     [lng, lat],
        label,
        confidence,
        locality:   city,
        region:     state || resultState,
        postalcode: zip,
        source:     "locationiq-structured",
      }
    }

    throw new Error("No results from structured API")

  } catch (err) {
    console.warn(`Structured geocoding failed: ${err.message}`)
    // Fall back to unstructured if structured fails
    return geocodeAddressUnstructured({ address, city, state, zip })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  geocodeAddressUnstructured({ address, city, state, zip })
//
//  Fallback: Try free-form query with Nominatim (slower but works globally)
// ─────────────────────────────────────────────────────────────────────────────
async function geocodeAddressUnstructured({ address, city, state, zip }) {
  try {
    // Build query string with explicit city+state to help disambiguate
    const queryParts = [address, city, state, "India"].filter(Boolean)
    const q = queryParts.join(", ")

    console.log(`📍 Unstructured fallback: "${q.substring(0, 60)}..."`)

    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1&countrycodes=in`,
      {
        headers: { "User-Agent": "LoRRI.ai/1.0" },
        signal: AbortSignal.timeout(8000),
      }
    )

    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    const data = await res.json()
    if (data?.[0]) {
      const lat = parseFloat(data[0].lat)
      const lng = parseFloat(data[0].lon)
      const label = data[0].display_name?.split(",").slice(0, 3).join(",") || city

      console.log(`✓ Nominatim geocoded: "${city}" → [${lat}, ${lng}]`)

      return {
        lat,
        lng,
        coords:     [lng, lat],
        label,
        confidence: 0.70,
        locality:   city,
        region:     state,
        postalcode: zip,
        source:     "nominatim-unstructured",
      }
    }

    throw new Error("No results from Nominatim")
  } catch (err) {
    console.error(`All geocoding methods failed: ${err.message}`)
    throw new Error(`Could not geocode "${city}": ${err.message}`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  geocodeAddress({ address, city, state, zip })
//  Public function: tries LocationIQ structured first, then falls back
// ─────────────────────────────────────────────────────────────────────────────
export async function geocodeAddress({ address, city, state, zip }) {
  if (!city) throw new Error("City is required for geocoding")

  // Try structured API if available, else unstructured
  if (LOCATIONIQ_KEY) {
    return geocodeAddressStructured({ address, city, state, zip })
  } else {
    return geocodeAddressUnstructured({ address, city, state, zip })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  getRoadDistance(originCoords, destCoords)
//
//  Uses ORS Matrix API for real HGV road distance
// ─────────────────────────────────────────────────────────────────────────────
export async function getRoadDistance(originCoords, destCoords) {
  if (!ORS_API_KEY) throw new Error("ORS_API_KEY not configured")

  const res = await fetch(`${ORS_BASE}/v2/matrix/driving-hgv`, {
    method:  "POST",
    headers: {
      "Authorization": `Bearer ${ORS_API_KEY}`,
      "Content-Type":  "application/json",
      "Accept":        "application/json",
    },
    body: JSON.stringify({
      locations: [originCoords, destCoords],
      metrics:   ["distance", "duration"],
      units:     "km",
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`ORS matrix error ${res.status}: ${err}`)
  }

  const data         = await res.json()
  const distanceKm   = Math.round(data.distances?.[0]?.[1] || 0)
  const durationSec  = data.durations?.[0]?.[1]  || 0

  // Apply real-world correction: ORS timing is optimistic
  // 1.35x accounts for traffic, rest stops, loading, border checks
  const correctedSec = durationSec * 1.35
  const durationHrs  = Math.round(correctedSec / 3600)
  const durationMins = Math.round(correctedSec / 60)

  return { distanceKm, durationHrs, durationMins }
}

// ─────────────────────────────────────────────────────────────────────────────
//  getRouteAlternatives(originCoords, destCoords)
// ─────────────────────────────────────────────────────────────────────────────
export async function getRouteAlternatives(originCoords, destCoords) {
  if (!ORS_API_KEY) return []

  try {
    const res = await fetch(`${ORS_BASE}/v2/directions/driving-hgv`, {
      method:  "POST",
      headers: {
        "Authorization": `Bearer ${ORS_API_KEY}`,
        "Content-Type":  "application/json",
        "Accept":        "application/json",
      },
      body: JSON.stringify({
        coordinates:  [originCoords, destCoords],
        instructions: false,
        geometry:     true,
        units:        "km",
      }),
    })

    if (!res.ok) {
      const err = await res.text()
      console.warn(`ORS directions error ${res.status}: ${err.slice(0, 100)}`)
      return []
    }

    const data   = await res.json()
    const routes = data.routes || []

    return routes.map((r, i) => {
      const seg        = r.segments?.[0]
      const distKm     = Math.round(r.summary?.distance || 0)
      const durationSec = r.summary?.duration || 0
      const durationHrs = Math.round((durationSec * 1.35) / 3600)
      const steps      = seg?.steps || []
      const viaPoints  = steps
        .filter(s => s.name && s.name !== "-" && s.type === 11)
        .map(s => s.name)
        .slice(0, 2)
      const viaLabel   = viaPoints.length > 0 ? `via ${viaPoints.join(" & ")}` : `Route ${i + 1}`

      return {
        index:       i,
        distanceKm:  distKm,
        durationHrs,
        label:       viaLabel,
        geometry:    r.geometry,
      }
    })
  } catch (err) {
    console.warn("getRouteAlternatives failed:", err.message)
    return []
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  geocodeAndDistance(originParts, destParts)
//
//  Main function: geocodes both addresses + gets real HGV road distance
//  Now uses STRUCTURED API for proper handling of Indian industrial areas
// ─────────────────────────────────────────────────────────────────────────────
export async function geocodeAndDistance(originParts, destParts) {
  if (!ORS_API_KEY && !LOCATIONIQ_KEY) {
    console.warn("ORS_API_KEY and LOCATIONIQ_API_KEY not set — skipping geocoding")
    return null
  }

  try {
    console.log(`\n🔄 Geocoding & Distance Calculation`)
    console.log(`   Origin: ${originParts.city || originParts.address}, ${originParts.state}`)
    console.log(`   Dest:   ${destParts.city || destParts.address}, ${destParts.state}`)

    // Use STRUCTURED geocoding for better accuracy on Indian industrial areas
    const [origin, dest] = await Promise.all([
      geocodeAddress(originParts),
      geocodeAddress(destParts),
    ])

    // Validate coordinates are within India
    const isInIndia = (lat, lng) => lat >= 8 && lat <= 35 && lng >= 68 && lng <= 97
    if (!isInIndia(origin.lat, origin.lng)) {
      throw new Error(`Origin [${origin.lat}, ${origin.lng}] is outside India bounds`)
    }
    if (!isInIndia(dest.lat, dest.lng)) {
      throw new Error(`Destination [${dest.lat}, ${dest.lng}] is outside India bounds`)
    }

    const [roadData, alternatives] = await Promise.all([
      getRoadDistance(origin.coords, dest.coords),
      getRouteAlternatives(origin.coords, dest.coords),
    ])

    const { distanceKm, durationHrs, durationMins } = roadData

    console.log(`✓ ORS: [${origin.lat.toFixed(3)}, ${origin.lng.toFixed(3)}] → [${dest.lat.toFixed(3)}, ${dest.lng.toFixed(3)}]`)
    console.log(`✓ Distance: ${distanceKm}km | Duration: ${durationHrs}hrs | Routes: ${alternatives.length}`)

    return { origin, dest, distanceKm, durationHrs, durationMins, alternatives }

  } catch (err) {
    console.error(`❌ geocodeAndDistance failed: ${err.message}`)
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  extractShipmentAddressParts(shipmentRow, type)
// ─────────────────────────────────────────────────────────────────────────────
export function extractShipmentAddressParts(shipment, type) {
  return {
    address: shipment[`${type}_address`] || null,
    city:    shipment[`${type}_city`]    || null,
    state:   shipment[`${type}_state`]   || null,
    zip:     shipment[`${type}_zip`]     || null,
  }
}

export function isOrsAvailable() {
  return Boolean(ORS_API_KEY)
}

export default {
  geocodeAddress,
  geocodeAddressStructured,
  getRoadDistance,
  geocodeAndDistance,
  extractShipmentAddressParts,
  isOrsAvailable,
}