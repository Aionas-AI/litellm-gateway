# LiteLLM Gateway

A standalone, stateless [LiteLLM](https://github.com/BerriAI/litellm) proxy that exposes an OpenAI-compatible HTTPS endpoint in front of AWS Bedrock. Runs as two containers (LiteLLM + Caddy for auto-TLS) on a single small EC2 instance.

## Features

- OpenAI-compatible `/v1/chat/completions` API in front of AWS Bedrock (Claude)
- Master key for API auth; Admin UI, virtual keys, budgets, and spend history backed by a bundled Postgres
- Automatic HTTPS via Caddy + Let's Encrypt
- **No domain required** — `bootstrap.sh` auto-derives a `<public-ip>.sslip.io` hostname that resolves to the box, so you get a real Let's Encrypt cert with no domain purchase (or bring your own domain)
- Optional **web chat UI** at `chat.<DOMAIN>` — a static ask-a-question page; Caddy injects the API key server-side so the browser never sees it
- Bedrock access via the EC2 instance IAM role — no AWS keys stored anywhere
- **Per-tenant provider keys** via the bundled [`key-manager`](key-manager/README.md) service — customer keys live in AWS Secrets Manager, get merged into a runtime config, and the gateway reloads on apply (see [BYOK-COMPARISON.md](BYOK-COMPARISON.md))
- **Key admin browser UI** at `keys.<DOMAIN>` — login-protected (basic auth over HTTPS); Caddy swaps the login for the admin bearer token server-side
- Runs on a small EC2 box (**≥ 2 GB RAM** — a 1 GB `t3.micro` is too small to pull/run the image; use `t3.small` or larger)

## Architecture

```
client ──HTTPS──> [ EC2 t3.small+ ]
                   ├── Caddy       :443  (auto Let's Encrypt TLS, via sslip.io or your domain)
                   │     ├─ <DOMAIN>       → litellm API
                   │     ├─ chat.<DOMAIN>  → web chat UI (key injected server-side)
                   │     └─ keys.<DOMAIN>  → tenant key admin UI (basic-auth login,
                   │                         admin token injected server-side)
                   ├── litellm     :4000 ──── Bedrock (via IAM instance role)
                   ├── postgres    :5432 (Admin UI, keys, budgets, spend)
                   └── key-manager :9100 (not public — tenant keys → Secrets Manager,
                                          regenerates runtime/config.yaml, reloads litellm)
```

## Usage

Once deployed, call it exactly like the OpenAI API:

```bash
curl https://llm.example.com/v1/chat/completions \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet",
    "messages": [{"role": "user", "content": "hello"}]
  }'
```

## Connecting clients

See [CLIENTS.md](CLIENTS.md) for how to route a simple UI app, Cursor, and Claude Code through the gateway.

## Getting started

### 1. Prerequisites

- An EC2 instance running Amazon Linux 2023 with **≥ 2 GB RAM** (`t3.small` or larger; a `t3.micro` will OOM)
- An **IAM instance role** attached with the policy in `iam-policy-bedrock.json`
- Security group: allow `443` and `80` (ACME challenge) from the internet
- **A domain is optional** — leave `DOMAIN` blank to auto-use `<public-ip>.sslip.io`. To use your own, point an A record at the box's public IP.

### 2. Configure

```bash
cp .env.example .env
# edit .env: generate LITELLM_MASTER_KEY, confirm AWS_REGION.
# Leave DOMAIN blank for a domain-free sslip.io hostname, or set your own.
```

The optional `LITELLM_LICENSE` (enterprise features) is stored in AWS Secrets Manager, not in git. Pull it into `.env` at deploy time:

```bash
aws secretsmanager get-secret-value --region eu-north-1 \
  --secret-id litellm-gateway/LITELLM_LICENSE --query SecretString --output text
```

Generate a strong master key:

```bash
python3 -c "import secrets; print('sk-' + secrets.token_urlsafe(32))"
```

### 3. Launch

```bash
sudo bash bootstrap.sh
docker compose ps
```

## Files

| File | Purpose |
| --- | --- |
| `config.yaml` | Base LiteLLM model list (Bedrock) + master-key wiring — committed, secret-free |
| `runtime/config.yaml` | Generated at deploy: base + per-tenant keys (git-ignored; what LiteLLM actually loads) |
| `docker-compose.yml` | LiteLLM + Caddy + Postgres + key-manager services |
| `Caddyfile` | Reverse proxy + auto-TLS for `$DOMAIN` |
| `.env.example` | Template for `DOMAIN`, `LITELLM_MASTER_KEY`, `POSTGRES_PASSWORD`, `KEY_MANAGER_ADMIN_TOKEN`, `AWS_REGION` |
| `iam-policy-bedrock.json` | IAM policy for the EC2 instance role (Bedrock invoke) |
| `bootstrap.sh` | Installs Docker + compose, auto-derives a `sslip.io` domain if none is set, seeds the runtime config, and starts the gateway |
| `webchat/index.html` | Small web chat UI served at `chat.<DOMAIN>` |
| `key-manager/` | Tenant key-management microservice ([docs](key-manager/README.md)) |
| `keyadmin/` | Browser UI for tenant keys at `keys.<DOMAIN>`, behind a login ([docs](keyadmin/README.md)) |

## Adding models

**Shared models** (billed to this AWS account): edit the base `config.yaml`, then re-apply:

```yaml
model_list:
  - model_name: claude-sonnet
    litellm_params:
      model: bedrock/eu.anthropic.claude-sonnet-4-6
      aws_region_name: eu-north-1
```

```bash
curl -X POST http://localhost:9100/config/apply \
  -H "Authorization: Bearer $KEY_MANAGER_ADMIN_TOKEN"
```

**Per-tenant models** (billed to the customer's provider account): store their key
through the key-manager, then apply — no config edit needed:

```bash
curl -X PUT http://localhost:9100/tenant-keys/ibm/opus \
  -H "Authorization: Bearer $KEY_MANAGER_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"provider":"anthropic","model":"claude-opus-4-8","apiKey":"sk-ant-..."}'

curl -X POST http://localhost:9100/config/apply \
  -H "Authorization: Bearer $KEY_MANAGER_ADMIN_TOKEN"
# gateway now serves model "ibm-opus", billed to the tenant's key
```

See [key-manager/README.md](key-manager/README.md) for the full API.

## Cost notes

- Needs **≥ 2 GB RAM**, so it runs above the free tier — `t3.small` (~$15/mo) or `t3.medium` (~$30/mo). A 1 GB `t3.micro` (free tier) is too small.
- Public IPv4 addresses bill at ~$0.005/hr (~$3.60/mo) (AWS pricing since Feb 2024).
- `sslip.io` is free and needs no account; a real Let's Encrypt cert is still issued.
- Bedrock model tokens are billed per use — the gateway does not change that.

## Stack

- **Proxy**: LiteLLM (`ghcr.io/berriai/litellm`)
- **TLS / reverse proxy**: Caddy 2
- **Database**: Postgres 16 (Admin UI, keys, budgets, spend)
- **Backend**: AWS Bedrock (Claude)
- **Host**: EC2 (Amazon Linux 2023) + Docker Compose
