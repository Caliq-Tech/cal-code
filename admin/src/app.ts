import path from "node:path"
import * as admin from "./admin-api"
import * as client from "./client-api"

const publicDir = path.join(import.meta.dir, "..", "public")

// Single request router so tests can call app(req) without opening a port.
export async function app(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const route = `${req.method} ${url.pathname}`

  try {
    // calcode CLI
    if (route === "POST /v1/session") return await client.session(req)
    if (route === "POST /v1/audit/presign") return await client.presign(req)

    // admin UI api
    if (route === "POST /admin/api/login") return await admin.login(req)
    if (url.pathname.startsWith("/admin/api/")) {
      if (route === "POST /admin/api/logout") return admin.logout()
      if (!admin.isAuthed(req)) return Response.json({ error: "Unauthorized" }, { status: 401 })
      if (req.method !== "GET" && !req.headers.get("content-type")?.includes("application/json"))
        return Response.json({ error: "JSON required" }, { status: 415 })

      const providerID = url.pathname.match(/^\/admin\/api\/providers\/(\d+)$/)?.[1]
      const userID = url.pathname.match(/^\/admin\/api\/users\/([\w-]+)$/)?.[1]
      const rotateID = url.pathname.match(/^\/admin\/api\/users\/([\w-]+)\/rotate$/)?.[1]

      if (route === "GET /admin/api/providers") return await admin.listProviders()
      if (route === "POST /admin/api/providers") return await admin.saveProvider(req)
      if (providerID && req.method === "PUT") return await admin.saveProvider(req, Number(providerID))
      if (providerID && req.method === "DELETE") return await admin.deleteProvider(Number(providerID))
      if (route === "GET /admin/api/users") return await admin.listUsers()
      if (route === "POST /admin/api/users") return await admin.createUser(req)
      if (userID && req.method === "PUT") return await admin.updateUser(req, userID)
      if (rotateID && req.method === "POST") return await admin.rotateKey(rotateID)
      if (route === "GET /admin/api/audit") return await admin.auditList(url)
      if (route === "GET /admin/api/audit/record") return await admin.auditRecord(url)
      return Response.json({ error: "Not found" }, { status: 404 })
    }

    if (req.method === "GET") return await serveStatic(url.pathname)
    return new Response("Not found", { status: 404 })
  } catch (err) {
    console.error(err)
    return Response.json({ error: "Internal error" }, { status: 500 })
  }
}

async function serveStatic(pathname: string) {
  const file = path.join(publicDir, pathname === "/" ? "index.html" : pathname)
  if (!file.startsWith(publicDir + path.sep)) return new Response("Not found", { status: 404 })
  const f = Bun.file(file)
  if (!(await f.exists())) return new Response("Not found", { status: 404 })
  return new Response(f, { headers: { "content-type": f.type } })
}
