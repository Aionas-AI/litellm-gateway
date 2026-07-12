# Routing clients through the LiteLLM gateway

How to point different clients (a simple UI app, Cursor, Claude Code, OpenClaw) at
the gateway so all model traffic flows:

```
client -> LiteLLM gateway -> AWS Bedrock -> gateway -> client
```

The client never holds AWS credentials — only the gateway URL and a virtual key.

## Gateway facts

| Thing | Value |
| --- | --- |
| Host | `https://56.228.19.15.sslip.io` (your gateway's public hostname) |
| OpenAI-compatible base URL | `https://56.228.19.15.sslip.io/v1` |
| Anthropic-compatible base URL | `https://56.228.19.15.sslip.io` (endpoint `/v1/messages`) |
| Models | `claude-opus`, `claude-sonnet` |
| Auth | `Authorization: Bearer <virtual-key>` |

Both API shapes are served by the same gateway: OpenAI clients use `/v1/chat/completions`, Anthropic clients (like Claude Code) use `/v1/messages`.

## Step 0 - Mint a virtual key (once)

Never reuse the master key in clients. Create a scoped key (needs the master key once):

```bash
curl -s https://56.228.19.15.sslip.io/key/generate \
  -H "Authorization: Bearer <MASTER_KEY>" -H "Content-Type: application/json" \
  -d '{"key_alias":"my-client","models":["claude-opus","claude-sonnet"],"max_budget":10}'
```

Copy the returned `key` (`sk-...`). Spend and usage for it show in the Admin UI at
`https://56.228.19.15.sslip.io/ui/` under Usage / Logs / Virtual Keys.

---

## 1. Simple UI app (like the one we built)

Any app that speaks the OpenAI API works — just change the base URL and key.

**Option A - key stays server-side (recommended, what our `chat.<host>` UI does).**
The browser posts to a same-origin path with no key; a proxy adds the key. In our
setup Caddy does this (see `Caddyfile`): it rewrites `/api/chat` to
`/v1/chat/completions` and injects `Authorization: Bearer <WEBCHAT_API_KEY>`. The
browser code carries no secret:

```js
const res = await fetch("/api/chat", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "claude-opus",
    messages: [{ role: "user", content: question }],
  }),
});
const data = await res.json();
console.log(data.choices[0].message.content);
```

**Option B - call the gateway directly from code (server/CLI).** Use the OpenAI SDK:

```python
from openai import OpenAI
client = OpenAI(base_url="https://56.228.19.15.sslip.io/v1", api_key="<virtual-key>")
resp = client.chat.completions.create(
    model="claude-opus",
    messages=[{"role": "user", "content": "hello"}],
)
print(resp.choices[0].message.content)
```

Do not embed a key directly in browser JavaScript — keep it behind a proxy (Option A)
or in server-side code (Option B).

---

## 2. Cursor

Cursor can use an OpenAI-compatible endpoint.

1. Open **Cursor Settings -> Models**.
2. Under **API Keys**, expand **OpenAI API Key**:
   - Paste your **virtual key** (`sk-...`) as the API key.
   - Enable **Override OpenAI Base URL** and set it to:
     `https://56.228.19.15.sslip.io/v1`
3. Under **Models**, add a custom model whose name matches a gateway model exactly:
   `claude-opus` (and/or `claude-sonnet`). Turn off models you are not routing.
4. Click **Verify** / save. Cursor sends a test request to
   `https://56.228.19.15.sslip.io/v1/chat/completions`.

Notes:
- The model name in Cursor must equal the `model_name` in the gateway `config.yaml`
  (`claude-opus`, `claude-sonnet`).
- The custom OpenAI endpoint drives chat. Some Cursor features (Tab, background agents)
  are tied to Cursor's own models and will not route through the gateway.
- **You need a virtual key** (Step 0) — Cursor requires an API key. Mint a dedicated
  one (e.g. `key_alias: cursor`) so its spend is tracked and revocable on its own.
- **The base-URL override is global to Cursor**, not per-project: it applies to every
  workspace and replaces your normal Cursor model access until you turn it off. Toggle
  it back off to return to standard Cursor models.

---

## 3. Claude Code

Claude Code speaks the Anthropic Messages API, which the gateway serves at
`/v1/messages`. Point it at the gateway with environment variables:

```bash
export ANTHROPIC_BASE_URL="https://56.228.19.15.sslip.io"
export ANTHROPIC_AUTH_TOKEN="<virtual-key>"     # sent as: Authorization: Bearer <key>
export ANTHROPIC_MODEL="claude-opus"            # main model (a gateway model_name)
export ANTHROPIC_SMALL_FAST_MODEL="claude-sonnet"  # cheaper model for small tasks

claude
```

To make it persistent, add those `export` lines to your shell profile
(`~/.zshrc` / `~/.bashrc`) or Claude Code's settings.

Notes:
- Use `ANTHROPIC_AUTH_TOKEN` (Bearer) for LiteLLM virtual keys. `ANTHROPIC_API_KEY`
  (sent as `x-api-key`) also works if the gateway accepts it.
- `ANTHROPIC_MODEL` / `ANTHROPIC_SMALL_FAST_MODEL` must match gateway `model_name`s.
- Tool use / agentic features need capable models — Opus and Sonnet both support them.

---

## 4. OpenClaw

OpenClaw has first-class LiteLLM support — the gateway plugs in as a native
provider. Mint a dedicated virtual key (Step 0, e.g. `key_alias: openclaw`), then
either onboard via CLI:

```bash
openclaw onboard --non-interactive --auth-choice litellm-api-key \
  --litellm-api-key "sk-<virtual-key>" \
  --custom-base-url "https://56.228.19.15.sslip.io/v1"
```

…or add the provider to `~/.openclaw/openclaw.json` (hot-reloaded, no restart):

```json5
{
  "models": {
    "mode": "merge",                       // required — don't clobber built-in providers
    "providers": {
      "litellm": {
        "baseUrl": "https://56.228.19.15.sslip.io/v1",
        "apiKey": "${LITELLM_API_KEY}",    // or paste the virtual key
        "api": "openai-completions",       // required
        "models": [
          { "id": "claude-opus",   "name": "Claude Opus (gateway)",
            "reasoning": true, "input": ["text", "image"],
            "contextWindow": 200000, "maxTokens": 64000 },
          { "id": "claude-sonnet", "name": "Claude Sonnet (gateway)",
            "reasoning": true, "input": ["text", "image"],
            "contextWindow": 200000, "maxTokens": 64000 }
        ]
      }
    }
  },
  "agents": {
    "defaults": { "model": { "primary": "litellm/claude-opus" } }
  }
}
```

Gotchas (all three produce confusing errors if missed):
- **`"api": "openai-completions"` is mandatory** — without it OpenClaw fails with
  `No API provider registered for api: undefined`.
- **`"mode": "merge"` is required** — otherwise this block replaces OpenClaw's whole
  built-in provider catalog.
- **Model `id`s must equal gateway `model_name`s** (`claude-opus`, `claude-sonnet`,
  or a tenant model like `ibm-opus`), and references always use the provider prefix:
  `litellm/claude-opus`.

Per-tenant setup: give the customer's OpenClaw their scoped virtual key and their
tenant model id (e.g. `"id": "ibm-opus"`, primary `litellm/ibm-opus`) — their agent
traffic then bills to their own provider account and is tracked under their key.

---

## Verify any client

```bash
# OpenAI shape
curl https://56.228.19.15.sslip.io/v1/chat/completions \
  -H "Authorization: Bearer <virtual-key>" -H "Content-Type: application/json" \
  -d '{"model":"claude-opus","messages":[{"role":"user","content":"ping"}]}'

# Anthropic shape (Claude Code)
curl https://56.228.19.15.sslip.io/v1/messages \
  -H "Authorization: Bearer <virtual-key>" \
  -H "anthropic-version: 2023-06-01" -H "Content-Type: application/json" \
  -d '{"model":"claude-opus","max_tokens":50,"messages":[{"role":"user","content":"ping"}]}'
```

Then confirm the calls appear in the Admin UI under **Logs** / **Usage**, attributed
to your virtual key.
