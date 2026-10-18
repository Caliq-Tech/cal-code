import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { config } from "./config"

export const s3 = new S3Client({
  region: config.s3.region,
  credentials: config.s3.credentials,
  // Otherwise presigned PUT URLs embed a CRC32 of the empty body and S3 rejects the real upload.
  requestChecksumCalculation: "WHEN_REQUIRED",
  ...(config.s3.endpoint ? { endpoint: config.s3.endpoint, forcePathStyle: true } : {}),
})

export const userPrefix = (userID: string) => `${config.s3.prefix}user=${userID}/`

// Presigned PUT bound to one object key and content type; the client cannot write elsewhere.
export function presignPut(objectKey: string, contentType: string) {
  return getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: config.s3.bucket, Key: objectKey, ContentType: contentType }),
    { expiresIn: 300 },
  )
}

export async function listObjects(prefix: string, limit = 200) {
  const out: { key: string; size: number; lastModified: string }[] = []
  let token: string | undefined
  do {
    const page = await s3.send(
      new ListObjectsV2Command({ Bucket: config.s3.bucket, Prefix: prefix, ContinuationToken: token }),
    )
    for (const item of page.Contents ?? [])
      if (item.Key && item.LastModified) out.push({ key: item.Key, size: item.Size ?? 0, lastModified: item.LastModified.toISOString() })
    token = page.IsTruncated ? page.NextContinuationToken : undefined
  } while (token && out.length < limit * 5)
  return out.sort((a, b) => b.lastModified.localeCompare(a.lastModified)).slice(0, limit)
}

export async function readObject(key: string) {
  const res = await s3.send(new GetObjectCommand({ Bucket: config.s3.bucket, Key: key }))
  return (await res.Body!.transformToString()) as string
}
