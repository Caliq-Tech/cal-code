import { config } from "./config"

// The AWS SDK is the heaviest import; load it on first S3 use so login and the list endpoints cold-start without it.
let client: Promise<InstanceType<typeof import("@aws-sdk/client-s3").S3Client>> | undefined
function s3() {
  return (client ??= import("@aws-sdk/client-s3").then(
    (sdk) =>
      new sdk.S3Client({
        region: config.s3.region,
        credentials: config.s3.credentials,
        // Otherwise presigned PUT URLs embed a CRC32 of the empty body and S3 rejects the real upload.
        requestChecksumCalculation: "WHEN_REQUIRED",
        ...(config.s3.endpoint ? { endpoint: config.s3.endpoint, forcePathStyle: true } : {}),
      }),
  ))
}

export const userPrefix = (userID: string) => `${config.s3.prefix}user=${userID}/`

// Presigned PUT bound to one object key and content type; the client cannot write elsewhere.
export async function presignPut(objectKey: string, contentType: string) {
  const { PutObjectCommand } = await import("@aws-sdk/client-s3")
  const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner")
  return getSignedUrl(
    await s3(),
    new PutObjectCommand({ Bucket: config.s3.bucket, Key: objectKey, ContentType: contentType }),
    { expiresIn: 300 },
  )
}

export async function listObjects(prefix: string, limit = 200) {
  const { ListObjectsV2Command } = await import("@aws-sdk/client-s3")
  const client = await s3()
  const out: { key: string; size: number; lastModified: string }[] = []
  let token: string | undefined
  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: config.s3.bucket, Prefix: prefix, ContinuationToken: token }),
    )
    for (const item of page.Contents ?? [])
      if (item.Key && item.LastModified) out.push({ key: item.Key, size: item.Size ?? 0, lastModified: item.LastModified.toISOString() })
    token = page.IsTruncated ? page.NextContinuationToken : undefined
  } while (token && out.length < limit * 5)
  return out.sort((a, b) => b.lastModified.localeCompare(a.lastModified)).slice(0, limit)
}

export async function readObject(key: string) {
  const { GetObjectCommand } = await import("@aws-sdk/client-s3")
  const res = await (await s3()).send(new GetObjectCommand({ Bucket: config.s3.bucket, Key: key }))
  return (await res.Body!.transformToString()) as string
}
