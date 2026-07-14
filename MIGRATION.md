# Migration: static tenant-key config → dynamic BYOK (v1.92)

This is the rollout plan for moving the live EC2 box from the v1.91.1 stack
(file-based `runtime/config.yaml`, key-manager writing to AWS Secrets Manager,
Docker-socket restarts) to the v1.92.0 stack (database-backed models, enrollment
API, no restarts). Follow it top to bottom; each phase ends with a check that
must pass before continuing.

## What changes on the box

| Area | Before | After |
|---|---|---|
| LiteLLM image | `ghcr.io/berriai/litellm:v1.91.1` | locally built `aionas/litellm-gateway:v1.92.0` (base image + alias-guard extension) |
| Model config | `runtime/config.yaml`, regenerated + container restart | Postgres rows via `/model/new`, live immediately |
| Tenant provider keys | AWS Secrets Manager (`litellm-gateway/tenants/*`) | Encrypted in Postgres with `LITELLM_SALT_KEY` |
| key-manager | Mounts Docker socket, writes runtime config | Talks to LiteLLM management API only |
| Enrollment | Admin-only UI form | Admin UI **or** single-use setup token + `aionas-connect` CLI |

## Phase 0 — Pre-flight (no downtime)

1. **Back up Postgres.** All virtual keys, spend history, and (after migration)
   encrypted provider credentials live here.

   ```bash
   docker compose exec db pg_dump -U litellm litellm | gzip > ~/pre-v192-$(date +%F).sql.gz
   ```

2. **Back up `.env`** (`cp .env ~/pre-v192.env`).

3. **Inventory old tenant secrets.** List anything under the old prefix:

   ```bash
   aws secretsmanager list-secrets --region eu-north-1 \
     --filters Key=name,Values=litellm-gateway/tenants/ \
     --query 'SecretList[].Name'
   ```

   There is **no automated migration** for these. For each real tenant found,
   plan to re-enroll them through the new admin UI after cutover (the provider
   key value is retrievable with `get-secret-value` until you delete it).

4. **Extend `.env`** with the new required variables:

   - `LITELLM_SALT_KEY` — set to the **current** `LITELLM_MASTER_KEY` value.
     LiteLLM has been implicitly using the master key as the encryption salt,
     so this preserves decryption of any existing DB rows. After this point the
     salt key must **never** change; the master key may rotate freely.
   - `KEY_MANAGER_ENROLLMENT_SIGNING_KEY` — new random 32+ byte value:
     `python3 -c "import secrets; print(secrets.token_urlsafe(32))"`
   - `ALLOWED_CUSTOM_API_BASE_HOSTS` — leave empty unless a customer needs a
     custom provider endpoint.

   Compose now refuses to start if `LITELLM_SALT_KEY` is missing — that is
   deliberate.

## Phase 1 — Cutover (~1–2 min gateway downtime)

```bash
cd ~/litellm-gateway
git pull origin master
docker compose pull db caddy
docker compose build --pull          # needs buildx >= 0.17 (installed by bootstrap.sh)
docker compose up -d
docker compose ps                    # litellm must reach "healthy"
```

Existing virtual keys, budgets, and spend history are untouched — they live in
Postgres and the shared Bedrock models are still defined in `config.yaml`.

## Phase 2 — Smoke tests (all must pass)

1. **Gateway up, shared models intact:**

   ```bash
   curl -s https://<DOMAIN>/v1/models -H "Authorization: Bearer $LITELLM_MASTER_KEY"
   ```

2. **Alias guard actually loaded.** This is the cross-tenant isolation
   mechanism; a silent import failure must be caught here. First check the log:

   ```bash
   docker compose logs litellm | grep -i aionas
   ```

   Then prove it fail-closed: enroll a test user (step 3), then call the
   gateway with the issued virtual key but `"model": "<another user's
   aionas-byok-... name>"` — the response must be **403**, not a completion.

3. **End-to-end enrollment.** In the admin UI (`https://keys.<DOMAIN>`),
   provision a test tenant/user with a real provider key. Confirm the model
   appears in "Managed models" and a chat completion works with the returned
   virtual key — with no gateway restart.

4. **Setup-token flow.** Mint a setup token, run one enrollment with it via
   `curl` or `aionas-connect`, then **replay the same token** — the second call
   must return **401 "already used"**.

5. **Legacy automation no-op.** `POST /api/config/apply` (admin token) must
   return 200 with `"reloaded": false`.

## Phase 3 — Cleanup (after smoke tests pass)

1. **Delete the plaintext runtime config** left over from the old flow — it
   contains tenant provider keys in clear text:

   ```bash
   rm -rf ~/litellm-gateway/runtime
   ```

2. **Delete migrated tenant secrets** from Secrets Manager (only after each
   tenant is re-enrolled and verified):

   ```bash
   aws secretsmanager delete-secret --region eu-north-1 \
     --secret-id litellm-gateway/tenants/<name> --force-delete-without-recovery
   ```

3. **Detach the old IAM policy** (`iam-policy-tenant-secrets.json` grants) from
   the instance role — the key-manager no longer touches Secrets Manager.

4. **Remove dangling images:** `docker image prune -f`.

## Rollback

Keep the Phase 0 backups for at least a week. To roll back:

```bash
cd ~/litellm-gateway
git checkout <pre-merge-commit>      # the commit before PR #1's merge
docker compose up -d --build
```

The DB changes made by the new stack are additive (extra model rows, extra
keys), so the old stack starts cleanly against the same database. If the DB
must be restored anyway: `gunzip -c ~/pre-v192-<date>.sql.gz | docker compose
exec -T db psql -U litellm litellm`.

## Known risks

- **Salt-key discipline.** `LITELLM_SALT_KEY` must never change once provider
  credentials are stored; rotating it makes them undecryptable. Compose fails
  fast if it is unset, and `.env.example` documents the rule.
- **Alias guard is load-bearing.** If LiteLLM ever changes how config callbacks
  import (`aionas_extensions` on `PYTHONPATH=/config`), tenant isolation
  degrades to LiteLLM's stock key-scoping. The Phase 2 fail-closed test must be
  re-run after every LiteLLM version bump.
- **Used-token registry is in-memory.** A key-manager restart re-allows an
  unexpired, already-used setup token for the rest of its ≤60-minute TTL.
  Acceptable now; move the registry to Postgres if the key-manager ever runs
  with more than one replica.
