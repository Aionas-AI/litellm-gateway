# LiteLLM Gateway

A standalone, stateless [LiteLLM](https://github.com/BerriAI/litellm) proxy that exposes an OpenAI-compatible HTTPS endpoint in front of AWS Bedrock. Runs as two containers (LiteLLM + Caddy for auto-TLS) on a single free-tier EC2 instance.

## Features

- OpenAI-compatible `/v1/chat/completions` API in front of AWS Bedrock (Claude)
- Stateless: no database — a single master key is the entire auth model
- Automatic HTTPS via Caddy + Let's Encrypt
- Bedrock access via the EC2 instance IAM role — no AWS keys stored anywhere
- Runs on a `t3.micro` (AWS free tier, 750 hrs/mo for 12 months)

## Architecture

```
client ──HTTPS──> [ EC2 t3.micro ]
                   ├── Caddy   :443  (auto Let's Encrypt TLS)
                   └── litellm :4000 (stateless)
                         └── Bedrock (via IAM instance role)
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

## Getting started

### 1. Prerequisites

- An EC2 `t3.micro` running Amazon Linux 2023
- An **IAM instance role** attached with the policy in `iam-policy-bedrock.json`
- A **domain/subdomain** with an A record pointing at the instance's public IP
- Security group: allow `443` (and `80` for the ACME challenge) from the internet, `22` from your IP only

### 2. Configure

```bash
cp .env.example .env
# edit .env: set DOMAIN, generate LITELLM_MASTER_KEY, confirm AWS_REGION
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
| `config.yaml` | LiteLLM model list (Bedrock) + master-key wiring |
| `docker-compose.yml` | LiteLLM + Caddy services |
| `Caddyfile` | Reverse proxy + auto-TLS for `$DOMAIN` |
| `.env.example` | Template for `DOMAIN`, `LITELLM_MASTER_KEY`, `AWS_REGION` |
| `iam-policy-bedrock.json` | IAM policy for the EC2 instance role (Bedrock invoke) |
| `bootstrap.sh` | Installs Docker + compose and starts the gateway |

## Adding models

Edit `config.yaml` and restart:

```yaml
model_list:
  - model_name: claude-sonnet
    litellm_params:
      model: bedrock/eu.anthropic.claude-sonnet-4-6
      aws_region_name: eu-north-1
```

```bash
docker compose restart litellm
```

## Cost notes

- `t3.micro` is free tier for 12 months (750 hrs/mo).
- Public IPv4 addresses bill at ~$0.005/hr (~$3.60/mo) even on free-tier instances (AWS pricing since Feb 2024).
- Bedrock model tokens are billed per use — the gateway does not change that.

## Stack

- **Proxy**: LiteLLM (`ghcr.io/berriai/litellm`)
- **TLS / reverse proxy**: Caddy 2
- **Backend**: AWS Bedrock (Claude)
- **Host**: EC2 (Amazon Linux 2023) + Docker Compose
