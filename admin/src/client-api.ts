import { decrypt, hashKey } from "./crypto"
import { sql, type ProviderRow, type UserRow } from "./db"
import { presignPut, userPrefix } from "./s3"

// Endpoints consumed by the calcode CLI. Auth is the user's secret key as a Bearer token.

async function authenticate(req: Request): Promise<{ user: UserRow } | { error: Response }> {
  const token = req.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1]
  if (!token) return reject("missing Bearer token")
  const [user] = (await sql`SELECT * FROM users WHERE key_hash = ${hashKey(token)}`) as UserRow[]
  if (!user) return reject("unknown key", token)
  if (!user.active) return reject("key revoked", token)
  return { user }
}

// Logs a key fingerprint (never the key) so a rejected CLI can be matched to the admin's "Key" column.
function reject(reason: string, token?: string) {
  console.warn(`[auth] rejected: ${reason}${token ? ` (${token.slice(0, 8)}…${token.slice(-4)}, ${token.length} chars)` : ""}`)
  return { error: new Response(reason, { status: 401 }) }
}

export async function session(req: Request) {
  const auth = await authenticate(req)
  if ("error" in auth) return auth.error
  const user = auth.user
  const [provider] = (await sql`SELECT * FROM providers WHERE id = ${user.provider_ref}`) as ProviderRow[]
  if (!provider) return new Response("no provider assigned", { status: 403 })
  await sql`UPDATE users SET last_seen = ${Date.now()} WHERE id = ${user.id}`
  return Response.json({
    provider: {
      id: provider.provider_id,
      apiKey: decrypt(provider.api_key_enc),
      ...(provider.base_url ? { baseURL: provider.base_url } : {}),
    },
    ...(user.model ? { model: user.model } : {}),
  })
}

export async function presign(req: Request) {
  const auth = await authenticate(req)
  if ("error" in auth) return auth.error
  const user = auth.user
  const body = (await req.json().catch(() => undefined)) as { key?: unknown; contentType?: unknown } | undefined
  const key = body?.key
  // Only plain relative paths; the server prepends the per-user prefix so users cannot overwrite each other.
  if (typeof key !== "string" || key.length > 300 || !/^[A-Za-z0-9=_\-./]+$/.test(key) || key.includes(".."))
    return new Response("invalid key", { status: 400 })
  if (key.startsWith("/")) return new Response("invalid key", { status: 400 })
  const contentType = "application/json"
  const objectKey = userPrefix(user.id) + key
  const url = await presignPut(objectKey, contentType)
  await sql`INSERT INTO uploads (user_id, object_key, created_at) VALUES (${user.id}, ${objectKey}, ${Date.now()})`
  return Response.json({ url, headers: { "content-type": contentType } })
}
