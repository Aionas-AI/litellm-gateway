# Dynamic BYOK Admin UI

The static admin UI at `https://keys.<DOMAIN>` provisions database-backed LiteLLM
deployments without restarting the gateway.

After login an administrator can:

- provision or rotate a provider credential for an explicit tenant and user;
- choose one or more clients and receive their virtual keys once;
- list and delete Aionas-managed deployments; and
- mint a 15-minute setup token for `aionas-connect`, allowing the customer to type
  their provider key on their own machine. Tokens are single-use: one successful
  enrollment burns the token, so a leaked token cannot be replayed to mint extra
  keys. Failed attempts (validation errors) do not burn it.

Provider keys are sent directly to the key-manager over HTTPS, forwarded to
LiteLLM's private management endpoint, encrypted in Postgres, and cleared from the
form. The UI has no config preview or apply button because dynamic models become
active immediately.

Custom `apiBase` values are denied unless their exact hostname appears in
`ALLOWED_CUSTOM_API_BASE_HOSTS`.

Files:

- `index.html` — dependency-free UI;
- [`../key-manager/README.md`](../key-manager/README.md) — API and security model;
- [`../aionas-connect/README.md`](../aionas-connect/README.md) — customer-side setup.
