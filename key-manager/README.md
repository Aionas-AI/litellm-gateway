# key-manager

Secured microservice that stores per-tenant, per-model provider API keys in AWS
Secrets Manager, generates the LiteLLM `config.yaml` from them, and hot-swaps the
gateway config (atomic file replace + container restart).

This automates the **server-side key** approach from
[`../BYOK-COMPARISON.md`](../BYOK-COMPARISON.md): customers hand over a provider key
once, their tokens are billed to their own account, and clients only ever use a
LiteLLM virtual key.

## Features

- REST API to upsert / read / list / delete tenant provider keys — key material goes
  straight to AWS Secrets Manager (`litellm-gateway/tenants/<tenant>/<alias>`), never
  to disk and never returned by read endpoints
- Batch config generation: merges the committed base `config.yaml` with one
  `model_name: <tenant>-<alias>` entry per stored key
- Atomic apply: writes the runtime config via tmp-file + rename, then restarts the
  LiteLLM container through the Docker socket so the new config is loaded
- Dual auth (constant-time comparisons): bearer token for API/CLI clients, and a
  login-form session cookie for the browser UI at `keys.<DOMAIN>` (Caddy proxies
  `/api/*` only; the service itself is never directly exposed)
- Structured Pino logging with `apiKey` redaction

## API

All endpoints (except `/healthz` and `/auth/login`/`logout`) require either
`Authorization: Bearer $KEY_MANAGER_ADMIN_TOKEN` (API/CLI clients) or a session
cookie from `/auth/login` (the browser UI at `keys.<DOMAIN>`).

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/healthz` | Liveness probe (open) |
| POST | `/auth/login` | Browser login (`{username,password}`) → HttpOnly session cookie (12h, open) |
| POST | `/auth/logout` | Clear the session cookie (open) |
| GET | `/auth/me` | 200 if the session/bearer is valid |
| PUT | `/tenant-keys/:tenant/:alias` | Create or rotate a tenant key |
| GET | `/tenant-keys/:tenant/:alias` | Read key metadata (never the key itself) |
| GET | `/tenant-keys?page=&limit=` | List key metadata, paginated |
| DELETE | `/tenant-keys/:tenant/:alias` | Remove a tenant key |
| GET | `/config/preview` | Render the merged config.yaml without applying |
| POST | `/config/apply` | Write runtime config + restart LiteLLM |

### Upsert a key

```bash
curl -X PUT http://localhost:9100/tenant-keys/ibm/opus \
  -H "Authorization: Bearer $KEY_MANAGER_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"provider":"anthropic","model":"claude-opus-4-8","apiKey":"sk-ant-..."}'
# 201 -> {"tenant":"ibm","alias":"opus","provider":"anthropic","model":"claude-opus-4-8",...}
```

Body fields: `provider` (LiteLLM prefix: `openai`, `anthropic`, `gemini`, `bedrock`, …),
`model` (provider model id), `apiKey`, optional `region` (Bedrock), optional `apiBase`.
Errors: 400 (validation), 401 (bad token), 404 (unknown tenant/alias on GET/DELETE).

The resulting gateway model is named `<tenant>-<alias>` (e.g. `ibm-opus`) — scope the
tenant's LiteLLM virtual key to exactly that model.

### Apply the config

```bash
curl -X POST http://localhost:9100/config/apply \
  -H "Authorization: Bearer $KEY_MANAGER_ADMIN_TOKEN"
# 200 -> {"tenantModels":3,"configPath":"/runtime/config.yaml","reloaded":true}
```

Apply is explicit (not automatic on every upsert) so several key changes can be
batched into one gateway restart. LiteLLM drops in-flight requests during the ~10s
restart window; run applies in a maintenance moment.

## Batch / cron usage

The same generate+apply path is callable without HTTP:

```bash
docker compose exec key-manager npm run apply
```

## How the pieces fit

```
PUT /tenant-keys/ibm/opus ──▶ AWS Secrets Manager  litellm-gateway/tenants/ibm/opus
POST /config/apply        ──▶ read base config.yaml (committed, no secrets)
                              + all tenant secrets
                          ──▶ /runtime/config.yaml (atomic rename, shared volume)
                          ──▶ Docker API: restart litellm container
```

The base `config.yaml` stays committed and secret-free; the merged runtime file lives
only in a Docker volume with mode 0600.

## Project structure

```
src/
  types/        plain interfaces (TenantModelKey, PaginatedResult, ...)
  schemas/      Zod validation (tenant/alias params, key body, pagination)
  lib/          logger (pino + redaction), errors, docker reloader
  middleware/   bearer auth (timing-safe)
  dal/          TenantKeyStore: Secrets Manager impl + in-memory impl for tests
  services/     tenantKey.service (CRUD), config.service (generate/apply)
  controllers/  HTTP boundary, Zod parse -> service -> response
  routes/       wiring only
  cli/          apply.ts — batch entrypoint
  app.ts        createApp(deps?) DI factory
  index.ts      port bind + crash handlers
```

## Getting started (local dev)

```bash
npm install
npm test                 # vitest, in-memory store, no AWS needed
npm run lint

# run against real AWS (uses your credentials / instance role):
export KEY_MANAGER_ADMIN_TOKEN=dev-token
export BASE_CONFIG_PATH=../config.yaml
export RUNTIME_CONFIG_PATH=/tmp/runtime-config.yaml
npm run build && npm start
```

### Environment variables

| Var | Required | Default | Purpose |
| --- | --- | --- | --- |
| `KEY_MANAGER_ADMIN_TOKEN` | yes | — | Bearer token for API clients; also keys the session HMAC |
| `KEYADMIN_USER` | yes | — | Username for the browser login form |
| `KEYADMIN_PASSWORD` | yes | — | Password for the browser login form |
| `BASE_CONFIG_PATH` | yes | — | Committed secret-free config.yaml |
| `RUNTIME_CONFIG_PATH` | yes | — | Where the merged config is written |
| `AWS_REGION` | no | `eu-north-1` | Secrets Manager region |
| `SECRET_PREFIX` | no | `litellm-gateway/tenants` | Secret name prefix |
| `DOCKER_SOCKET` | no | `/var/run/docker.sock` | Docker Engine socket |
| `LITELLM_CONTAINER` | no | `litellm-gateway-litellm-1` | Container to restart on apply |
| `PORT` | no | `9100` | Listen port |
| `LOG_LEVEL` | no | `info` | Pino level |

## Scripts

| Script | What it does |
| --- | --- |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the HTTP service |
| `npm run apply` | Batch: regenerate config + reload gateway (no HTTP) |
| `npm test` | API-level integration tests (supertest + in-memory store) |
| `npm run lint` / `lint:fix` | ESLint (airbnb + prettier) |
| `npm run format` | Prettier write |

## Stack

- Express 5 + TypeScript, layered DI factories (controller → service → DAL)
- Zod for validation, Pino for logging
- AWS SDK v3 (`@aws-sdk/client-secrets-manager`)
- Vitest + supertest for API tests
- ESLint (airbnb-base + airbnb-typescript) + Prettier
