function required(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required env var ${name}`)
  return value
}

export const config = {
  port: Number(process.env.PORT ?? 8787),
  adminPassword: required("ADMIN_PASSWORD"),
  secret: required("ADMIN_SECRET"),
  databaseUrl: required("DATABASE_URL"),
  s3: {
    bucket: required("S3_BUCKET"),
    region: process.env.S3_REGION ?? "us-east-1",
    prefix: (process.env.S3_PREFIX ?? "calcode-audit/").replace(/^\/+/, "").replace(/\/*$/, "/"),
    endpoint: process.env.S3_ENDPOINT,
    // Explicit keys win; otherwise the AWS SDK default chain (AWS_* env, profile, role) applies.
    credentials: s3Credentials(),
  },
}

// Keys and session token must come from the same source. On Lambda, AWS_SESSION_TOKEN belongs to the
// execution role, so pairing it with static S3_* keys from .env makes S3 reject the request (InvalidToken).
// Returning undefined lets the SDK default chain use the role credentials.
function s3Credentials() {
  if (process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY)
    return {
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      sessionToken: process.env.S3_SESSION_TOKEN || undefined,
    }
  return undefined
}
