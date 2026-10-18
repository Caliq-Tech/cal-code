import { SQL } from "bun"
import { config } from "./config"

// Bun's built-in Postgres client; no driver dependency.
export const sql = new SQL(config.databaseUrl)

// BIGINT columns come back as strings; timestamps are epoch milliseconds.
export const num = (v: unknown) => (v === null || v === undefined ? null : Number(v))

export type ProviderRow = {
  id: number
  name: string
  provider_id: string
  api_key_enc: string
  base_url: string | null
  created_at: string
}

export type UserRow = {
  id: string
  name: string
  email: string | null
  key_hash: string
  key_hint: string
  provider_ref: number
  model: string | null
  active: boolean
  created_at: string
  last_seen: string | null
}
