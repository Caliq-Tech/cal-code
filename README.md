# Calcode

An AI coding agent for the terminal, with a managed key, a managed provider and mandatory audit logging.

> [!NOTE]
> Calcode is a fork of [opencode](https://github.com/anomalyco/opencode) by the opencode team. The terminal UI, agents, tools and
> configuration come from opencode. Calcode changes the command name to `calcode` and adds a managed-key
> session and an audit trail on top. It is not affiliated with or endorsed by the opencode team.

---

## How it works

Calcode is the opencode CLI behind a gate. You never configure a model provider yourself: your organisation issues you a secret key, and Calcode fetches the provider and credentials for it on every run.

1. **First run.** `calcode` prompts (input hidden) for your secret key, validates it against the Calcode API and stores it in
   `<data dir>/calcode.json` (mode `0600`). Later runs never ask again. `calcode logout` forgets the key.
   For non-interactive use, set `CALCODE_KEY`.
2. **Every run.** Calcode calls `POST /v1/session`. The returned provider, API key and optional default model are injected
   into opencode's config, and all other providers are disabled. An invalid or revoked key (`401`/`403`) is cleared and you are asked again.
3. **Every prompt turn.** After each turn, one JSON record (prompt, response, tool calls, tokens) is written to a local
   `audit-queue/` directory, then uploaded to S3 through a presigned URL. Failed uploads stay queued and are retried on the next turn or start.

```
 calcode CLI ──POST /v1/session──────▶ Calcode admin server ──▶ provider + API key + model
     │       ──POST /v1/audit/presign─▶        (admin/)        ──▶ presigned S3 PUT URL
     │
     └─ audit record ──PUT──▶ S3 (one prefix per user) ──▶ browse in the admin UI
```

Everything else behaves like opencode: config files, data directories and `OPENCODE_*` environment variables are unchanged.
See [CALCODE.md](./CALCODE.md) for the full flow and API contract.

### The admin server

The API that the CLI talks to lives in [`admin/`](./admin). It issues and revokes user keys, maps each key to a provider and model,
hands out presigned upload URLs scoped to the user's own S3 prefix, and has a web UI to browse every uploaded turn.
See [admin/README.md](./admin/README.md).

---

## Installation

```bash
curl -fsSL https://raw.githubusercontent.com/Caliq-Tech/cal-code/master/install | bash
```

To install a specific version, or from a local binary:

```bash
curl -fsSL https://raw.githubusercontent.com/Caliq-Tech/cal-code/master/install | bash -s -- --version 1.0.180
./install --binary /path/to/calcode
```

The binary is installed to `$HOME/.calcode/bin` and added to your `PATH`. Pass `--no-modify-path` to skip editing shell config files.

### Build from source

Requires [Bun](https://bun.sh).

```bash
make setup             # install deps, create admin/.env, run migrations
make calcode-install   # build a native binary and link it as `calcode` in ~/.local/bin
make calcode ARGS="run hi"   # or run straight from source
make help              # all targets
```

## Usage

```bash
calcode                # start the terminal UI in the current directory
calcode run "fix the failing tests"   # non-interactive
calcode logout         # forget the stored secret key
```

Press `Tab` to switch between the built-in agents:

- **build**: default, full-access agent for development work
- **plan**: read-only agent for analysis and code exploration. It denies file edits and asks before running bash commands.

A **general** subagent handles complex searches and multistep tasks; invoke it with `@general`.

Agents, tools, themes, keybinds and MCP servers are configured the same way as in opencode, see the
[opencode docs](https://opencode.ai/docs).

## Configuration

| Variable          | Purpose                                                              |
| ----------------- | -------------------------------------------------------------------- |
| `CALCODE_API_URL` | Base URL of the Calcode admin server                                 |
| `CALCODE_KEY`     | Secret key for non-interactive runs (skips the prompt)               |

## Repository layout

| Path                 | What it is                                                                 |
| -------------------- | -------------------------------------------------------------------------- |
| `packages/opencode`  | The CLI (forked from opencode); Calcode additions are in `src/calcode` and `src/audit` |
| `packages/tui`       | Terminal UI                                                                |
| `admin/`             | Calcode admin server: key issuing, provider mapping, audit UI              |
| `CALCODE.md`         | Detailed flow and API contract                                             |

## Credits and license

Calcode is built on [opencode](https://github.com/anomalyco/opencode), an open source AI coding agent. Thanks to the opencode
team and contributors. Both projects are released under the [MIT license](./LICENSE).
