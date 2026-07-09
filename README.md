# LiteLLM Gateway

A standalone, stateless [LiteLLM](https://github.com/BerriAI/litellm) proxy that exposes an OpenAI-compatible HTTPS endpoint in front of AWS Bedrock. Runs as two containers (LiteLLM + Caddy for auto-TLS) on a single small EC2 instance.

## Features

- OpenAI-compatible `/v1/chat/completions` API in front of AWS Bedrock (Claude)
- Stateless: no database — a single master key is the entire auth model
- Automatic HTTPS via Caddy + Let's Encrypt
- **No domain required** — `bootstrap.sh` auto-derives a `<public-ip>.sslip.io` hostname that resolves to the box, so you get a real Let's Encrypt cert with no domain purchase (or bring your own domain)
- Bedrock access via the EC2 instance IAM role — no AWS keys stored anywhere
- Runs on a small EC2 box (**≥ 2 GB RAM** — a 1 GB `t3.micro` is too small to pull/run the image; use `t3.small` or larger)

## Architecture

```
client ──HTTPS──> [ EC2 t3.small+ ]
                   ├── Caddy   :443  (auto Let's Encrypt TLS, via sslip.io or your domain)
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
| `config.yaml` | LiteLLM model list (Bedrock) + master-key wiring |
| `docker-compose.yml` | LiteLLM + Caddy services |
| `Caddyfile` | Reverse proxy + auto-TLS for `$DOMAIN` |
| `.env.example` | Template for `DOMAIN`, `LITELLM_MASTER_KEY`, `AWS_REGION` |
| `iam-policy-bedrock.json` | IAM policy for the EC2 instance role (Bedrock invoke) |
| `bootstrap.sh` | Installs Docker + compose, auto-derives a `sslip.io` domain if none is set, and starts the gateway |

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

- Needs **≥ 2 GB RAM**, so it runs above the free tier — `t3.small` (~$15/mo) or `t3.medium` (~$30/mo). A 1 GB `t3.micro` (free tier) is too small.
- Public IPv4 addresses bill at ~$0.005/hr (~$3.60/mo) (AWS pricing since Feb 2024).
- `sslip.io` is free and needs no account; a real Let's Encrypt cert is still issued.
- Bedrock model tokens are billed per use — the gateway does not change that.

## Stack

- **Proxy**: LiteLLM (`ghcr.io/berriai/litellm`)
- **TLS / reverse proxy**: Caddy 2
- **Backend**: AWS Bedrock (Claude)
- **Host**: EC2 (Amazon Linux 2023) + Docker Compose
