# Logi_backend — LoRRI.ai Backend

Node.js / Express backend for the LoRRI.ai freight intelligence platform.

## Stack
- **Runtime**: Node.js 18+ (ESM)
- **Framework**: Express 4
- **Database**: Supabase (PostgreSQL)
- **AI**: OpenRouter (free tier — auto-selects best available model)
- **Storage**: Cloudinary (document/image uploads)

## Project Structure

```
Logi_backend/
├── server.js              # Entry point
├── config/
│   ├── supabase.js        # Supabase client (anon + service role)
│   ├── openrouter.js      # AI config — askGemini / chatGemini wrappers
│   ├── cloudinary.js      # Cloudinary config
│   └── rateLimit.js       # Rate limiter presets
├── middleware/
│   └── auth.js            # JWT verification — requireAuth
├── routes/
│   ├── auth.js            # /api/auth — signup, login, profile, preferences
│   ├── shipments.js       # /api/shipments — CRUD + stats
│   ├── carrier.js         # /api/carrier — carrier management (AI-guarded)
│   ├── carrierAuth.js     # /api/carrier/auth — carrier login
│   ├── ai.js              # /api/ai — chat, freight intelligence
│   ├── orders.js          # /api/orders — order history
│   ├── upload.js          # /api/upload — Cloudinary file upload
│   ├── roi.js             # /api/roi — ROI calculator
│   └── intelligence.js    # /api/intelligence — market data, benchmarks
└── .env.example
```

## Setup

```bash
# 1. Clone and install
git clone https://github.com/your-org/Logi_backend.git
cd Logi_backend
npm install

# 2. Configure environment
cp .env.example .env
# Fill in all values in .env

# 3. Run
npm run dev       # development (nodemon)
npm start         # production
```

## Environment Variables

See `.env.example` for all required variables.

| Variable | Description |
|---|---|
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_ANON_KEY` | Supabase anon/public key |
| `SUPABASE_SERVICE_KEY` | Supabase service role key (server-side only) |
| `OPENROUTER_API_KEY` | OpenRouter API key (free tier works) |
| `CLOUDINARY_CLOUD_NAME` | Cloudinary cloud name |
| `CLOUDINARY_API_KEY` | Cloudinary API key |
| `CLOUDINARY_API_SECRET` | Cloudinary API secret |
| `PORT` | Server port (default: 3001) |
| `FRONTEND_URL` | Frontend origin for CORS |

## Deployment (Railway / Render / Fly.io)

1. Push this repo to GitHub (`Logi_backend`)
2. Connect repo to Railway/Render
3. Set all env vars in the dashboard
4. Set start command: `npm start`
5. Set `FRONTEND_URL` to your deployed frontend URL after frontend deploy

## API Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | /health | — | Health check |
| POST | /api/auth/signup | — | Create account |
| POST | /api/auth/login | — | Login |
| GET | /api/auth/profile | JWT | Get profile |
| PATCH | /api/auth/profile | JWT | Update profile |
| GET | /api/shipments | JWT | List shipments |
| POST | /api/shipments | JWT | Create shipment |
| GET | /api/shipments/stats/summary | JWT | Stats dashboard |
| GET | /api/shipments/:id | JWT | Single shipment |
| PATCH | /api/shipments/:id | JWT | Update shipment |
| POST | /api/ai/chat | JWT | AI freight assistant |
| GET | /api/intelligence/rates | JWT | Rate benchmarks |
| POST | /api/roi/calculate | JWT | ROI calculator |
| POST | /api/upload | JWT | Upload document |