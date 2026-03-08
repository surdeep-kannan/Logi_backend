import { createClient } from "@supabase/supabase-js"
import { config } from "dotenv"
config()

const supabaseUrl  = process.env.SUPABASE_URL
const anonKey      = process.env.SUPABASE_ANON_KEY
const serviceKey   = process.env.SUPABASE_SERVICE_KEY

if (!supabaseUrl)  throw new Error("SUPABASE_URL is missing from .env")
if (!anonKey)      throw new Error("SUPABASE_ANON_KEY is missing from .env")
if (!serviceKey)   throw new Error("SUPABASE_SERVICE_KEY is missing from .env")

export const supabase = createClient(supabaseUrl, anonKey)
export const supabaseAdmin = createClient(supabaseUrl, serviceKey)
