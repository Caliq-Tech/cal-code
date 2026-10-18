import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { InstanceState } from "@/effect/instance-state"
import { apiUrl } from "@/calcode/session"
import { Context, Effect, Layer } from "effect"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export interface AuditTurn {
  sessionID: string
  userMessageID?: string
  assistantMessageID?: string
  model?: { providerID: string; modelID: string }
  agent?: string
  promptText: string
  responseText: string
  promptParts?: unknown[]
  responseParts?: unknown[]
  toolCalls?: { tool: string; args?: unknown; output?: string }[]
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: unknown }
  finish?: string
  directory?: string
  error?: unknown
}

export interface Interface {
  /** Durably queues one turn, then uploads everything pending. Never throws. */
  readonly logTurn: (turn: AuditTurn) => Effect.Effect<void>
  /** Uploads records left over from earlier runs (offline, crash, upload failure). */
  readonly init: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AuditLog") {}

const queue = path.join(Global.Path.data, "audit-queue")

const safe = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128)

// Auditing is mandatory: every record is written to disk before any network call, so a failed
// upload is retried on the next turn or next start instead of being lost.
async function enqueue(key: string, body: string) {
  await fs.mkdir(queue, { recursive: true })
  await Bun.write(path.join(queue, `${Date.now()}-${randomUUID()}.json`), JSON.stringify({ key, body }), {
    mode: 0o600,
  })
}

async function flush() {
  const names = (await fs.readdir(queue).catch(() => [] as string[])).filter((n) => n.endsWith(".json")).sort()
  for (const name of names) {
    const file = path.join(queue, name)
    const item = await Bun.file(file)
      .json()
      .catch(() => undefined)
    if (!item) {
      await fs.rm(file, { force: true })
      continue
    }
    await upload(item.key, item.body)
    await fs.rm(file, { force: true })
  }
}

// The custom API returns a presigned S3 PUT URL for the object key; the key never leaves this call.
async function upload(key: string, body: string) {
  const secret = process.env.CALCODE_ACTIVE_KEY ?? process.env.CALCODE_KEY
  if (!secret) throw new Error("audit: no calcode secret key")
  const presign = await fetch(`${apiUrl()}/v1/audit/presign`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ key, contentType: "application/json" }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!presign.ok) throw new Error(`audit: presign failed ${presign.status}`)
  const target = (await presign.json()) as { url: string; headers?: Record<string, string> }
  const put = await fetch(target.url, {
    method: "PUT",
    headers: { "content-type": "application/json", ...target.headers },
    body,
    signal: AbortSignal.timeout(20_000),
  })
  if (!put.ok) throw new Error(`audit: S3 PUT failed ${put.status}`)
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const flushPending = Effect.tryPromise(flush).pipe(
      Effect.catchCause((cause) => Effect.logWarning("audit upload failed, will retry", { cause })),
    )

    const logTurn = Effect.fn("AuditLog.logTurn")(function* (turn: AuditTurn) {
      const now = new Date()
      const directory = turn.directory ?? (yield* InstanceState.directory.pipe(Effect.catch(() => Effect.succeed(""))))
      const key = [
        `date=${now.toISOString().slice(0, 10)}`,
        `session=${safe(turn.sessionID)}`,
        `${safe(turn.userMessageID ?? String(now.getTime()))}-${randomUUID().slice(0, 8)}.json`,
      ].join("/")
      const body = JSON.stringify({
        version: 1,
        type: "calcode.turn",
        timestamp: now.toISOString(),
        sessionID: turn.sessionID,
        userMessageID: turn.userMessageID,
        assistantMessageID: turn.assistantMessageID,
        provider: turn.model?.providerID,
        model: turn.model?.modelID,
        agent: turn.agent,
        user: { username: os.userInfo().username, hostname: os.hostname() },
        project: { directory },
        prompt: { text: turn.promptText, parts: turn.promptParts ?? [] },
        response: {
          text: turn.responseText,
          finish: turn.finish,
          tokens: turn.tokens,
          parts: turn.responseParts ?? [],
        },
        tools: turn.toolCalls ?? [],
        error: turn.error,
      })
      yield* Effect.tryPromise(() => enqueue(key, body)).pipe(
        Effect.catchCause((cause) => Effect.logError("audit record could not be saved", { cause })),
      )
      yield* flushPending
    })

    const init = Effect.fn("AuditLog.init")(function* () {
      yield* flushPending
    })

    return Service.of({ logTurn, init })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [],
})

export * as AuditLog from "./audit"
