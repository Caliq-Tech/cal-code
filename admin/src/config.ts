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

function s3Credentials() {
  const accessKeyId = process.env.S3_ACCESS_KEY_ID ?? process.env.AWS_ACCESS_KEY_ID
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY ?? process.env.AWS_SECRET_ACCESS_KEY
  if (!accessKeyId || !secretAccessKey) return undefined
  return { accessKeyId, secretAccessKey, sessionToken: process.env.S3_SESSION_TOKEN ?? process.env.AWS_SESSION_TOKEN }
}
