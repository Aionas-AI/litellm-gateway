# key-manager

Control plane for dynamic, per-user BYOK enrollment. A customer submits a provider
API key once; the service stores it through LiteLLM's database-backed model API and
returns a separate, restricted virtual key for each coding client. No generated
YAML, Docker socket, or LiteLLM restart is involved.

## Flow

1. An administrator mints a short-lived capability bound to `tenantId` and `userId`.
2. `aionas-connect` submits the provider key with that capability.
3. The service creates or updates a deterministic deployment via `/model/new` or
   `PATCH /model/{id}/update`.
4. LiteLLM encrypts sensitive `litellm_params` values, including `api_key`, in
   Postgres using `LITELLM_SALT_KEY`.
5. `/key/generate` creates one `key_type=llm_api` virtual key per client. Every key
   has an explicit non-empty model allowlist, a canonical alias, expiry, optional
   budget, and tenant/user/device metadata.

## API

Admin endpoints require the session cookie or
`Authorization: Bearer $KEY_MANAGER_ADMIN_TOKEN`.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/healthz` | open | Liveness and provisioning mode |
| POST | `/auth/login` | open | Admin browser login |
| POST | `/admin/enrollments/tokens` | admin | Mint a tenant/user-scoped setup capability |
| POST | `/admin/enrollments` | admin | Provision on behalf of a user |
| GET | `/admin/enrollments/models` | admin | List Aionas-managed deployments |
| DELETE | `/admin/enrollments/models/:modelId` | admin | Delete a managed deployment |
| POST | `/enrollments` | enrollment capability | Provision a provider key and client keys |

The old `/tenant-keys/*` endpoints return `410`. `/config/preview` returns `410`,
and `/config/apply` is a no-restart compatibility no-op.

### Mint a setup capability

```bash
curl https://keys.example.com/api/admin/enrollments/tokens \
  -H "Authorization: Bearer $KEY_MANAGER_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tenantId":"acme","userId":"tamar","expiresInMinutes":15}'
```

The returned `aionas_enroll_...` token can call only the enrollment endpoint and
expires within at most 60 minutes. Tenant and user identity come from its signed
claims, never from the enrollment request body.

### Provision

```bash
curl https://keys.example.com/api/enrollments \
  -H "Authorization: Bearer $AIONAS_ENROLLMENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "credentialId":"personal-anthropic",
    "provider":"anthropic",
    "model":"claude-opus-4-8",
    "modelAlias":"claude-opus",
    "apiKey":"sk-ant-...",
    "deviceId":"tamar-macbook",
    "clients":[
      {"clientId":"claude-code","duration":"90d","maxBudget":50},
      {"clientId":"codex","duration":"90d"}
    ]
  }'
```

The response returns each raw virtual key once with `Cache-Control: no-store`. It
never returns the provider key. Repeating the same tenant/user/credential rotates
the provider key on the deterministic deployment rather than creating a duplicate.

## Alias guard

LiteLLM v1.92.0 resolves key-level aliases after its ordinary key allowlist check.
The custom `AionasAliasAuthorizationGuard` pre-call hook closes that gap for keys
whose metadata contains `aionas_managed=true`. It requires:

- a non-empty `models` list;
- both the public alias and internal deployment in that list;
- the stored alias mapping to equal the immutable metadata contract; and
- the resolved request model to equal that key's internal deployment.

Unmanaged LiteLLM keys retain upstream behavior. Tests under `litellm/extensions`
cover cross-tenant targets and modified alias mappings.

## Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `KEY_MANAGER_ADMIN_TOKEN` | yes | Admin bearer token and session-signing input |
| `KEYADMIN_USER` / `KEYADMIN_PASSWORD` | yes | Browser admin login |
| `KEY_MANAGER_ENROLLMENT_SIGNING_KEY` | yes | Separate HMAC key for short-lived setup capabilities |
| `LITELLM_MASTER_KEY` | yes | Used only by this service over the private Compose network |
| `LITELLM_INTERNAL_URL` | no | Defaults to `http://litellm:4000` |
| `PUBLIC_GATEWAY_URL` | yes | Base URL returned to client setup tools |
| `ALLOWED_CUSTOM_API_BASE_HOSTS` | no | Comma-separated exact host allowlist; empty denies custom endpoints |
| `LITELLM_ADMIN_TIMEOUT_MS` | no | Management API timeout; default 10 seconds |

## Development

```bash
npm ci
npm test
npm run build
npm run lint
```

The TypeScript tests inject a fake LiteLLM management client; they require no AWS
account or running proxy.
