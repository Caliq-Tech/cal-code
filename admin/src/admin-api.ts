import { encrypt, hashKey, makeSession, newSecretKey, safeEqual, validSession } from "./crypto"
import { config } from "./config"
import { num, sql, type ProviderRow, type UserRow } from "./db"
import { listObjects, readObject, userPrefix } from "./s3"
import { randomBytes } from "node:crypto"

const json = (data: unknown, status = 200) => Response.json(data, { status })
const bad = (message: string, status = 400) => json({ error: message }, status)

function cookie(req: Request, name: string) {
  return req.headers
    .get("cookie")
    ?.split(/;\s*/)
    .find((c) => c.startsWith(name + "="))
    ?.slice(name.length + 1)
}

export function isAuthed(req: Request) {
  return validSession(cookie(req, "calcode_admin"))
}

// Global failed-login throttle: 8 failures per minute, regardless of source.
const failures: number[] = []

export async function login(req: Request) {
  const now = Date.now()
  while (failures.length && failures[0]! < now - 60_000) failures.shift()
  if (failures.length >= 8) return bad("Too many attempts, try again in a minute", 429)
  const body = (await req.json().catch(() => undefined)) as { password?: unknown } | undefined
  if (typeof body?.password !== "string" || !safeEqual(body.password, config.adminPassword)) {
    failures.push(now)
    return bad("Wrong password", 401)
  }
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      "content-type": "application/json",
      "set-cookie": `calcode_admin=${makeSession()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`,
    },
  })
}

export const logout = () =>
  new Response(JSON.stringify({ ok: true }), {
    headers: { "content-type": "application/json", "set-cookie": "calcode_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" },
  })

// ---- providers (never returns the stored API key)

const providerView = (p: ProviderRow) => ({
  id: p.id,
  name: p.name,
  providerID: p.provider_id,
  baseURL: p.base_url,
  createdAt: num(p.created_at),
})

export async function listProviders() {
  const rows = (await sql`SELECT * FROM providers ORDER BY name`) as ProviderRow[]
  return json(rows.map(providerView))
}

export async function saveProvider(req: Request, id?: number) {
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined)
  const name = str(b.name)
  const providerID = str(b.providerID)
  const apiKey = str(b.apiKey)
  const baseURL = str(b.baseURL) ?? null
  if (!name || !providerID) return bad("name and providerID are required")
  if (id === undefined) {
    if (!apiKey) return bad("apiKey is required")
    const [dup] = await sql`SELECT 1 FROM providers WHERE name = ${name}`
    if (dup) return bad("A provider with this name exists", 409)
    const [row] = await sql`
      INSERT INTO providers (name, provider_id, api_key_enc, base_url, created_at)
      VALUES (${name}, ${providerID}, ${encrypt(apiKey)}, ${baseURL}, ${Date.now()}) RETURNING id`
    return json({ id: row.id }, 201)
  }
  const [existing] = (await sql`SELECT * FROM providers WHERE id = ${id}`) as ProviderRow[]
  if (!existing) return bad("Not found", 404)
  await sql`
    UPDATE providers SET name = ${name}, provider_id = ${providerID},
      api_key_enc = ${apiKey ? encrypt(apiKey) : existing.api_key_enc}, base_url = ${baseURL}
    WHERE id = ${id}`
  return json({ ok: true })
}

export async function deleteProvider(id: number) {
  const [inUse] = await sql`SELECT 1 FROM users WHERE provider_ref = ${id}`
  if (inUse) return bad("Provider is assigned to users", 409)
  await sql`DELETE FROM providers WHERE id = ${id}`
  return json({ ok: true })
}

// ---- users / secret keys

type UserListRow = UserRow & { provider_name: string; uploads: string; last_upload: string | null }

export async function listUsers() {
  const rows = (await sql`
    SELECT u.*, p.name AS provider_name,
      (SELECT COUNT(*) FROM uploads WHERE user_id = u.id) AS uploads,
      (SELECT MAX(created_at) FROM uploads WHERE user_id = u.id) AS last_upload
    FROM users u JOIN providers p ON p.id = u.provider_ref ORDER BY u.created_at DESC`) as UserListRow[]
  return json(
    rows.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      keyHint: u.key_hint,
      providerRef: u.provider_ref,
      providerName: u.provider_name,
      model: u.model,
      active: u.active,
      createdAt: num(u.created_at),
      lastSeen: num(u.last_seen),
      uploads: Number(u.uploads),
      lastUpload: num(u.last_upload),
    })),
  )
}

function issueKey() {
  const key = newSecretKey()
  return { key, hash: hashKey(key), hint: key.slice(0, 8) + "…" + key.slice(-4) }
}

const optional = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null)

export async function createUser(req: Request) {
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const name = typeof b.name === "string" ? b.name.trim() : ""
  const providerRef = Number(b.providerRef)
  if (!name) return bad("name is required")
  const [provider] = Number.isInteger(providerRef) ? await sql`SELECT 1 FROM providers WHERE id = ${providerRef}` : []
  if (!provider) return bad("Unknown provider")
  const id = `usr_${randomBytes(6).toString("hex")}`
  const issued = issueKey()
  await sql`
    INSERT INTO users (id, name, email, key_hash, key_hint, provider_ref, model, created_at)
    VALUES (${id}, ${name}, ${optional(b.email)}, ${issued.hash}, ${issued.hint}, ${providerRef}, ${optional(b.model)}, ${Date.now()})`
  // The plaintext key is shown exactly once.
  return json({ id, secretKey: issued.key }, 201)
}

export async function updateUser(req: Request, id: string) {
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const [user] = (await sql`SELECT * FROM users WHERE id = ${id}`) as UserRow[]
  if (!user) return bad("Not found", 404)
  const providerRef = b.providerRef === undefined ? user.provider_ref : Number(b.providerRef)
  const [provider] = Number.isInteger(providerRef) ? await sql`SELECT 1 FROM providers WHERE id = ${providerRef}` : []
  if (!provider) return bad("Unknown provider")
  await sql`
    UPDATE users SET
      name = ${typeof b.name === "string" && b.name.trim() ? b.name.trim() : user.name},
      email = ${b.email === undefined ? user.email : optional(b.email)},
      provider_ref = ${providerRef},
      model = ${b.model === undefined ? user.model : optional(b.model)},
      active = ${b.active === undefined ? user.active : Boolean(b.active)}
    WHERE id = ${id}`
  return json({ ok: true })
}

export async function rotateKey(id: string) {
  const [user] = await sql`SELECT 1 FROM users WHERE id = ${id}`
  if (!user) return bad("Not found", 404)
  const issued = issueKey()
  await sql`UPDATE users SET key_hash = ${issued.hash}, key_hint = ${issued.hint} WHERE id = ${id}`
  return json({ secretKey: issued.key })
}

// ---- audit browsing (reads the S3 objects the CLI uploaded through presigned URLs)

export async function auditList(url: URL) {
  const userID = url.searchParams.get("user")
  const date = url.searchParams.get("date")
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return bad("date must be YYYY-MM-DD")
  const users = userID ? [userID] : ((await sql`SELECT id FROM users`) as { id: string }[]).map((u) => u.id)
  const lists = await Promise.all(
    users.map((u) => listObjects(userPrefix(u) + (date ? `date=${date}/` : ""), 200)),
  )
  const items = lists
    .flat()
    .sort((a, b) => b.lastModified.localeCompare(a.lastModified))
    .slice(0, 200)
    .map((o) => {
      const rest = o.key.slice(config.s3.prefix.length)
      return {
        ...o,
        user: rest.match(/^user=([^/]+)/)?.[1],
        date: rest.match(/date=([^/]+)/)?.[1],
        session: rest.match(/session=([^/]+)/)?.[1],
      }
    })
  return json(items)
}

export async function auditRecord(url: URL) {
  const key = url.searchParams.get("key") ?? ""
  if (!key.startsWith(config.s3.prefix) || key.includes("..")) return bad("Invalid key")
  const text = await readObject(key).catch(() => undefined)
  if (text === undefined) return bad("Not found", 404)
  return new Response(text, { headers: { "content-type": "application/json" } })
}
