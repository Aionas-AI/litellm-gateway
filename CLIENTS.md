# Connect coding clients

Every client receives its own LiteLLM virtual key. The customer's provider key is
entered only during enrollment and is never placed in a coding-client config.

## Recommended: aionas-connect

```bash
python3 aionas-connect/aionas_connect.py scan
python3 aionas-connect/aionas_connect.py plan

export AIONAS_ENROLLMENT_TOKEN='aionas_enroll_...'
python3 aionas-connect/aionas_connect.py setup \
  --control-plane https://keys.example.com/api \
  --provider anthropic \
  --model claude-opus-4-8 \
  --model-alias claude-opus

python3 aionas-connect/aionas_connect.py verify
```

The tool reads the provider key with a hidden prompt, sends it once to the control
plane, and stores only virtual keys locally. It creates wrappers in `~/.local/bin`:

- `claude-aionas`
- `codex-aionas`
- `openclaw-aionas`

`undo` restores local files. Server-side key revocation remains an administrator
operation in LiteLLM.

## Protocol matrix

| Client | Gateway protocol | Base URL |
| --- | --- | --- |
| Claude Code | Anthropic Messages | `https://<gateway>` |
| Codex | OpenAI Responses | `https://<gateway>/v1` |
| OpenClaw | OpenAI Chat Completions | `https://<gateway>/v1` |
| Cursor chat models | OpenAI Chat Completions | `https://<gateway>/v1` |

## Manual fallbacks

### Claude Code

```bash
export ANTHROPIC_BASE_URL="https://<gateway>"
export ANTHROPIC_AUTH_TOKEN="sk-<virtual-key>"
export ANTHROPIC_MODEL="claude-opus"
claude
```

### Codex

Use a separate `CODEX_HOME` or merge this provider into the user-level config:

```toml
model = "claude-opus"
model_provider = "aionas"

[model_providers.aionas]
name = "Aionas LiteLLM"
base_url = "https://<gateway>/v1"
wire_api = "responses"

[model_providers.aionas.auth]
command = "/absolute/path/to/aionas-key-helper"
args = []
refresh_interval_ms = 0
```

The helper prints the virtual key to stdout. `aionas-connect` creates it against
macOS Keychain, Linux Secret Service, or the protected fallback store.

### OpenClaw

```json
{
  "models": {
    "mode": "merge",
    "providers": {
      "litellm": {
        "baseUrl": "https://<gateway>/v1",
        "apiKey": "${LITELLM_API_KEY}",
        "api": "openai-completions",
        "models": [{ "id": "claude-opus", "name": "Claude Opus (Aionas)" }]
      }
    }
  },
  "agents": {
    "defaults": { "model": { "primary": "litellm/claude-opus" } }
  }
}
```

Both `"mode": "merge"` and `"api": "openai-completions"` are required.

### Cursor

Open Cursor Settings → Models → API Keys, enter the Cursor-specific virtual key,
enable the OpenAI base URL override, and use `https://<gateway>/v1`. Add the exact
model alias returned during enrollment. Cursor's Tab and some hosted features do
not use the custom OpenAI endpoint.

## No-spend verification

```bash
curl https://<gateway>/v1/models \
  -H "Authorization: Bearer sk-<virtual-key>"
```

Protocol-level live checks consume provider tokens and should be run explicitly.
