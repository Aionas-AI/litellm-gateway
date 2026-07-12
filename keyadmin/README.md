# Tenant Key Admin UI

A single-page browser UI for managing per-tenant provider keys, served at
**`https://keys.<DOMAIN>`** (e.g. `https://keys.56.228.19.15.sslip.io`). It is the
browser front-end for the [`key-manager`](../key-manager/README.md) service and
automates the server-side key approach from [`BYOK-COMPARISON.md`](../BYOK-COMPARISON.md).

## What you can do

| Action | What happens |
| --- | --- |
| **Save key** | Stores/rotates a tenant's provider API key in AWS Secrets Manager (`litellm-gateway/tenants/<tenant>/<alias>`) |
| **Stored keys** table | Lists every tenant key's metadata — provider, model, last update. Key material is never displayed |
| **Delete** | Removes the tenant's secret |
| **Preview config** | Opens the merged `config.yaml` that would be generated (base models + one entry per tenant key) |
| **Apply config** | Writes the runtime config and restarts the gateway (~40s) so changes go live |

Saving or deleting a key does **not** change the gateway by itself — press
**Apply config** when you're done with a batch of changes.

## Form fields

| Field | Required | Example | Notes |
| --- | --- | --- | --- |
| Tenant | yes | `ibm` | Lowercase letters/digits/dashes. Becomes the model-name prefix |
| Alias | yes | `opus` | Names this key within the tenant. Gateway model = `<tenant>-<alias>` |
| Provider | yes | `anthropic` | LiteLLM provider prefix (`openai`, `anthropic`, `gemini`, `bedrock`, …) |
| Model | yes | `claude-opus-4-8` | Dropdown of common models for the chosen provider; pick **Custom…** to type any model id |
| API key | yes | `sk-ant-...` | The tenant's own key — billed to **their** account |
| Region | bedrock only | `eu-north-1` | Sets `aws_region_name` |
| API base | no | `https://...` | Sets `api_base` for custom endpoints |

After applying, the tenant's traffic is served as model **`<tenant>-<alias>`**
(e.g. `ibm-opus`). Mint them a LiteLLM virtual key scoped to exactly that model so
they can only spend on their own upstream account.

## Security model

```
Browser ──HTTPS──▶ Caddy (plain TLS proxy)
                     ▼  /api/* only
                   key-manager :9100 (never exposed publicly)
                     │  login form → POST /auth/login → HttpOnly session cookie (12h)
                     ▼
                   AWS Secrets Manager (key material)
```

- **HTTPS** — Let's Encrypt certificate on the `keys.` subdomain.
- **Login form** — the page opens with a sign-in form. Credentials
  (`KEYADMIN_USER` / `KEYADMIN_PASSWORD` in `.env`) are validated by the
  key-manager (timing-safe compare), which issues an HMAC-signed, HttpOnly,
  Secure, SameSite=Strict session cookie valid for 12 hours. Any 401 flips the
  UI back to the login screen; **Sign out** clears the session.
- **No secrets at the edge or in the browser** — Caddy holds no credentials, and
  the admin bearer token is never sent to the browser; API/CLI clients keep
  using the bearer token directly.
- **Write-only keys** — provider keys go straight to Secrets Manager; no API or UI
  path ever returns them.

## Changing the login password

On the gateway box, edit `.env` (`KEYADMIN_PASSWORD=...`), then:

```bash
docker compose up -d key-manager
```

## Files

- `index.html` — the whole UI (no build step; static file served by Caddy)
- Caddy wiring: the `keys.{$DOMAIN}` block in [`../Caddyfile`](../Caddyfile)
- API it calls: `/api/*` → [`key-manager`](../key-manager/README.md) endpoints
