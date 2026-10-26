import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { sql } from "./db"

const dir = path.join(import.meta.dir, "..", "migrations")

// Applies migrations/NNN_name.sql in order, each in a transaction, once. Returns the names applied.
// An advisory lock makes concurrent starts (several replicas booting) safe.
export async function migrate() {
  // Fast path for warm databases (every Lambda cold start): one read, no transaction or lock.
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql"))
  const existing = await sql`SELECT to_regclass('schema_migrations') AS t`
  if (existing[0]?.t) {
    const done = new Set((await sql`SELECT name FROM schema_migrations`).map((r: { name: string }) => r.name))
    if (files.every((f) => done.has(f))) return []
  }
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(727274)`
    await tx`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)`
    const done = new Set((await tx`SELECT name FROM schema_migrations`).map((r: { name: string }) => r.name))
    const applied: string[] = []
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      if (done.has(file)) continue
      await tx.unsafe(readFileSync(path.join(dir, file), "utf8"))
      await tx`INSERT INTO schema_migrations (name, applied_at) VALUES (${file}, ${Date.now()})`
      applied.push(file)
    }
    return applied
  })
}

// Drops only this app's tables (never the whole schema, the database may be shared).
export async function reset() {
  await sql`DROP TABLE IF EXISTS uploads, users, providers, schema_migrations CASCADE`
}

if (import.meta.main) {
  if (process.argv.includes("--reset")) {
    await reset()
    console.log("dropped calcode admin tables")
  } else {
    const applied = await migrate()
    console.log(applied.length ? `applied: ${applied.join(", ")}` : "database is up to date")
  }
  await sql.close()
}
