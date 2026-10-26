import { app } from "./app"
import { migrate } from "./migrate"

import type { APIGatewayProxyEvent, APIGatewayProxyEventV2, APIGatewayProxyResult, APIGatewayProxyStructuredResultV2 } from "aws-lambda"

// Lambda custom-runtime entry (provided.al2023 + bundled bun binary, started by ../bootstrap).
// Accepts API Gateway HTTP API (v2), REST API (v1) and Function URL events.
export async function handle(
  event: APIGatewayProxyEventV2 | APIGatewayProxyEvent,
): Promise<APIGatewayProxyStructuredResultV2 | APIGatewayProxyResult> {
  const v1 = "httpMethod" in event
  const headers = new Headers(event.headers as Record<string, string>)
  if (!v1 && event.cookies?.length) headers.set("cookie", event.cookies.join("; "))

  const method = v1 ? event.httpMethod : event.requestContext.http.method
  const path = v1 ? event.path : event.rawPath
  const query = v1
    ? new URLSearchParams(
        Object.entries(event.multiValueQueryStringParameters ?? {}).flatMap(([k, vs]) => (vs ?? []).map((v) => [k, v])),
      ).toString()
    : event.rawQueryString
  const body = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, "base64") : event.body) : undefined

  const res = await app(
    new Request(`https://${headers.get("host") ?? "localhost"}${path}${query ? `?${query}` : ""}`, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : body,
    }),
  )

  const buffer = Buffer.from(await res.arrayBuffer())
  const text = /^(text\/|application\/(json|javascript)|image\/svg)/.test(res.headers.get("content-type") ?? "")
  const cookies = res.headers.getSetCookie()
  const responseHeaders = Object.fromEntries([...res.headers].filter(([name]) => name !== "set-cookie"))

  return {
    statusCode: res.status,
    headers: responseHeaders,
    // v2 / Function URL carry cookies separately; v1 needs multiValueHeaders.
    ...(v1 ? { multiValueHeaders: { "set-cookie": cookies } } : { cookies }),
    body: text ? buffer.toString("utf8") : buffer.toString("base64"),
    isBase64Encoded: !text,
  }
}

if (import.meta.main) {
  const runtime = `http://${process.env.AWS_LAMBDA_RUNTIME_API}/2018-06-01/runtime`

  // Idempotent and guarded by an advisory lock, so concurrent cold starts are safe.
  await migrate()

  while (true) {
    // keepalive: false, a frozen/thawed Lambda sandbox leaves pooled sockets dead.
    const next = await fetch(`${runtime}/invocation/next`, { keepalive: false })
    const id = next.headers.get("lambda-runtime-aws-request-id")
    const result = await handle((await next.json()) as APIGatewayProxyEventV2 | APIGatewayProxyEvent).then(
      (response) => ({ path: "response", payload: response }),
      (err: Error) => {
        console.error(err)
        return { path: "error", payload: { errorMessage: err.message, errorType: err.name } }
      },
    )
    await fetch(`${runtime}/invocation/${id}/${result.path}`, {
      method: "POST",
      body: JSON.stringify(result.payload),
      keepalive: false,
    })
  }
}
