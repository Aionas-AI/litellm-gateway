# key-admin

Secured microservice that automates the **server-side BYOK** flow of the LiteLLM
gateway: store one provider API key per tenant per model in **AWS Secrets Manager**,
generate the gateway `config.yaml` from them, and hot-swap the running LiteLLM config.

Raw provider keys only ever exist in Secrets Manager. The generated config references
them as `os.environ/<secret-name>`, which LiteLLM resolves from Secrets Manager at
runtime — keys never land on disk or in the container environment.

## Features

- Upsert / list / delete a provider key per `(tenant, model)` pair
- Keys stored as individual AWS Secrets Manager secrets (`litellm_tenant_<tenant>_<model>`), tagged for discovery
- Batch config generation: merges the committed `config.base.yaml` with one model entry per tenant key
- One-call apply: write the generated `config.yaml` + restart the LiteLLM container
- Bearer-token auth (constant-time compare) on every endpoint except `/healthz`
- Structured Pino logging with key redaction — provider keys are never logged or echoed

## API

All endpoints (except `GET /healthz`) require `Authorization: Bearer <KEY_ADMIN_TOKEN>`.

### `PUT /tenants/:tenant/models/:model/key`

Store (or rotate) a tenant's provider key for one model.

Request:

```json
{ "litellmModel": "anthropic/claude-opus-4-8", "apiKey": "sk-ant-..." }
```

Response `201` (created) / `200` (rotated) — the key itself is never echoed back:

```json
{
  "tenant": "ibm",
  "modelAlias": "claude-opus",
  "litellmModel": "anthropic/claude-opus-4-8",
  "secretName": "litellm_tenant_ibm_claude-opus",
  "modelName": "ibm-claude-opus",
  "createdAt": "2026-07-12T10:00:00.000Z",
  "updatedAt": "2026-07-12T10:00:00.000Z"
}
```

Errors: `400` invalid slug/body, `401` bad token.

### `GET /tenants?page=1&limit=20&tenant=ibm`

Paginated list of stored keys (metadata only). `tenant` filter optional.

```json
{ "data": [ ... ], "total": 5, "totalPages": 1, "page": 1, "limit": 20 }
```

Errors: `400` invalid pagination, `401` bad token.

### `DELETE /tenants/:tenant/models/:model/key`

Deletes the secret (no recovery window). `204` on success, `404` if unknown.

### `POST /config/generate`

Dry run: returns the config YAML that *would* be applied, without touching anything.

```json
{ "yaml": "# GENERATED FILE...", "tenantModels": ["ibm-claude-opus"] }
```

### `POST /config/apply`

Generates the config, overwrites `config.yaml`, restarts the LiteLLM container.

```json
{ "tenantModels": ["ibm-claude-opus"], "configPath": "/gateway/config.yaml", "reload": "litellm restarted" }
```

Errors: `401` bad token, `500` write/restart failure (no restart happens if the write fails).

## How the generated config works

`config.base.yaml` (committed) holds the models billed to us and `general_settings`.
Apply produces `config.yaml` (gitignored, generated) by appending per-tenant entries:

```yaml
- model_name: ibm-claude-opus
  litellm_params:
    model: anthropic/claude-opus-4-8
    api_key: os.environ/litellm_tenant_ibm_claude-opus   # resolved from Secrets Manager
```

plus the LiteLLM Secrets Manager wiring (`key_management_system: aws_secret_manager`,
`hosted_keys` listing every tenant secret). LiteLLM reads those secrets directly from
AWS at startup using the EC2 instance role.

## Typical flow

```bash
HOST=https://keys.<your-domain>          # or http://localhost:9100 via SSM tunnel
TOKEN=<KEY_ADMIN_TOKEN>

# 1. Store IBM's Anthropic key for Opus
curl -X PUT "$HOST/tenants/ibm/models/claude-opus/key" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"litellmModel":"anthropic/claude-opus-4-8","apiKey":"sk-ant-..."}'

# 2. Preview the config
curl -X POST "$HOST/config/generate" -H "Authorization: Bearer $TOKEN"

# 3. Apply it (writes config.yaml + restarts litellm)
curl -X POST "$HOST/config/apply" -H "Authorization: Bearer $TOKEN"

# 4. Mint a virtual key for the tenant scoped to their model (LiteLLM API)
curl -s https://<gateway>/key/generate \
  -H "Authorization: Bearer <MASTER_KEY>" -H "Content-Type: application/json" \
  -d '{"key_alias":"ibm","models":["ibm-claude-opus"]}'
```

## Project structure

```
src/
  types/        plain interfaces (TenantModelKey, PaginatedResult, ...)
  schemas/      Zod validation (slugs, body, pagination)
  lib/          auth middleware, errors, logger, docker reloader
  dal/          TenantKeyStore (AWS Secrets Manager + in-memory), ConfigStore (fs)
  services/     tenantKey.service (CRUD), config.service (generate/apply)
  controllers/  HTTP boundary, Zod parse -> service -> response
  routes/       pure wiring
  app.ts        createApp(deps?) DI factory
  index.ts      port binding + crash logging
```

## Getting started (local dev)

```bash
cd key-admin
npm install
KEY_ADMIN_TOKEN=dev-token npm run dev
```

Environment variables:

| Var | Default | Purpose |
| --- | --- | --- |
| `KEY_ADMIN_TOKEN` | — (required) | Bearer token for all admin endpoints |
| `PORT` | `9100` | Listen port |
| `AWS_REGION` | `eu-north-1` | Secrets Manager region |
| `CONFIG_BASE_PATH` | `/gateway/config.base.yaml` | Committed base config (read) |
| `CONFIG_OUT_PATH` | `/gateway/config.yaml` | Generated config (written) |
| `LITELLM_CONTAINER` | `litellm-gateway-litellm-1` | Container restarted on apply |

In production (docker-compose) the service mounts the repo directory at `/gateway`
and the Docker socket (to restart LiteLLM). AWS credentials come from the EC2
instance role — no keys in the environment.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Watch-mode dev server (tsx) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the compiled server |
| `npm test` | Run the API test suite (Vitest + supertest) |
| `npm run lint` / `lint:fix` | ESLint (Airbnb + Prettier) |
| `npm run format` | Prettier write |

## Security notes

- The service refuses to start without `KEY_ADMIN_TOKEN`.
- Exposed via Caddy at `keys.<DOMAIN>` over HTTPS only; the token is checked with a
  constant-time compare. Treat the token like a root credential and rotate it if leaked.
- The container mounts the Docker socket to restart LiteLLM — that is host-root
  equivalent, so nothing else should ever be added to this container.
- Secrets are deleted with `ForceDeleteWithoutRecovery` — deletion is immediate and final.

## Stack

- Express 5 + TypeScript (ESM), Zod validation
- AWS SDK v3 (`@aws-sdk/client-secrets-manager`), dockerode, yaml
- Vitest + supertest, ESLint (Airbnb) + Prettier, Pino logging
