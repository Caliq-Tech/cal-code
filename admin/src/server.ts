import { app } from "./app"
import { config } from "./config"
import { migrate } from "./migrate"

await migrate()

Bun.serve({ port: config.port, fetch: app })
console.log(`calcode admin listening on http://localhost:${config.port}`)
