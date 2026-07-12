# Customer-Billed Traffic: Three Approaches Compared

**Goal:** customers send traffic through our LiteLLM gateway, but every token is billed
to the **customer's own provider account** (OpenAI, Anthropic, Gemini, …).

All approaches keep the same two-key model:

| Key | Issued by | Purpose |
| --- | --- | --- |
| Virtual key (`sk-...`) | Us (LiteLLM) | Gateway auth, per-customer tracking, budgets, model scoping |
| Provider key | Customer's provider account | Upstream auth — decides **who pays** |

The approaches differ in **where the customer's provider key lives** and **how it
reaches the upstream provider**.

---

## Approach 1 — Server-side key in LiteLLM's database (recommended default)

The customer hands us a provider key once. The control plane registers a database-
backed LiteLLM deployment through `/model/new`; LiteLLM encrypts the provider fields
using the stable `LITELLM_SALT_KEY`. Clients only send their virtual key.

### Dynamic registration

```json
{
  "model_name": "aionas-byok-<opaque-id>",
  "litellm_params": {
    "model": "anthropic/claude-opus-4-8",
    "api_key": "sk-ant-..."
  },
  "model_info": {
    "id": "aionas-<opaque-id>",
    "aionas_managed": true
  }
}
```

The provider key is sent over the private management connection and never written
to a host-side YAML file or returned by the control plane.

### Client request — nothing special

```bash
curl https://<gateway>/v1/chat/completions \
  -H "Authorization: Bearer sk-<virtual-key>" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-opus","messages":[{"role":"user","content":"hi"}]}'
```

### Coverage — everything

- **Every provider**: LiteLLM injects the key upstream in whatever form the provider
  needs — including OpenAI's `Authorization: Bearer` (which the header-forwarding
  approach cannot deliver).
- **Every client, unmodified**: OpenAI SDKs, Cursor, Claude Code, curl, LangChain —
  the client only needs the virtual key and base URL.

### Trade-offs

- **Key custody**: the customer's key sits on our gateway — they must trust us.
  Mitigate by asking for a dedicated, spend-capped key from their provider console.
- **Rotation touches us**: the customer re-runs enrollment and the control plane
  PATCHes the deterministic deployment. It is immediate and requires no restart.
- **Ops per customer**: one database deployment plus one virtual key per client.

---

## Approach 2 — Auth-header forwarding (`forward_llm_provider_auth_headers`)

The client sends its provider key as the provider's native auth **header** on every
request; LiteLLM forwards it upstream instead of stripping it. The key is never stored
on the gateway.

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

## Approach 3 — Clientside auth params in the body (`configurable_clientside_auth_params`)

The client sends its provider key inside the **request body** (`extra_body` in the
OpenAI SDKs). LiteLLM maps it onto the upstream call. The key is never stored on the
gateway.

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

### Provider coverage — universal (but client-limited)

Works for **any LiteLLM-supported provider**: OpenAI, Anthropic, Gemini, Azure,
Mistral, etc. The key travels in the body, so there is no collision with the
`Authorization` header.

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

| | **1. Database deployment** | **2. Header forwarding** | **3. `extra_body` params** |
| --- | --- | --- | --- |
| Works with OpenAI | ✅ | ❌ (Bearer-auth conflict) | ✅ |
| Works with Anthropic | ✅ | ✅ | ✅ |
| Works with Gemini (AI Studio) | ✅ | ✅ | ✅ |
| Works with Azure OpenAI | ✅ | ✅ | ✅ |
| Works with *any* LiteLLM provider | ✅ | ❌ header allowlist only | ✅ |
| Unmodified clients (Cursor, plain SDKs) | ✅ | ❌ needs extra header | ❌ needs body change |
| Claude Code | ✅ | ✅ (native `/login` flow) | ❌ |
| Provider key stored on gateway | **Yes** (encrypted LiteLLM DB row) | No (transit only) | No (transit only) |
| Customer must trust us with their key | Yes | No | No |
| Key rotation | Through enrollment, no restart | Customer-side, zero touch | Customer-side, zero touch |
| Config scope | Per database deployment | Global toggle | Per model entry |
| Extra params (region, project, api_base) | Yes (in config) | No | Yes (regex-restrictable) |

## Security notes (all approaches)

- With the per-request approaches (2 and 3), the gateway does **not** verify that the
  provider key belongs to the customer whose virtual key authenticated the request.
  Billing separation relies on customers guarding their own provider keys; access
  separation relies on our virtual-key / team scoping. Keep every customer's virtual
  key locked to their own model entries.
- With approach 1, provider fields are encrypted in LiteLLM's database with a stable
  salt and must never appear in logs, previews, host files, or the repo.
- Keys pass through gateway memory and upstream TLS requests — make sure request
  logging never captures raw headers/bodies containing keys.
- Per-key `max_budget` on virtual keys still applies and is worth setting as a
  blast-radius cap even when the customer pays the tokens.

## Recommendation

**Default to Approach 1 (server-side encrypted database deployment).** It is the only approach that
supports every provider *and* every client with zero client-side changes, and the
onboarding story for the customer is the simplest possible: "here is your gateway URL
and your key." Ask each customer for a dedicated, spend-capped provider key to keep
custody risk low.

Use the per-request approaches only when a customer **refuses to hand over a key**:

- **Approach 3 (`extra_body`)** for their programmatic clients on any provider.
- **Approach 2 (header forwarding)** on top, solely so Claude Code and other
  Anthropic/Gemini-native tools work without code changes.

All three compose cleanly on one gateway — different customers can use different
approaches at the same time.

Per customer, onboarding stays the same either way:

1. Mint a short-lived tenant/user-scoped enrollment capability.
2. Enrollment registers the customer's deterministic deployment and mints one
   explicitly model-scoped virtual key per selected client.
3. The client sends its virtual key for gateway auth; the provider key is applied
   from the encrypted deployment (approach 1) or sent per request (approaches 2/3).
4. Usage, logs, and spend appear per-customer in the Admin UI; tokens are billed to
   the customer's provider account.
