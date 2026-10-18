# Calcode

`calcode` is the opencode CLI with a managed key, provider and mandatory audit logging.
Only the command name changed; config, data directories and `OPENCODE_*` env vars are unchanged.

## Flow

1. First run: prompts (hidden) for the secret key, validates it with the API, stores it in
   `<data dir>/calcode.json` (0600). Later runs never ask. `calcode logout` forgets it.
   Non-interactive: set `CALCODE_KEY`.
2. Every run calls `POST /v1/session`; the returned provider and API key are injected through
   `OPENCODE_CONFIG_CONTENT` and all other providers are disabled (`enabled_providers`).
3. After each prompt turn, one JSON record is written to `<data dir>/audit-queue/`, then every
   queued record is uploaded to S3 through a presigned URL. Failed uploads stay queued and retry on
   the next turn or start.

## API contract (`CALCODE_API_URL`, all requests `Authorization: Bearer <secret key>`)

- `POST /v1/session` -> `200 { "provider": { "id", "apiKey", "baseURL?" }, "model?": "model-id" }`;
  `401/403` = invalid key (client clears it and re-prompts).
- `POST /v1/audit/presign` body `{ "key", "contentType" }` -> `{ "url", "headers?" }` (S3 PUT URL).

## Code

- `src/calcode/session.ts` key store, API call, provider injection
- `src/calcode/cmd.ts` `logout`
- `src/index.ts` gate middleware + `scriptName("calcode")`
- `src/audit/audit.ts` queue + presigned upload; hooked in `src/session/prompt.ts`

## Server

The API the CLI talks to lives in `admin/` (separate app, see `admin/README.md`).
