# Farmsky Central Payment Gateway — Integration Guide

A single endpoint that the three Farmsky marketplaces — **equipment.farmsky.africa**, **feed.farmsky.africa**, **input.farmsky.africa** — call to initiate M-Pesa, SasaPay and KCB Buni payments. Every transaction stores **`origin_app`** and **`payment_method`** so you always know where it came from and how it was paid.

---

## 1. Endpoint URLs (hosted on this app)

| Purpose | Method | URL |
|---|---|---|
| Initiate payment | `POST` | `https://equipment.farmsky.africa/api/v1/payments/initiate` |
| Check status | `GET`  | `https://equipment.farmsky.africa/api/v1/payments/status/:transaction_ref` |
| M-Pesa IPN (set in Daraja) | `POST` | `https://equipment.farmsky.africa/api/v1/payments/callbacks/mpesa` |
| SasaPay IPN (set in SasaPay portal) | `POST` | `https://equipment.farmsky.africa/api/v1/payments/callbacks/sasapay` |
| Buni IPN (set in KCB Buni portal) | `POST` | `https://equipment.farmsky.africa/api/v1/payments/callbacks/buni` |
| Admin reporting (internal) | `GET` | `https://equipment.farmsky.africa/api/v1/payments-admin/summary` |

---

## 2. Security model

1. **HMAC-SHA256 signed requests** — each marketplace has its own `hmac_secret` stored in the central DB (`app_clients` table). The marketplace signs the canonical string `client_key\ntimestamp\nnonce\nbody` and sends:
   - `X-Farmsky-Client` (e.g. `equipment`)
   - `X-Farmsky-Timestamp` (ms since epoch)
   - `X-Farmsky-Nonce` (UUID per request)
   - `X-Farmsky-Signature` (HMAC-SHA256 hex)

2. **Replay protection** — requests older than 5 minutes are rejected, and recently-seen nonces are blocked.

3. **`origin_app` cannot be spoofed** — it's read from the verified `client_key`, never from the request body.

4. **Idempotency** — optional `Idempotency-Key` header. Re-sending the same key returns the original transaction instead of double-charging.

5. **Provider callbacks bound by `provider_request_id`** — only the real provider knows the ID we got back from our outbound STK push, so spoofed IPNs cannot mark unrelated transactions as paid. Every IPN is logged in `central_callbacks` for audit.

6. **Outbound webhook signing** — when we notify your marketplace that a payment completed, we sign the notification the same way, so you can verify it came from us.

---

## 3. Database tables (run migration `0008_central_payments.sql`)

- **`app_clients`** — one row per marketplace, holds `hmac_secret`, `origin_url`, optional `callback_url`.
- **`central_transactions`** — every payment attempt across all apps + methods, with `origin_app`, `payment_method`, `status`, `provider_receipt`, `amount`.
- **`central_callbacks`** — raw IPN log for audit + replay diagnostics.

The seed inserts three rows for `equipment`, `feed`, `input` with placeholder secrets:
```sql
UPDATE app_clients SET hmac_secret='<long-random-string>' WHERE client_key='equipment';
UPDATE app_clients SET hmac_secret='<long-random-string>' WHERE client_key='feed';
UPDATE app_clients SET hmac_secret='<long-random-string>' WHERE client_key='input';
```
Generate strong secrets with `openssl rand -hex 32`. **Rotate** the same way.

If a marketplace wants async notifications instead of polling:
```sql
UPDATE app_clients SET callback_url='https://feed.farmsky.africa/api/payments/incoming' WHERE client_key='feed';
```

---

## 4. Calling the gateway from a marketplace (Node / Hono / any JS runtime)

```ts
// payments-client.ts (copy to feed/input/equipment apps)
import crypto from 'node:crypto'

const GATEWAY = 'https://equipment.farmsky.africa/api/v1/payments'
const CLIENT_KEY = process.env.FARMSKY_PAYMENTS_CLIENT_KEY!   // 'equipment' | 'feed' | 'input'
const SECRET = process.env.FARMSKY_PAYMENTS_HMAC_SECRET!      // same value as DB row

function signHeaders(body: string) {
  const timestamp = String(Date.now())
  const nonce = crypto.randomUUID()
  const message = `${CLIENT_KEY}\n${timestamp}\n${nonce}\n${body}`
  const signature = crypto.createHmac('sha256', SECRET).update(message).digest('hex')
  return {
    'X-Farmsky-Client': CLIENT_KEY,
    'X-Farmsky-Timestamp': timestamp,
    'X-Farmsky-Nonce': nonce,
    'X-Farmsky-Signature': signature,
    'Content-Type': 'application/json'
  }
}

export async function initiatePayment(opts: {
  amount: number
  phone: string
  payment_method: 'mpesa' | 'sasapay' | 'buni'
  origin_reference?: string        // your order/contract id
  description?: string
  initiated_by_user?: number
  idempotency_key?: string
}) {
  const body = JSON.stringify(opts)
  const headers: Record<string, string> = signHeaders(body)
  if (opts.idempotency_key) headers['Idempotency-Key'] = opts.idempotency_key
  const res = await fetch(`${GATEWAY}/initiate`, { method: 'POST', headers, body })
  return await res.json() as {
    success: boolean
    transaction_ref?: string
    payment_method?: string
    origin_app?: string
    simulated?: boolean
    customer_message?: string
    status?: string
    error?: string
  }
}

export async function getPaymentStatus(transaction_ref: string) {
  // For GET we sign the path
  const headers = signHeaders(transaction_ref)
  const res = await fetch(`${GATEWAY}/status/${transaction_ref}`, { headers })
  return await res.json()
}
```

### Example usage in a marketplace order checkout

```ts
const r = await initiatePayment({
  amount: 7500,
  phone: '+254712345678',
  payment_method: 'mpesa',
  origin_reference: order.id,                   // your order id
  description: 'Feed order #' + order.id,
  initiated_by_user: user.id,
  idempotency_key: 'order-' + order.id          // safe to retry
})

if (r.success) {
  saveTransactionRef(order, r.transaction_ref!) // store for later polling
  // Show user: "STK prompt sent to your phone…"
}
```

Then poll every few seconds until `status === 'SUCCESS'` or `'FAILED'`, OR set `app_clients.callback_url` to receive a signed POST as soon as we know.

---

## 5. Where did each payment come from?

Every row in `central_transactions` carries both fields, so any of these is a one-liner:

```sql
-- Per-marketplace totals
SELECT origin_app, COUNT(*), SUM(amount)
  FROM central_transactions
 WHERE status='SUCCESS'
 GROUP BY origin_app;

-- Per-payment-method totals
SELECT payment_method, COUNT(*), SUM(amount)
  FROM central_transactions
 WHERE status='SUCCESS'
 GROUP BY payment_method;

-- App × method matrix
SELECT origin_app, payment_method, COUNT(*), SUM(amount)
  FROM central_transactions
 WHERE status='SUCCESS'
 GROUP BY origin_app, payment_method
 ORDER BY origin_app, payment_method;
```

Or hit `GET /api/v1/payments-admin/summary` for a JSON version of those three queries (admin-only).

---

## 6. Operational checklist

- [ ] Apply `migrations/0008_central_payments.sql` on the central DB
- [ ] Rotate the three seed `hmac_secret` values with `openssl rand -hex 32`
- [ ] Put each secret in the corresponding marketplace's env as `FARMSKY_PAYMENTS_HMAC_SECRET`
- [ ] Set the three provider IPN URLs above in M-Pesa Daraja, SasaPay and KCB Buni dashboards
- [ ] Configure `MPESA_*`, `SASAPAY_*`, `BUNI_*` env vars on this app (see `.env.example`)
- [ ] (Optional) Set `callback_url` per app if you prefer push notifications over polling

---

## 7. Multi-tenant architecture & Single Merchant Shortcode (Instructions 6–18)

All three marketplaces — **equipment.farmsky.africa** (the **MAIN** app), **feed.farmsky.africa** and **mazao.farmsky.africa** — settle through **ONE** merchant shortcode. Payments flow through a single **Centralized Payment Gateway** service (deployable at `payment-api.farmsky.africa`), isolated from the marketplace business logic. Tenant isolation is enforced at **two independent layers**:

1. **Database layer — PostgreSQL Row-Level Security (RLS)** keyed on `marketplace_id`.
2. **Network layer — HMAC-SHA256 cryptographic payload validation** (Section 2).

### 7.1 Tenant registry & schema

`migrations/0011_central_multitenancy_rls.sql` adds:

- **`marketplaces`** — one row per tenant (`equipment` is `is_main=1`, plus `feed`, `mazao`), mapping `marketplace_key` → `domain`.
- **`marketplace_id`** columns on `central_transactions` and `central_callbacks` (back-filled from `origin_app`).
- **`payment_audit_log`** — suspicious-activity audit trail (`SIGNATURE_FAIL`, `REPLAY`, `CALLBACK_NO_MATCH`, etc. with `severity`).
- **`payment_nonces`** — `UNIQUE(client_key, nonce)` store that makes replay rejection atomic.

The gateway stamps every transaction with the tenant's `marketplace_id`, resolved from the verified `client_key` (never the request body).

### 7.2 Row-Level Security setup (run ONCE as a superuser)

```bash
psql "$SUPERUSER_DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/sql/01_payment_rls_setup.sql
```

This script:

- Creates an **isolated least-privilege role** `payment_api_user` (`NOSUPERUSER NOCREATEDB NOCREATEROLE`) that can only touch the payment tables.
- **`ENABLE` + `FORCE` RLS** on `central_transactions`, `central_callbacks`, `payment_audit_log`.
- Adds tenant-isolation policies using two per-connection GUCs:
  - `app.current_marketplace_id` — the active tenant.
  - `app.is_admin` — `true` only for the MAIN app's reconciliation role (RLS bypass to read across tenants).

The gateway sets these on every request via `PostgresD1.setSessionConfig()` → `SELECT set_config('app.current_marketplace_id', …, false)`. A compromised or buggy marketplace connection **cannot read or alter another tenant's rows — the database itself refuses**.

> Change the `payment_api_user` password from `CHANGE_ME_IN_PROD` before production, and put its connection string in the payment gateway service's `DATABASE_URL`.

### 7.3 Deploying the gateway as a separate Render web service

Run the payment gateway as its own Render web service (same codebase, different DB user):

| Setting | Value |
|---|---|
| Service | `payment-api.farmsky.africa` (separate Render web service) |
| Build | `npm run build:node` |
| Start | `node dist-node/server.js` |
| `DATABASE_URL` | `postgres://payment_api_user:<pw>@<farmsky-central-db-host>/farmsky_central` |
| Providers | `MPESA_*`, `SASAPAY_*`, `BUNI_*` for the shared shortcode |

Because it connects as `payment_api_user`, RLS is *forced* even for the app's own queries — the isolation cannot be bypassed from application code.

### 7.4 Automated audits (run as the MAIN reconciliation role)

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/sql/02_payment_security_audits.sql
```

Also exposed as admin JSON endpoints on the MAIN app:

| Purpose | Method | URL |
|---|---|---|
| Revenue matrix (marketplace × method) — single-shortcode attribution | `GET` | `/api/v1/payments/admin/revenue-matrix` |
| Suspicious-activity audit (signature fails, replays, integrity breaks, spoofed callbacks) | `GET` | `/api/v1/payments/admin/suspicious-activity` |

The **revenue matrix** is how a single settlement statement from the one shortcode is attributed back to each marketplace tenant.

### 7.5 Multi-tenant operational checklist

- [ ] Apply `migrations/0011_central_multitenancy_rls.sql` (auto-applied on boot)
- [ ] Run `backend/sql/01_payment_rls_setup.sql` once as superuser; change `payment_api_user` password
- [ ] Set the mazao `hmac_secret` (`UPDATE app_clients SET hmac_secret=… WHERE client_key='mazao';`)
- [ ] Deploy the gateway as a separate Render service using the `payment_api_user` `DATABASE_URL`
- [ ] Schedule `backend/sql/02_payment_security_audits.sql` (or poll the two admin endpoints)

---

## 8. Central Master Wallet — metered (pay-as-you-go) API billing

Beyond one-off checkout, the gateway now hosts a **central master wallet + ledger** so client tenants (e.g. the **Credit / Score** app at `credit.farmsky.africa`) can delegate **usage-based API-call billing** and **wallet deductions** to this app. Equipment is the **single host + ledger engine**; tenants never keep their own authoritative money ledger.

### 8.1 Endpoints (same `X-Farmsky-*` HMAC scheme as §2)

| Purpose | Method | URL |
|---|---|---|
| Metered per-call debit | `POST` | `https://equipment.farmsky.africa/api/v1/wallet/debit` |
| Record a top-up / settlement | `POST` | `https://equipment.farmsky.africa/api/v1/wallet/credit` |
| Read master-wallet balance | `GET`  | `https://equipment.farmsky.africa/api/v1/wallet/balance?user_id=<ref>` |
| Read alert thresholds | `GET`  | `https://equipment.farmsky.africa/api/v1/settings/thresholds?user_id=<ref>` |
| Upsert alert thresholds | `PUT`  | `https://equipment.farmsky.africa/api/v1/settings/thresholds` |

All calls carry the standard headers: `Content-Type`, `X-Farmsky-Client`, `X-Farmsky-Timestamp`, `X-Farmsky-Nonce`, `X-Farmsky-Signature`, and (for mutating calls) `Idempotency-Key`. Replay protection reuses the shared `payment_nonces` table.

### 8.2 Debit request / response

`POST /api/v1/wallet/debit`
```json
{ "user_id": "<org/user ref>", "amount": 12, "currency": "KES",
  "origin_reference": "SVC-credit_check-...", "idempotency_key": "SVC-credit_check-...",
  "description": "Metered credit_check API call", "metadata": { } }
```

**Success (HTTP 200):**
```json
{ "success": true, "transaction_ref": "DEBIT_EQ_…", "debited_amount": 12,
  "remaining_wallet_balance": 488, "status": "COMPLETED",
  "low_balance_alert": { "dispatched": true, "level": "warning" } }
```

**Insufficient funds (HTTP 402):**
```json
{ "success": false, "error_code": "INSUFFICIENT_WALLET_BALANCE",
  "required_amount": 12, "current_balance": 4, "currency": "KES" }
```

The debit is **atomic** (a conditional `UPDATE … WHERE balance_kes >= amount`) so concurrent calls can never drive the balance negative. `Idempotency-Key` (recorded as `tenant_wallet_ledger.transaction_ref`) makes retries safe — the original result is replayed.

### 8.3 User-configurable low-balance alerts

After **every** debit the gateway evaluates the post-debit balance against the tenant user's **custom thresholds** (`tenant_alert_settings`):

- `balance <= critical_threshold` → **critical**
- `balance <= warning_threshold` → **warning**

An alert fires at most **once per level per 24h** (`tenant_alert_state` cooldown); the state resets when a `credit` clears the warning threshold. Dispatch is multi-channel and per-channel-toggleable:

1. **Signed webhook** `WALLET_LOW_BALANCE` → the tenant's `webhook_url` (falls back to `callback_url`), signed with the tenant's own `hmac_secret` using the same `X-Farmsky-*` scheme.
2. **SMS** to `notify_phone` (via `backend/sms.ts`).
3. **Email** to `notify_email` (via `backend/email.ts`).

`WALLET_LOW_BALANCE` webhook body:
```json
{ "event": "WALLET_LOW_BALANCE", "event_id": "evt_lowbal_…", "timestamp": "…",
  "data": { "user_id": "…", "organization_name": "Farmsky Credit",
            "alert_level": "WARNING", "current_balance": 800,
            "user_configured_threshold": 1000, "currency": "KES",
            "recommended_topup_amount": 5000 } }
```

### 8.4 Thresholds sync (`/api/v1/settings/thresholds`)

The Credit dashboard lets a user set `warning_threshold`, `critical_threshold` and channel toggles; it `PUT`s them here so the gateway evaluates them on each debit:
```json
{ "user_id": "<ref>", "warning_threshold": 1000, "critical_threshold": 250,
  "channels": { "email_enabled": true, "sms_enabled": true, "webhook_enabled": true },
  "notify_email": "owner@org", "notify_phone": "2547…" }
```

### 8.5 Data model (migration `0031_tenant_wallet_and_thresholds.sql`)

- `tenant_wallets(client_key, user_ref, balance_kes, currency)` — master balances, `UNIQUE(client_key,user_ref)`.
- `tenant_wallet_ledger(direction, amount_kes, balance_after, origin_reference, transaction_ref UNIQUE, meta)` — every movement.
- `tenant_alert_settings(warning_threshold, critical_threshold, *_enabled, notify_email, notify_phone)` — per-user thresholds.
- `tenant_alert_state(alert_level, last_sent_at, cleared)` — 24h cooldown / dedup.
- `app_clients` gains `webhook_url`, `secret_rotated_at`, `provisioned_via`, `updated_at`.

All statements are additive/idempotent (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`) — **non-breaking** to the existing gateway.

---

## 9. Tenant management (dynamic provisioning)

A tenant is a row in **`app_clients`**. There are two ways to provision one; both are non-breaking and can coexist.

### 9.1 Option A — Admin Dashboard (`/admin/tenants`)

Signed-in **admin / super_admin** operators get a **Payment Tenants** page (Equipment console → sidebar → *Payment Tenants*) backed by:

| Purpose | Method | URL |
|---|---|---|
| List tenants (secrets masked) | `GET`  | `/api/v1/admin/tenants` |
| Create / update a tenant | `POST` | `/api/v1/admin/tenants` |
| Rotate HMAC secret | `POST` | `/api/v1/admin/tenants/:client_key/rotate-secret` |
| Enable / disable a tenant | `PUT`  | `/api/v1/admin/tenants/:client_key/status` |

The full `hmac_secret` is returned **only** at the moment it is minted or rotated (shown once in a copy-to-clipboard modal); every list view masks it. Editing a tenant updates its display name, origin URL, webhook URL and active status **without a restart**.

### 9.2 Option B — Environment-variable overrides (boot-time)

At startup `backend/server.ts` scans for `TENANT_<NAME>_CLIENT_KEY` and upserts each into `app_clients` with `provisioned_via='env'`:

```
TENANT_CREDIT_CLIENT_KEY="credit"
TENANT_CREDIT_HMAC_SECRET="<256-bit hex>"
TENANT_CREDIT_WEBHOOK_URL="https://credit.farmsky.africa/api/v1/payment-webhook"
```

This is the recommended way to pin the Credit tenant in production; the dashboard can still rotate its secret afterwards.
