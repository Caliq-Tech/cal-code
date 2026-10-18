#!/usr/bin/env bun
import { $ } from "bun"
import pkg from "../package.json"
import { Script } from "@opencode-ai/script"
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

async function published(name: string, version: string) {
  return (await $`npm view ${name}@${version} version`.nothrow()).exitCode === 0
}

class RateLimited extends Error {}

async function publish(dir: string, name: string, version: string) {
  // GitHub artifact downloads can drop the executable bit, and Docker uses the
  // unpacked dist binaries directly rather than the published tarball.
  if (process.platform !== "win32") await $`chmod -R 755 .`.cwd(dir)
  if (await published(name, version)) {
    console.log(`already published ${name}@${version}`)
    return
  }
  // Tarballs left by a failed attempt would be packed into the next one (and match *.tgz below).
  for (const file of new Bun.Glob("*.tgz").scanSync({ cwd: dir })) await Bun.file(`${dir}/${file}`).delete()
  await $`bun pm pack`.cwd(dir)
  const result = await $`npm publish *.tgz --access public --tag ${Script.channel} ${process.env.DRY_RUN ? ["--dry-run"] : []}`
    .cwd(dir)
    .nothrow()
  if (result.exitCode === 0) return
  if (result.stderr.toString().includes("E429")) throw new RateLimited(name)
  throw new Error(result.stderr.toString())
}

// npm rate-limits (E429) bursts of new-package publishes. Publish one at a time, park rate-limited
// packages, keep going with the rest, then retry the parked ones after a pause.
async function publishAll(items: { dir: string; name: string; version: string }[]) {
  let pending = items
  for (let pass = 1; pending.length; pass++) {
    const limited: typeof pending = []
    for (const item of pending) {
      await publish(item.dir, item.name, item.version).catch((error) => {
        if (!(error instanceof RateLimited)) throw error
        limited.push(item)
      })
    }
    pending = limited
    if (!pending.length) return
    if (pass >= 12) throw new Error(`still rate limited: ${pending.map((x) => x.name).join(", ")}`)
    console.log(`rate limited: ${pending.map((x) => x.name).join(", ")}; retrying in 5m (pass ${pass}/12)`)
    await Bun.sleep(5 * 60_000)
  }
}

const binaries: Record<string, string> = {}
for (const filepath of new Bun.Glob("*/package.json").scanSync({ cwd: "./dist" })) {
  const pkg = await Bun.file(`./dist/${filepath}`).json()
  // dist/<pkg.name> is the main package generated below by an earlier run, not a platform binary
  if (pkg.name !== "calcode") binaries[pkg.name] = pkg.version
}
console.log("binaries", binaries)
const version = Object.values(binaries)[0]

await $`mkdir -p ./dist/${pkg.name}`
await $`mkdir -p ./dist/${pkg.name}/bin`
await $`cp ./script/postinstall.mjs ./dist/${pkg.name}/postinstall.mjs`
await Bun.file(`./dist/${pkg.name}/LICENSE`).write(await Bun.file("../../LICENSE").text())
await Bun.file(`./dist/${pkg.name}/bin/${pkg.name}.exe`).write(
  [
    `echo "Error: calcode's postinstall script was not run." >&2`,
    'echo "" >&2',
    'echo "This occurs when using --ignore-scripts during installation, or when using a" >&2',
    'echo "package manager like pnpm that does not run postinstall scripts by default." >&2',
    'echo "" >&2',
    'echo "To fix this, run the postinstall script manually:" >&2',
    `echo "  cd node_modules/calcode && node postinstall.mjs" >&2`,
    'echo "" >&2',
    `echo "Or reinstall calcode without the --ignore-scripts flag." >&2`,
    "exit 1",
    "",
  ].join("\n"),
)

await Bun.file(`./dist/${pkg.name}/package.json`).write(
  JSON.stringify(
    {
      name: "calcode",
      bin: {
        calcode: `./bin/${pkg.name}.exe`,
      },
      scripts: {
        postinstall: "node ./postinstall.mjs",
      },
      version: version,
      license: pkg.license,
      os: ["darwin", "linux", "win32"],
      cpu: ["arm64", "x64"],
      optionalDependencies: binaries,
    },
    null,
    2,
  ),
)

await publishAll(Object.entries(binaries).map(([name, version]) => ({ dir: `./dist/${name}`, name, version })))
// The main package goes last so its optionalDependencies never point at unpublished versions.
await publishAll([{ dir: `./dist/${pkg.name}`, name: "calcode", version }])
