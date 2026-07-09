# POC Client — calling Claude Opus through the LiteLLM gateway

A minimal Python client that proves the full round-trip:

```
client (openai SDK) -> LiteLLM gateway -> AWS Bedrock (Claude Opus) -> gateway -> client
```

Because the gateway is OpenAI-compatible, the client is just the standard `openai`
SDK pointed at the gateway's base URL with a virtual key — no Bedrock/AWS
credentials on the client side.

## Setup

```bash
pip install -r requirements.txt
cp .env.example .env
# edit .env: set LITELLM_API_KEY to a virtual key minted on the gateway
```

Generate a scoped virtual key on the gateway (run once, with the master key):

```bash
curl -s https://56.228.19.15.sslip.io/key/generate \
  -H "Authorization: Bearer <MASTER_KEY>" -H "Content-Type: application/json" \
  -d '{"key_alias":"poc-client","models":["claude-opus"],"max_budget":5}'
```

Copy the returned `key` into `.env` as `LITELLM_API_KEY`.

## Run

```bash
python client.py                       # uses the default demo prompt
python client.py "Write a haiku about gateways"
```

## Config

| Variable | Purpose |
| --- | --- |
| `LITELLM_BASE_URL` | Gateway OpenAI endpoint (`https://<host>/v1`) |
| `LITELLM_API_KEY` | Virtual key minted on the gateway |
| `LITELLM_MODEL` | Model alias from the gateway `config.yaml` (default `claude-opus`) |
