# BYOK: Passing Customer Provider Keys Per Request — Two Approaches Compared

**Goal:** customers send traffic through our LiteLLM gateway, but every token is billed
to the **customer's own provider account** (OpenAI, Anthropic, Gemini, …), and their
provider key is **never stored on our gateway**.

Both approaches keep the same two-key model:

| Key | Issued by | Sent as | Purpose |
| --- | --- | --- | --- |
| Virtual key (`sk-...`) | Us (LiteLLM) | `Authorization: Bearer` | Gateway auth, per-customer tracking, budgets, model scoping |
| Provider key | Customer's provider account | differs per approach ↓ | Upstream auth — decides **who pays** |

The approaches differ only in **how the provider key travels** from the client to the
upstream provider.

---

## Approach 1 — Auth-header forwarding (`forward_llm_provider_auth_headers`)

The client sends its provider key as the provider's native auth **header**; LiteLLM
forwards it upstream instead of stripping it.

### Configuration (global)

```yaml
model_list:
  - model_name: ibm-claude-opus
    litellm_params:
      model: anthropic/claude-opus-4-8
      # no api_key -> client's forwarded header is used

general_settings:
  forward_client_headers_to_llm_api: true
  forward_llm_provider_auth_headers: true   # opt-in, v1.82+
```

### Client request

```bash
curl https://<gateway>/v1/messages \
  -H "Authorization: Bearer sk-<virtual-key>" \          # proxy auth (never forwarded)
  -H "x-api-key: sk-ant-<customer's Anthropic key>" \    # forwarded upstream -> customer pays
  -H "anthropic-version: 2023-06-01" -H "Content-Type: application/json" \
  -d '{"model":"ibm-claude-opus","max_tokens":100,"messages":[{"role":"user","content":"hi"}]}'
```

### Provider coverage — partial

Only a fixed allowlist of auth headers is forwarded:

| Header | Provider | Works? |
| --- | --- | --- |
| `x-api-key` | Anthropic, Azure AI, Databricks | ✅ |
| `x-goog-api-key` | Google AI Studio (Gemini) | ✅ |
| `api-key` | Azure OpenAI | ✅ |
| `ocp-apim-subscription-key` | Azure APIM | ✅ |
| `Authorization: Bearer` | **OpenAI** (and other Bearer-auth providers) | ❌ never forwarded |

**OpenAI cannot work with this approach.** OpenAI authenticates with the
`Authorization` header — the same header that carries our virtual key. LiteLLM never
forwards `Authorization` upstream (doing so would leak gateway credentials), so there
is no way to deliver a client's OpenAI key by header.

### Native-tool support — the killer feature

Anthropic-native tools that cannot modify request bodies work out of the box:

- **Claude Code**: the developer runs `/login` with their own Anthropic account
  (Claude Code then sends their key as `x-api-key` automatically) and passes our
  virtual key via `ANTHROPIC_CUSTOM_HEADERS="x-litellm-api-key: sk-<virtual-key>"`.
  Their Anthropic account is billed; we still meter every request.

---

## Approach 2 — Clientside auth params in the body (`configurable_clientside_auth_params`)

The client sends its provider key inside the **request body** (`extra_body` in the
OpenAI SDKs). LiteLLM maps it onto the upstream call.

### Configuration (per model entry — no global toggle)

```yaml
model_list:
  - model_name: ibm-gpt
    litellm_params:
      model: openai/gpt-5
      configurable_clientside_auth_params: ["api_key"]

  - model_name: ibm-gemini
    litellm_params:
      model: gemini/gemini-2.5-pro
      configurable_clientside_auth_params: ["api_key"]

  - model_name: ibm-claude-opus
    litellm_params:
      model: anthropic/claude-opus-4-8
      configurable_clientside_auth_params: ["api_key"]
```

### Client request

```python
from openai import OpenAI

client = OpenAI(base_url="https://<gateway>/v1", api_key="sk-<virtual-key>")
resp = client.chat.completions.create(
    model="ibm-gpt",
    messages=[{"role": "user", "content": "hi"}],
    extra_body={"api_key": "sk-<customer's OpenAI key>"},   # customer pays
)
```

### Provider coverage — universal

Works for **any LiteLLM-supported provider**: OpenAI, Anthropic, Gemini, Azure,
Mistral, Bedrock-key-based setups, etc. The key travels in the body, so there is no
collision with the `Authorization` header.

It can also carry provider-specific params beyond the key (e.g. Vertex
`vertex_ai_project` / `vertex_ai_location`), and `api_base` can be allowed with regex
restrictions:

```yaml
configurable_clientside_auth_params:
  - api_key
  - {"api_base": "^https://litellm.*\\.example\\.com/v1$"}   # regex-restricted
```

### Limitation — requires a body-editing client

The client must be able to add fields to the JSON body. Trivial with the OpenAI /
Anthropic SDKs (`extra_body`) or curl; **impossible with closed tools** like Claude
Code, which only control headers/env vars.

---

## Side-by-side

| | **1. Header forwarding** | **2. `extra_body` params** |
| --- | --- | --- |
| Works with OpenAI | ❌ (Bearer-auth conflict) | ✅ |
| Works with Anthropic | ✅ | ✅ |
| Works with Gemini (AI Studio) | ✅ | ✅ |
| Works with Azure OpenAI | ✅ | ✅ |
| Works with *any* LiteLLM provider | ❌ header allowlist only | ✅ |
| Claude Code / native tools | ✅ out of the box | ❌ |
| Config scope | Global toggle (`general_settings`) | Per model entry (finer-grained) |
| Provider key stored on gateway | No | No |
| Provider key visible in gateway process | In headers (transit only) | In body (transit only) |
| Extra params (region, project, api_base) | No | Yes (regex-restrictable) |
| Client change required | Add one header | Modify request body |
| Security blast radius | Any model entry without a server-side key accepts any client key | Only opted-in model entries accept client keys |

## Security notes (both approaches)

- The gateway does **not** verify that the provider key belongs to the customer whose
  virtual key authenticated the request. Billing separation relies on customers
  guarding their own provider keys; access separation relies on our virtual-key /
  team scoping. Keep every customer's virtual key locked to their own model entries.
- Keys pass through gateway memory and appear in upstream TLS requests only — make
  sure request logging never captures raw headers/bodies containing keys.
- Per-key `max_budget` on virtual keys still applies and is worth setting as a
  blast-radius cap even though the customer pays the tokens.
- Both features require clients you trust to authenticate (our virtual keys do this);
  neither is suitable on an unauthenticated public endpoint.

## Recommendation

Enable **both** — they compose cleanly and cover each other's gaps:

- **Approach 2 (`configurable_clientside_auth_params: ["api_key"]`)** on every
  customer model entry — the universal path for programmatic clients on any provider,
  including OpenAI.
- **Approach 1 (`forward_llm_provider_auth_headers: true`)** globally — solely so
  Claude Code and other Anthropic/Gemini-native tools work without code changes.

Per customer, the onboarding stays the same either way:

1. Create a team (`/team/new`) scoped to the customer's model entries.
2. Mint a virtual key (`/key/generate`) bound to that team.
3. Customer sends the virtual key for gateway auth + their provider key
   (header or `extra_body`) for billing.
4. Usage, logs, and spend appear per-customer in the Admin UI; tokens are billed to
   the customer's provider account.
