# Provider Subscriptions vs. Gateway Authentication — Detailed Comparison

Can a customer's existing AI subscription (Claude Pro/Team, ChatGPT Plus, Google
AI Ultra, GitHub Copilot, …) be routed through this LiteLLM gateway, and if so,
which credential do they hand over? This document maps every subscription tier
of the major providers against every authentication method LiteLLM supports,
and ends with concrete recommendations for our BYOK enrollment product.

> Research date: **July 15, 2026**. Subscription pricing and enforcement
> policies change frequently — re-verify before quoting a customer.

---

## 1. The authentication methods LiteLLM supports

| # | Method | How it works | Where the credential lives |
|---|--------|-------------|---------------------------|
| A | **Server-side key (our BYOK enrollment)** | Provider API key stored per model in LiteLLM's DB (encrypted with `LITELLM_SALT_KEY`); attached server-side on every call | Gateway database |
| B | **Client-side header forwarding** | `forward_client_headers_to_llm_api: true` + `forward_llm_provider_auth_headers: true` (v1.82+); forwards `x-api-key`, `x-goog-api-key`, `api-key`, `ocp-apim-subscription-key`. Client sends provider key per request; LiteLLM virtual key goes in `x-litellm-api-key` | Customer's machine |
| C | **Client-side `extra_body` credentials** | `configurable_clientside_auth_params` on a model; client passes `api_key`/`api_base`/provider params in the request body | Customer's machine |
| D | **Subscription OAuth providers** | Dedicated provider routes that sign in with a *subscription account* instead of an API key: `github_copilot/` (device flow), `chatgpt/` (device flow, Codex backend), `google_code_assist/` (`litellm-proxy gemini login`). Since PR #25921 tokens can be stored encrypted in the proxy DB and referenced as `api_key: oauth:<credential_name>` | Gateway (token store) or local token files |
| E | **Cloud IAM** | AWS Bedrock via SigV4/instance role (what our shared models use), GCP Vertex via service account/ADC, Azure via Entra ID | Cloud role, no key at all |

Methods A, C, E are per-model / per-request. Method B is a **global gateway
switch** — enabling it changes header handling for every client. Method D
depends on each provider tolerating third-party use of subscription auth,
which is exactly where the differences below come from.

---

## 2. Provider by provider

### 2.1 Anthropic (Claude)

**Subscription tiers (July 2026):**

| Tier | Price | Programmatic access? |
|------|-------|---------------------|
| Free | $0 | No |
| Pro | $20/mo ($17 annual) | Claude Code only (official clients) |
| Max 5x / Max 20x | $100 / $200/mo | Claude Code only |
| Team Standard | $25/seat/mo ($20 annual, 5-seat min) | Claude Code only |
| Team Premium | $125/seat/mo ($100 annual) | Claude Code only, higher usage |
| Enterprise | ~$20/seat + usage at API rates | Claude Code + optional API-rate overflow |
| **API (Console)** | pay-as-you-go | Yes — `sk-ant-api03-…` keys |

**Which tokens exist:** Console API keys (`sk-ant-api03-…`) and subscription
OAuth tokens (`sk-ant-oat01-…`, minted by Claude Code's login/`setup-token`).

**LiteLLM support vs. Anthropic enforcement:**

- API key → works with **A, B (`x-api-key`), C**. Fully supported, this is
  what our enrollment flow stores.
- Subscription OAuth → LiteLLM shipped forwarding support (PR #19453,
  Jan 2026: detects `sk-ant-oat01-*`, adds the `anthropic-beta` OAuth headers,
  dual-auth with `x-litellm-api-key`) and there is an unmerged server-managed
  `claude_max/` provider (PR #29390, carries an open credential-exfiltration
  finding). **But Anthropic deployed server-side blocking in Jan–Feb 2026**:
  OAuth tokens are rejected outside Claude Code/Claude.ai with "OAuth
  authentication is currently not supported", and the ToS now states OAuth
  credentials are exclusively for official clients. The only flow that still
  functions is genuine Claude Code with fully transparent header forwarding —
  a ToS-gray setup Anthropic can break at any time.

**Verdict: subscription cannot be resold through the gateway. Require a
Console API key (`sk-ant-api03-…`), or route via Bedrock IAM (method E) as our
shared models already do.**

### 2.2 OpenAI (ChatGPT / Codex / Platform API)

**Subscription tiers (July 2026):**

| Tier | Price | Programmatic access? |
|------|-------|---------------------|
| Free / Go | $0 / low | Codex included, small limits |
| Plus | $20/mo | Codex included (credit-based since Apr 2026) |
| Pro 5x / Pro 20x | ~$100 / $200/mo | Codex, 5–20x Plus usage |
| Business (Team) | per-seat | Codex + admin controls, shared credit pools |
| Enterprise / Edu | custom | Codex + **Codex access tokens** for headless automation (v0.138+, inherits workspace RBAC) |
| **Platform API** | pay-as-you-go | Yes — `sk-…` project/service-account keys |

**LiteLLM support:**

- API key → **A and C** work. **B does not** for OpenAI: it authenticates with
  `Authorization: Bearer`, the same header LiteLLM uses for virtual keys, so
  there is no separate forwardable header. Server-side storage is the way.
- Subscription OAuth → LiteLLM has a **documented first-class `chatgpt/`
  provider**: OAuth device-code flow against the ChatGPT/Codex backend,
  Responses API native, models like `chatgpt/gpt-5.4` and
  `chatgpt/gpt-5.3-codex`. Tokens can persist encrypted in the proxy DB
  (`api_key: oauth:<name>`). This *works today*, but OpenAI positions ChatGPT
  sign-in for its official Codex clients; routing arbitrary traffic through
  the subscription backend is unofficial and rate-limited by plan windows
  (5-hour credit windows, weekly caps). Enterprise **Codex access tokens** are
  the one *sanctioned* headless subscription credential, but they are scoped
  to Codex workflows, not a general Chat Completions replacement.

**Verdict: for production customer traffic, require a Platform API key.
The `chatgpt/` OAuth provider is usable for internal/experimental workloads
on a Pro/Team subscription, with the caveat that it is unofficial and
quota-windowed.**

### 2.3 Google (Gemini / DeepMind)

**Subscription tiers (July 2026):**

| Tier | Price | Programmatic access? |
|------|-------|---------------------|
| Free | $0 | Gemini app; Antigravity limited |
| Google AI Plus / Pro | low / ~$20/mo | App + Antigravity usage |
| Google AI Ultra (new dev tier) | $100/mo | 5x Pro limits in Gemini app + Antigravity, priority access |
| Google AI Ultra 20x | $200/mo (down from $250) | 20x Pro limits |
| Gemini Code Assist (Cloud seats) | per-seat via Google Cloud | IDE/agent usage under license |
| **Gemini API (AI Studio)** | free tier + pay-as-you-go | Yes — API keys |
| **Vertex AI** | pay-as-you-go / committed | Yes — service accounts / ADC |

**Critical recent changes:**

- **June 18, 2026:** Gemini CLI and Code Assist IDE extensions stopped serving
  consumer tiers (free individuals, AI Pro, AI Ultra). Google's replacement is
  the **Antigravity CLI** (`agy`, authenticated with an `AV_API_KEY`).
- Google's FAQ explicitly states that third-party tools accessing the Gemini
  CLI/Code Assist endpoints violate its terms and recommends Vertex keys
  instead.
- **September 2026:** AI Studio "standard" API keys stop working — customers
  must migrate to **auth keys** (bound to a service account). New AI Studio
  keys are already auth keys. Our enrollment docs should tell Gemini customers
  to supply an auth key.

**LiteLLM support:**

- Gemini API key → **A, B (`x-goog-api-key`), C** all work.
- Vertex → **E** (service account / ADC) plus per-request `vertex_project` /
  `vertex_ai_location` via C.
- Subscription OAuth → LiteLLM merged a `google_code_assist/` provider with
  `litellm-proxy gemini login` (PR #23933, Mar 2026) — but Google's June 18
  deprecation cut the consumer tiers off from those endpoints, so this path is
  **effectively dead for AI Pro/Ultra subscribers** and against Google's
  terms for third-party tools. An `antigravity` server-managed provider is
  only an unmerged PR (#29390).

**Verdict: require a Gemini *auth* API key or a Vertex service account.
Google subscription quota (AI Pro/Ultra) is locked to Google's own apps.**

### 2.4 Meta AI

**Offerings (July 2026):**

| Offering | Price | Programmatic access? |
|----------|-------|---------------------|
| Meta AI consumer app | free | No developer surface |
| **Meta Model API** (dev.meta.ai) | pay-as-you-go, $20 free credits, US-only public preview (waitlist) | Yes — `MODEL_API_KEY` Bearer token |
| Llama open weights via hosts | per host | Bedrock, Groq, Together, Fireworks, etc. |

The Meta Model API (flagship `muse-spark-1.1`, $1.25/$4.25 per M tokens, 1M
context) is deliberately **not** listed on aggregators like OpenRouter; it is
OpenAI- and Anthropic-SDK compatible at `https://api.meta.ai/v1`.

**LiteLLM support:** works as an OpenAI-compatible endpoint with a server-side
key (**A**, or **C**). Like OpenAI it authenticates via `Authorization:
Bearer`, so header-forwarding (B) is not available. No subscription concept
exists at all — there is nothing to bring but an API key. Llama models are
also reachable through Bedrock with IAM (**E**), which our gateway already
supports natively.

**Verdict: Meta has no subscription to route. Store a Meta Model API key
server-side (US customers, preview waitlist), or serve Llama via Bedrock.**

### 2.5 GitHub Copilot — the one subscription that genuinely works

**Subscription tiers (usage-based AI Credits since June 1, 2026):**

| Tier | Price | Included credits |
|------|-------|-----------------|
| Free / Student | $0 | limited |
| Pro | $10/mo | $15/mo |
| Pro+ | $39/mo | $70/mo |
| Max | $100/mo | $200/mo |
| Business | $19/seat/mo | $19/seat (promo $30 to Aug 2026) |
| Enterprise | $39/seat/mo | $39/seat (promo $70) |

**LiteLLM support:** a **documented, first-class `github_copilot/` provider**
using GitHub's OAuth device flow — sign in once, tokens stored locally or
(since PR #25921) encrypted in the proxy DB. Supports chat completions and
embeddings, model catalog spanning GPT and Claude models, and GitHub
Enterprise Server custom endpoints via env vars. There is no API key to
manage at all. Caveats: Copilot's terms intend the API for Copilot clients
(LiteLLM presents editor-style headers), and per-plan credit metering applies.

**Verdict: the only major subscription that LiteLLM supports openly and that
the vendor has not blocked. Fine for internal seats; for customer-facing
resale the per-seat licensing terms still make API keys the safer product.**

### 2.6 AWS Bedrock

**No subscriptions — pure usage billing, two pricing models:**

| Pricing model | How it bills | When it makes sense |
|---------------|-------------|---------------------|
| **On-demand** | Per token (e.g. Claude Sonnet-class ~$3/$15 per M tokens; exact rates per model/region) | Default; what our shared models use today |
| **Provisioned Throughput** | Hourly per Model Unit, 1- or 6-month commitments (e.g. Sonnet-class ~$39/hr per MU) | Sustained high volume needing guaranteed throughput; billed whether used or not |

Batch inference gets discounted rates, and the newer `bedrock-mantle`
OpenAI-compatible endpoint has token-based rather than request-based quotas.

**Which credentials exist — three distinct options:**

1. **IAM SigV4** — role- or user-based AWS credentials, no key material on the
   wire. Our EC2 instance role uses this for the shared `claude-sonnet` /
   `claude-opus` models (method **E**). The gold standard when the gateway
   runs inside AWS.
2. **IAM access key pair** — a per-tenant `aws_access_key_id` +
   `aws_secret_access_key` (+ region). Works with our enrollment (**A**) and
   with `extra_body` (**C**) via LiteLLM's `aws_*` params; this is how a
   customer bills Bedrock usage to *their own* AWS account through the
   gateway.
3. **Bedrock API keys** (bearer tokens) — newer option, two kinds:
   - **Short-term** — valid ≤12 hours (or session lifetime), inherits the
     generating IAM principal's permissions, region-bound. AWS recommends
     these for production; the `aws-bedrock-token-generator` package
     auto-refreshes them from normal AWS credentials.
   - **Long-term** — configurable expiry, backed by an auto-created IAM user.
     AWS explicitly recommends these **for exploration only**. Admins can cap
     their lifetime (`iam:ServiceSpecificCredentialAgeDays`) and gate usage
     with `bedrock:CallWithBearerToken`.

**LiteLLM support:** first-class `bedrock/` provider with SigV4 (env/role
credentials or per-model `aws_*` params) and bearer-token support via
`AWS_BEARER_TOKEN_BEDROCK` / `api_key`. Header forwarding (**B**) is not
applicable — bearer tokens ride `Authorization`, which collides with the
virtual key.

**Verdict for our BYOK enrollment:** prefer a per-tenant **IAM access key
pair** scoped to `bedrock:InvokeModel*` (stable, revocable, no expiry
surprises). A long-term Bedrock API key also works and is simpler for the
customer to create, but AWS discourages it for production and it hides an IAM
user underneath. Short-term keys don't fit server-side storage — they expire
within 12 hours and our enrollment has no refresh loop for them.

### 2.7 xAI (Grok), Mistral, DeepSeek, Azure — quick reference

| Provider | Subscriptions | Do they include API? | Gateway path |
|----------|--------------|---------------------|--------------|
| **xAI** | Free, X Premium $8, SuperGrok Lite $10, SuperGrok $30, X Premium+ $40, SuperGrok Heavy $300 | **No** — consumer app only; API is separate pay-per-token (xAI Console key, e.g. Grok 4.5 at $2/$6 per M) | Server-side key (A); OpenAI-compatible |
| **Mistral** | Le Chat Free/Pro/Team/Enterprise | No — API is separate (La Plateforme keys) | Server-side key (A) |
| **DeepSeek** | none | n/a — API keys, pay-as-you-go | Server-side key (A) |
| **Azure OpenAI** | PTU / pay-as-you-go (not a "subscription" in the consumer sense) | Yes by design | A; B works (`api-key`, `ocp-apim-subscription-key` are forwardable); Entra ID via E |

---

## 3. The full matrix

Legend: ✅ works & supported · ⚠️ technically possible but unofficial/fragile ·
❌ blocked or nonexistent.

| Provider / credential | A: server-side key (our enrollment) | B: header forwarding | C: extra_body | D: subscription OAuth | E: cloud IAM |
|---|---|---|---|---|---|
| Anthropic API key | ✅ | ✅ `x-api-key` | ✅ | — | ✅ via Bedrock/Vertex |
| Anthropic subscription (Pro/Max/Team/Enterprise) | ❌ no key exists | ❌ blocked by Anthropic | ❌ | ❌ blocked server-side since Feb 2026; `claude_max/` PR unmerged | — |
| OpenAI API key | ✅ | ❌ (Bearer collides with virtual key) | ✅ | — | ✅ via Azure |
| ChatGPT subscription (Plus/Pro/Business/Enterprise) | ❌ no key exists | ❌ | ❌ | ⚠️ `chatgpt/` device-flow provider works; unofficial, plan-quota-windowed. Enterprise Codex access tokens are sanctioned but Codex-scoped | — |
| Gemini API auth key | ✅ | ✅ `x-goog-api-key` | ✅ | — | — |
| Google AI Pro/Ultra subscription | ❌ no key exists | ❌ | ❌ | ❌ `google_code_assist/` merged but consumer endpoints shut off June 18, 2026; ToS forbids third-party use | — |
| Vertex AI | ✅ (SA JSON) | — | ✅ (project/region params) | — | ✅ ADC / service account |
| Meta Model API key | ✅ | ❌ (Bearer) | ✅ | — | ✅ Llama via Bedrock |
| GitHub Copilot seat | — (no key) | — | — | ✅ `github_copilot/` device flow, doc'd provider; ToS-gray for resale | — |
| xAI / Mistral / DeepSeek API keys | ✅ | ❌ (Bearer) | ✅ | — (subscriptions exclude API) | — |
| Azure OpenAI | ✅ | ✅ `api-key` | ✅ | — | ✅ Entra ID |
| AWS Bedrock | ✅ (AWS keys) | — | ✅ (region etc.) | — | ✅ SigV4 role (current setup) |

---

## 4. Conclusions and recommendations for this gateway

1. **API keys are the only universal, vendor-sanctioned path.** Every provider
   that matters issues them, our BYOK enrollment already stores them encrypted
   per tenant/user, and no ToS is at risk. This stays the product default.

2. **Consumer/seat subscriptions are almost universally locked to official
   apps.** Anthropic actively blocks OAuth tokens (since Jan–Feb 2026), Google
   shut off the consumer CLI endpoints (June 18, 2026) and forbids third-party
   use, and xAI/Mistral subscriptions simply don't include API access. Telling
   a customer "your Claude Team plan will not pay for gateway traffic — you
   need an Anthropic Console account" is the correct answer.

3. **Two real exceptions exist, with caveats:**
   - **GitHub Copilot** — first-class LiteLLM provider via device-flow OAuth;
     works today, no key to manage. Reasonable for our own internal seats,
     questionable to resell.
   - **ChatGPT subscription** — documented `chatgpt/` provider over the Codex
     backend; functional but unofficial, quota-windowed, and OpenAI could
     follow Anthropic's enforcement playbook at any time.
   Neither should be promised to paying customers as a stable product feature.

4. **Do not enable `forward_llm_provider_auth_headers` globally.** It is a
   gateway-wide switch that weakens header hygiene for every client, and the
   only clients that benefit (Claude Code `/login` BYOK, Gemini key-in-header)
   are already served by our server-side enrollment. Revisit only if a
   customer explicitly refuses server-side key storage.

5. **Token cheat-sheet for enrollment** (what customers must provide):

   | Provider | Credential to collect | Notes |
   |---|---|---|
   | Anthropic | `sk-ant-api03-…` Console key | never `sk-ant-oat01-…` |
   | OpenAI | Platform API key (`sk-…`) | project-scoped keys preferred |
   | Google | AI Studio **auth** key or Vertex SA JSON | standard keys die Sept 2026 |
   | Meta | `MODEL_API_KEY` from dev.meta.ai | US-only preview; or Llama via Bedrock |
   | xAI | Console API key | subscription irrelevant |
   | Mistral / DeepSeek | La Plateforme / platform key | subscription irrelevant |
   | Azure OpenAI | deployment key or Entra ID | region + deployment name needed |
   | AWS Bedrock | IAM access key pair (preferred) or long-term Bedrock API key | short-term API keys expire ≤12h — unusable server-side; see §2.6 |

6. **Watch list.** LiteLLM's server-managed subscription providers PR (#29390:
   `claude_max/`, `antigravity/`) would centralize OAuth token refresh in the
   gateway — if it merges *and* vendors relax enforcement, revisit this
   document. Also re-check Anthropic Team/Enterprise: Enterprise plans bill
   overflow at API rates, and Anthropic could plausibly open a sanctioned
   programmatic path for commercial seats in the future.

---

## Sources

- Anthropic pricing: [claude.com/pricing](https://claude.com/pricing); OAuth blocking: [anthropics/claude-code#28089](https://github.com/anthropics/claude-code/issues/28089)
- OpenAI Codex plans/auth: [Codex pricing](https://chatgpt.com/codex/pricing/), [developers.openai.com/codex/auth](https://developers.openai.com/codex/auth)
- Google: [Gemini CLI auth docs](https://google-gemini.github.io/gemini-cli/docs/get-started/authentication.html), [Code Assist deprecation FAQ](https://developers.google.com/gemini-code-assist/resources/faqs), [AI subscription updates](https://blog.google/products-and-platforms/products/google-one/google-ai-subscriptions/), [API-key migration](https://ai.google.dev/gemini-api/docs/generate-content/api-key)
- Meta Model API: [dev.meta.ai/docs](https://dev.meta.ai/docs/getting-started/overview/)
- GitHub Copilot: [plans](https://docs.github.com/en/copilot/get-started/plans), [usage-based billing](https://github.blog/news-insights/company-news/github-copilot-is-moving-to-usage-based-billing/)
- xAI: [docs.x.ai pricing](https://docs.x.ai/developers/pricing)
- AWS Bedrock: [API keys](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html), [API-key permissions](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys-permissions.html), [Bedrock pricing](https://aws.amazon.com/bedrock/pricing/)
- LiteLLM: [github_copilot provider](https://docs.litellm.ai/docs/providers/github_copilot), [chatgpt provider](https://docs.litellm.ai/docs/providers/chatgpt), [header forwarding / BYOK](https://docs.litellm.ai/docs/proxy/forward_client_headers), [clientside credentials](https://docs.litellm.ai/docs/proxy/clientside_auth), PRs [#19453](https://github.com/BerriAI/litellm/pull/19453), [#23933](https://github.com/BerriAI/litellm/pull/23933), [#25921](https://github.com/BerriAI/litellm/pull/25921), [#29390](https://github.com/BerriAI/litellm/pull/29390)
