import { expect, test } from "bun:test"
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda"

// config.ts reads these at import time; the static/404 routes below never touch Postgres or S3.
process.env.ADMIN_PASSWORD ??= "x"
process.env.ADMIN_SECRET ??= "x"
process.env.DATABASE_URL ??= "postgres://localhost/unused"
process.env.S3_BUCKET ??= "unused"

const lambda = await import("../src/lambda")
const handle = (event: object) => lambda.handle(event as APIGatewayProxyEventV2) as Promise<APIGatewayProxyStructuredResultV2>

test("HTTP API v2 event serves the UI as text", async () => {
  const res = await handle({
    version: "2.0",
    rawPath: "/",
    rawQueryString: "",
    headers: { host: "x.execute-api.test" },
    requestContext: { http: { method: "GET" } },
  })
  expect(res.statusCode).toBe(200)
  expect(res.isBase64Encoded).toBe(false)
  expect(res.body).toContain("Calcode Admin")
})

test("REST API v1 event maps query, method and unauthenticated admin routes", async () => {
  const res = await handle({
    httpMethod: "GET",
    path: "/admin/api/users",
    multiValueQueryStringParameters: { a: ["1"] },
    headers: { host: "x.execute-api.test" },
  })
  expect(res.statusCode).toBe(401)
  expect("multiValueHeaders" in res).toBe(true)
})

test("unknown static file is 404", async () => {
  const res = await handle({ version: "2.0", rawPath: "/nope.js", headers: {}, requestContext: { http: { method: "GET" } } })
  expect(res.statusCode).toBe(404)
})
