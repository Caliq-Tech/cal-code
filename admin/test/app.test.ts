import { describe, expect, test } from "bun:test"

// Needs a dedicated, disposable Postgres database: the test drops and recreates the admin tables.
const testDb = process.env.TEST_DATABASE_URL
if (!testDb) console.warn("TEST_DATABASE_URL not set, skipping admin tests")

// Fake S3 (path-style): PUT stores, GET reads, GET ?list-type=2 lists.
const objects = new Map<string, { body: string; at: Date }>()
const s3 = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    const key = decodeURIComponent(url.pathname.replace(/^\/test-bucket\/?/, ""))
    if (req.method === "PUT") {
      objects.set(key, { body: await req.text(), at: new Date() })
      return new Response("")
    }
    if (url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? ""
      const items = [...objects].filter(([k]) => k.startsWith(prefix))
      return new Response(
        `<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>${items
          .map(([k, v]) => `<Contents><Key>${k}</Key><LastModified>${v.at.toISOString()}</LastModified><Size>${v.body.length}</Size></Contents>`)
          .join("")}</ListBucketResult>`,
        { headers: { "content-type": "application/xml" } },
      )
    }
    const hit = objects.get(key)
    return hit ? new Response(hit.body) : new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 })
  },
})

Object.assign(process.env, {
  ADMIN_PASSWORD: "pw",
  ADMIN_SECRET: "test-secret-test-secret",
  DATABASE_URL: testDb ?? "",
  S3_BUCKET: "test-bucket",
  S3_PREFIX: "audit/",
  S3_ENDPOINT: `http://localhost:${s3.port}`,
  // Explicit S3_* keys win over anything admin/.env or the shell provides.
  S3_ACCESS_KEY_ID: "AKIATEST",
  S3_SECRET_ACCESS_KEY: "secret",
})
const { app } = testDb ? await import("../src/app") : ({} as typeof import("../src/app"))
const { migrate, reset } = testDb ? await import("../src/migrate") : ({} as typeof import("../src/migrate"))
if (testDb) {
  await reset()
  await migrate()
}

const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  app(new Request("http://x" + path, { method, headers: { "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined }))

describe.skipIf(!testDb)("calcode admin", () => {
  test("full flow", async () => {
    // admin auth
    expect((await call("GET", "/admin/api/users")).status).toBe(401)
    expect((await call("POST", "/admin/api/login", { password: "nope" })).status).toBe(401)
    const login = await call("POST", "/admin/api/login", { password: "pw" })
    expect(login.status).toBe(200)
    const cookie = { cookie: login.headers.get("set-cookie")!.split(";")[0]! }

    // provider + user
    const prov = await call("POST", "/admin/api/providers", { name: "Anthropic prod", providerID: "anthropic", apiKey: "sk-secret" }, cookie)
    expect(prov.status).toBe(201)
    const providerRef = ((await prov.json()) as { id: number }).id
    expect(JSON.stringify(await (await call("GET", "/admin/api/providers", undefined, cookie)).json())).not.toContain("sk-secret")
    const created = await call("POST", "/admin/api/users", { name: "Alice", providerRef, model: "claude-sonnet-4-5" }, cookie)
    const { id, secretKey } = (await created.json()) as { id: string; secretKey: string }
    expect(secretKey).toStartWith("cal_")

    // CLI: session
    expect((await call("POST", "/v1/session")).status).toBe(401)
    expect((await call("POST", "/v1/session", undefined, { authorization: "Bearer cal_wrong" })).status).toBe(401)
    const auth = { authorization: `Bearer ${secretKey}` }
    expect(await (await call("POST", "/v1/session", undefined, auth)).json()).toEqual({
      provider: { id: "anthropic", apiKey: "sk-secret" },
      model: "claude-sonnet-4-5",
    })

    // CLI: presign -> PUT -> visible in admin audit
    expect((await call("POST", "/v1/audit/presign", { key: "../evil.json" }, auth)).status).toBe(400)
    expect((await call("POST", "/v1/audit/presign", { key: "/abs.json" }, auth)).status).toBe(400)
    const key = "date=2026-10-11/session=ses_1/msg_1.json"
    const target = (await (await call("POST", "/v1/audit/presign", { key }, auth)).json()) as { url: string; headers: Record<string, string> }
    expect(decodeURIComponent(target.url)).toContain(`audit/user=${id}/${key}`)
    expect(target.url).not.toContain("checksum")
    expect(target.url).toContain("X-Amz-Signature=")
    const record = { timestamp: "t", prompt: { text: "hi <script>" }, response: { text: "yo" } }
    expect((await fetch(target.url, { method: "PUT", headers: target.headers, body: JSON.stringify(record) })).ok).toBe(true)

    const list = (await (await call("GET", `/admin/api/audit?user=${id}&date=2026-10-11`, undefined, cookie)).json()) as { key: string; session: string; user: string }[]
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ session: "ses_1", user: id })
    const got = await call("GET", `/admin/api/audit/record?key=${encodeURIComponent(list[0]!.key)}`, undefined, cookie)
    expect(await got.json()).toEqual(record)
    expect((await call("GET", `/admin/api/audit/record?key=${encodeURIComponent("other/x.json")}`, undefined, cookie)).status).toBe(400)

    // user list reflects activity; revoke blocks CLI
    const users = (await (await call("GET", "/admin/api/users", undefined, cookie)).json()) as { uploads: number; lastSeen: number }[]
    expect(users[0]).toMatchObject({ uploads: 1 })
    await call("PUT", `/admin/api/users/${id}`, { active: false }, cookie)
    expect((await call("POST", "/v1/session", undefined, auth)).status).toBe(401)
    await call("PUT", `/admin/api/users/${id}`, { active: true }, cookie)

    // rotate invalidates old key
    const rotated = (await (await call("POST", `/admin/api/users/${id}/rotate`, {}, cookie)).json()) as { secretKey: string }
    expect((await call("POST", "/v1/session", undefined, auth)).status).toBe(401)
    expect((await call("POST", "/v1/session", undefined, { authorization: `Bearer ${rotated.secretKey}` })).status).toBe(200)

    // provider in use cannot be deleted
    expect((await call("DELETE", `/admin/api/providers/${providerRef}`, undefined, cookie)).status).toBe(409)
  })
})
