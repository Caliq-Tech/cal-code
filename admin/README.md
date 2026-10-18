# Calcode Admin

Standalone service that the `calcode` CLI connects to (`CALCODE_API_URL`). It does three things:

1. **Issues secret keys** to users and maps each one to a model provider + model.
2. **Serves CLI endpoints** that hand out provider credentials and S3 presigned upload URLs.
3. **Audit UI** to browse every prompt/response the CLI uploaded.

## Run

```bash
cd admin
bun install
cp .env.example .env   # fill in values
bun --env-file=.env src/server.ts   # http://localhost:8787
bun test && bunx tsc --noEmit   # tests need TEST_DATABASE_URL (disposable Postgres db)
```

Data lives in Postgres (`DATABASE_URL`); schema changes are `migrations/NNN_*.sql`, applied by
`bun run migrate` and automatically on server start. Bun loads `.env` automatically from this
directory. The S3 bucket needs a role/credentials
with `s3:PutObject` (to sign uploads), `s3:GetObject` and `s3:ListBucket` (audit UI) on the prefix.

## CLI API (Bearer = user secret key)

| Endpoint | Response |
|---|---|
| `POST /v1/session` | `{ provider: { id, apiKey, baseURL? }, model? }`; `401` if unknown/revoked |
| `POST /v1/audit/presign` `{ key }` | `{ url, headers }`; PUT the JSON body to `url` with `headers` |

The server prepends `<S3_PREFIX>user=<userId>/` to the requested key, so a user can only ever write
inside their own prefix (and `..`/absolute paths are rejected). Presigned URLs live 5 minutes and are
bound to the object key and `application/json`.

## Admin UI

Password login (`ADMIN_PASSWORD`, 12h cookie, failed-login throttle). Tabs: **Users** (create, edit,
rotate, revoke, last seen, upload counts), **Providers** (provider id, API key, optional base URL),
**Audit** (filter by user/date, open a turn to read prompt, response, tool calls, tokens).

## Security notes

- Secret keys are stored only as SHA-256 hashes; the plaintext is shown once at creation/rotation.
- Provider API keys are AES-256-GCM encrypted with a key derived from `ADMIN_SECRET`. Losing or
  changing `ADMIN_SECRET` makes stored provider keys unreadable; re-enter them.
- Put this behind HTTPS (reverse proxy). Audit records contain full prompts and file contents.
- Audit UI renders all record content as text, never HTML.
