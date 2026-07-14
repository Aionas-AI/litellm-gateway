# aionas-connect

`aionas-connect` enrolls a customer's provider key once, receives a separate
LiteLLM virtual key for each detected coding client, and creates reversible local
configuration. The provider key is never written to disk by this script.

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
python3 aionas-connect/aionas_connect.py undo
```

Provider keys and enrollment tokens are read with a hidden prompt when their
environment variables are absent. Virtual keys are stored in macOS Keychain,
Linux Secret Service, or a `0600` fallback file. Claude Code and Codex receive
separate launch wrappers; Codex reads its bearer token through the supported
command-backed provider auth contract. OpenClaw's JSON is backed up and merged. Cursor is
reported as guided-only because its private settings store is not a supported
automation contract.
