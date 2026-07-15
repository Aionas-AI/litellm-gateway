# LiteLLM Gateway

A multi-tenant LiteLLM gateway with dynamic per-user BYOK enrollment and adapters
for coding clients. It runs LiteLLM, Postgres, Caddy, and a small enrollment control
plane on Docker Compose.

## Highlights

- OpenAI Chat Completions and Responses plus Anthropic Messages APIs;
- LiteLLM virtual keys, budgets, spend logs, and database-backed deployments;
- customer provider credentials encrypted in Postgres with a stable salt;
- no gateway restart when a customer is added or rotates a provider key;
- one scoped virtual key per user, device, and coding client;
- `aionas-connect` detection and reversible setup for Claude Code, Codex, OpenClaw,
  and guided Cursor configuration;
- an Aionas pre-call guard that re-authorizes key-level alias targets; and
- automatic TLS through Caddy and optional `sslip.io` bootstrap.

## Architecture

```text
customer setup ──HTTPS──> keys.<DOMAIN>/api/enrollments
                              │ signed tenant/user capability
                              ▼
                         key-manager :9100
                              │ LiteLLM master key, private network only
                              ├── POST/PATCH /model/*  → encrypted Postgres row
                              └── POST /key/generate  → per-client virtual keys

coding clients ──virtual key──> <DOMAIN> ──> LiteLLM :4000 ──> provider account
```

Static shared Bedrock deployments remain in `config.yaml`. Customer deployments
are owned by LiteLLM's database and loaded into the router immediately.

## Configure

```bash
cp .env.example .env
# Generate all required secrets. Existing deployments should read the salt note below.
sudo bash bootstrap.sh
docker compose ps
```

Required secrets include `LITELLM_MASTER_KEY`, `POSTGRES_PASSWORD`,
`KEY_MANAGER_ADMIN_TOKEN`, `KEY_MANAGER_ENROLLMENT_SIGNING_KEY`, and the admin UI
password.

The EC2 instance role needs Bedrock invoke permissions for the shared models —
see [iam-policy-bedrock.json](iam-policy-bedrock.json).

Upgrading an existing v1.91 box? Follow the phased runbook in
[MIGRATION.md](MIGRATION.md) — it covers backups, the salt-key rule, smoke tests
(including the alias-guard fail-closed check), cleanup, and rollback.

Wondering whether a customer's Claude/ChatGPT/Gemini/Copilot *subscription* can
be routed through the gateway instead of an API key? See
[SUBSCRIPTIONS.md](SUBSCRIPTIONS.md) for a provider-by-provider comparison of
subscription tiers, credential types, and which LiteLLM auth methods work.

## Continuous deployment

Every push to `master` (and manual runs via the Actions tab) triggers
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml):

1. **test** — key-manager lint + Vitest suite, alias-guard policy tests, and
   `aionas-connect` tests must pass first;
2. **deploy** — the workflow assumes an AWS IAM role via GitHub OIDC (no
   long-lived keys stored in GitHub), then runs the deploy on the EC2 box over
   SSM: `git reset --hard origin/master`, `docker compose build --pull`,
   `docker compose up -d`, and fails unless LiteLLM returns to `healthy` and the
   key-manager answers `/healthz`.

Deploys are serialized by a concurrency group. The IAM role
(`litellm-gateway-github-deploy`) is restricted to the `master` branch of this
repository and can only send `AWS-RunShellScript` to the gateway instance.
Repository secrets: `AWS_DEPLOY_ROLE_ARN`, `GATEWAY_INSTANCE_ID`.

### v1.91 → v1.92 salt rule

Existing encrypted rows used the master key when no `LITELLM_SALT_KEY` was set.
For the first v1.92 rollout, set `LITELLM_SALT_KEY` to the current master key. New
installations should generate a separate stable value. Never change or lose it.

This repository keeps v1.92's legacy encryption algorithm during the reversible
upgrade window. AES-256-GCM migration is intentionally a separate operational step;
after AES values are written, rollback to v1.91 is not supported.

## Customer enrollment

An administrator can provision in the browser at `keys.<DOMAIN>`, or create a
short-lived customer setup token. The customer then runs:

```bash
export AIONAS_ENROLLMENT_TOKEN='aionas_enroll_...'
python3 aionas-connect/aionas_connect.py setup \
  --control-plane https://keys.example.com/api \
  --provider anthropic \
  --model claude-opus-4-8 \
  --model-alias claude-opus
```

See [`aionas-connect/README.md`](aionas-connect/README.md),
[`key-manager/README.md`](key-manager/README.md), and [`CLIENTS.md`](CLIENTS.md).

## Verify the gateway

```bash
curl https://llm.example.com/v1/chat/completions \
  -H "Authorization: Bearer $VIRTUAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-opus","messages":[{"role":"user","content":"hello"}]}'
```

## Repository map

| Path | Purpose |
| --- | --- |
| `config.yaml` | Static shared models and Aionas callback registration |
| `litellm/` | v1.92 image wrapper and alias-authorization extension |
| `key-manager/` | Dynamic enrollment control plane |
| `keyadmin/` | Browser provisioning UI |
| `aionas-connect/` | Customer-side detector and configuration tool |
| `CLIENTS.md` | Client protocol details and manual fallback |
| `docker-compose.yml` | LiteLLM, Postgres, key-manager, Caddy |
| `.env.example` | Environment contract |

## Validation

```bash
cd key-manager && npm ci && npm test && npm run build && npm run lint
cd ..
python3 -m unittest discover -s litellm/extensions -p 'test_*.py'
python3 -m unittest discover -s aionas-connect -p 'test_*.py'
docker compose config
```
