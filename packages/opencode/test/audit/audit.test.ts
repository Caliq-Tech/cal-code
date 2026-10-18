import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { testEffect } from "../lib/effect"

const puts: { key: string; body: string }[] = []
let presignOk = false
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/v1/audit/presign") {
      if (!presignOk) return new Response("down", { status: 503 })
      const body = (await req.json()) as { key: string }
      return Response.json({ url: `${url.origin}/s3/${body.key}` })
    }
    puts.push({ key: url.pathname.slice(4), body: await req.text() })
    return new Response("ok")
  },
})
process.env.CALCODE_API_URL = `http://localhost:${server.port}`
process.env.CALCODE_KEY = "test-key"

const { AuditLog } = await import("@/audit/audit")
const it = testEffect(LayerNode.compile(LayerNode.group([AuditLog.node])))
const queue = `${Global.Path.data}/audit-queue`
const pending = () => fs.readdir(queue).catch(() => [] as string[])

describe("AuditLog", () => {
  it.instance("queues when the API is down and uploads on the next turn", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => fs.rm(queue, { recursive: true, force: true }))
      const audit = yield* AuditLog.Service
      yield* audit.logTurn({ sessionID: "ses_a", promptText: "first", responseText: "r1" })
      expect(yield* Effect.promise(pending)).toHaveLength(1)
      expect(puts).toHaveLength(0)

      presignOk = true
      yield* audit.logTurn({ sessionID: "ses_a", promptText: "second", responseText: "r2" })
      expect(yield* Effect.promise(pending)).toHaveLength(0)
      expect(puts.map((p) => JSON.parse(p.body).prompt.text)).toEqual(["first", "second"])
      expect(puts[0].key).toMatch(/^date=\d{4}-\d{2}-\d{2}\/session=ses_a\//)
    }),
  )
})
