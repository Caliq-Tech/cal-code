import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { config } from "./config"

const aesKey = createHash("sha256").update(`enc:${config.secret}`).digest()

export const hashKey = (key: string) => createHash("sha256").update(key).digest("hex")

export const newSecretKey = () => `cal_${randomBytes(24).toString("base64url")}`

export function encrypt(text: string) {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", aesKey, iv)
  const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64")
}

export function decrypt(payload: string) {
  const raw = Buffer.from(payload, "base64")
  const decipher = createDecipheriv("aes-256-gcm", aesKey, raw.subarray(0, 12))
  decipher.setAuthTag(raw.subarray(12, 28))
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8")
}

export function safeEqual(a: string, b: string) {
  const left = createHash("sha256").update(a).digest()
  const right = createHash("sha256").update(b).digest()
  return timingSafeEqual(left, right)
}

const sign = (value: string) => createHmac("sha256", `cookie:${config.secret}`).update(value).digest("base64url")

export function makeSession(ttlMs = 12 * 60 * 60 * 1000) {
  const expires = String(Date.now() + ttlMs)
  return `${expires}.${sign(expires)}`
}

export function validSession(token: string | undefined) {
  if (!token) return false
  const [expires, signature] = token.split(".")
  if (!expires || !signature || !safeEqual(signature, sign(expires))) return false
  return Number(expires) > Date.now()
}
