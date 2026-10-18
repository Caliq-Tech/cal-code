import path from "path"
import * as prompts from "@clack/prompts"
import { Global } from "@opencode-ai/core/global"

// Placeholder default; override with CALCODE_API_URL until the real endpoint is fixed.
export const apiUrl = () =>
  (process.env.CALCODE_API_URL ?? "http://localhost:8787")
    .replace(/\/+$/, "")
    .replace(/\/(admin(\/api)?|v1)$/, "")

const file = path.join(Global.Path.data, "calcode.json")

type Provision = {
  provider: { id: string; apiKey: string; baseURL?: string }
  model?: string
}

export async function storedKey() {
  if (process.env.CALCODE_KEY) return process.env.CALCODE_KEY
  const saved = await Bun.file(file)
    .json()
    .catch(() => undefined)
  return typeof saved?.key === "string" ? (saved.key as string) : undefined
}

export async function saveKey(key: string) {
  await Bun.write(file, JSON.stringify({ key }), { mode: 0o600 })
}

export async function clearKey() {
  await Bun.file(file).delete().catch(() => {})
}

/**
 * Ensures a secret key exists (prompting only on first use), asks the Calcode API which provider and
 * model to use, and injects that provider into the opencode config so it is selected automatically.
 */
export async function ensure() {
  const existing = await storedKey()
  const key = existing ?? (await promptKey())
  const provision = await requestSession(key)
    .catch(async (err: Error & { status?: number }) => {
      if (err.status !== 401 && err.status !== 403) throw err
      if (process.env.CALCODE_KEY) throw err
      await clearKey()
      prompts.log.error(`${err.message}. Please enter a valid key.`)
      return requestSession(await promptKey())
    })
    .catch((err: Error) => {
      // Fail cleanly instead of surfacing as "Unexpected error" from the CLI's top-level handler.
      prompts.log.error(err.message)
      process.exit(1)
    })
  apply(provision)
}

async function promptKey() {
  if (!process.stdin.isTTY) throw new Error("No secret key. Run `calcode` interactively once, or set CALCODE_KEY.")
  const value = await prompts.password({
    message: "Enter your Calcode secret key",
    validate: (v) => (v?.trim() ? undefined : "Required"),
  })
  if (prompts.isCancel(value)) process.exit(0)
  return value.trim()
}

// Validates the key against the API and saves it only if accepted.
async function requestSession(key: string): Promise<Provision> {
  const res = await fetch(`${apiUrl()}/v1/session`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15_000),
  }).catch((cause) => {
    throw new Error(`Could not reach Calcode API: ${cause instanceof Error ? cause.message : cause}`)
  })
  if (!res.ok) {
    const reason = (await res.text().catch(() => "")).slice(0, 200)
    throw Object.assign(new Error(`${apiUrl()} rejected the key (${res.status}${reason ? `: ${reason}` : ""})`), {
      status: res.status,
    })
  }
  const body = (await res.json()) as Provision
  if (!body?.provider?.id || !body.provider.apiKey) throw new Error("Calcode API returned an invalid response")
  if (!process.env.CALCODE_KEY) await saveKey(key)
  process.env.CALCODE_ACTIVE_KEY = key
  return body
}

function apply(provision: Provision) {
  const existing = process.env.OPENCODE_CONFIG_CONTENT ? JSON.parse(process.env.OPENCODE_CONFIG_CONTENT) : {}
  const provider = provision.provider
  process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    ...existing,
    // The API decides the provider; lock out every other one.
    enabled_providers: [provider.id],
    model: provision.model ? `${provider.id}/${provision.model}` : existing.model,
    provider: {
      ...existing.provider,
      [provider.id]: {
        ...existing.provider?.[provider.id],
        options: {
          ...existing.provider?.[provider.id]?.options,
          apiKey: provider.apiKey,
          ...(provider.baseURL ? { baseURL: provider.baseURL } : {}),
        },
      },
    },
  })
}
