# Farmsky Score Integration (credit.farmsky.africa)

Equipment is the **central host** for Farmsky Score's data and payments, and
consumes Score's APIs for identity + credit decisioning.

## 1. Dedicated database tables (migration `0021_score_platform.sql`)

Score's data lives in its **own** tables, separate from Equipment's own
customer/KYC data:

| Table | Purpose |
|-------|---------|
| `score_subscriptions` | Subscription plans + billing state pushed from Score |
| `score_verifications` | ID verification + liveness results retrieved from Score |
| `score_iprs_checks` | IPRS government-registry lookups |
| `score_credit_evaluations` | Full credit-evaluation decisions |

The migration also registers a `score` row in `app_clients` so Score can call
the central payment gateway.

## 2. Subscription payments from Score

Score's subscription checkout is sent to the **same** central gateway the other
marketplaces use:

```
POST /api/v1/payments/initiate     (HMAC-signed with the 'score' app_clients secret)
```

When the initiate body carries a `subscription` (or `plan`) context, the gateway
records/updates a row in `score_subscriptions`. On settlement, `notifyOriginApp`
calls `syncScoreSubscription` to flip the subscription to `active` (or
`past_due`) and set `current_period_end`.

## 3. Single sign-on (no second login)

The **"Open Score"** button in the Equipment header opens Score with the current
session:

1. Equipment `GET /api/cross/handoff?target=score` mints a short-lived (2 min)
   HMAC-signed token carrying `{phone, email, name}` and returns
   `${SCORE_APP_URL}/sso?token=...`. For `target=score` the token is signed with
   the **Score-channel** secret `SCORE_CROSS_APP_HMAC_SECRET` (legacy
   `CROSS_APP_HMAC_SECRET` fallback); other targets (Feed) use the generic
   `CROSS_APP_HMAC_SECRET`. Signing with the wrong secret is what produces a
   `GET /sso … 401` on Score.
2. Score's `GET /sso` verifies the HMAC + freshness, resolves/creates the
   account by **email**, issues a Score session, and drops the user straight
   into the Score console — no re-login.

The Score↔Equipment `SCORE_CROSS_APP_HMAC_SECRET` must be identical on both apps
(legacy `CROSS_APP_HMAC_SECRET` is still read as a fallback). This is the
dedicated Score channel secret, independent of the generic Feed/Inputs/
Marketplace `CROSS_APP_HMAC_SECRET`.

## 4. Consuming Score's APIs for verification + credit

`backend/score-client.ts` calls Score's `/v3/*` endpoints
(`Authorization: Bearer <client_id>:<secret>` + HMAC request signing) for:

- **ID verification + liveness** → `POST /v3/kyc` (falls back to
  `POST /v3/biometrics/verify`)
- **IPRS** → `POST /v3/iprs/verify`
- **Credit evaluation** → `POST /v3/credit/evaluations`

These are wired into `POST /api/customers/:id/verify`. When Score is configured,
the real results are used and mirrored into the `score_*` tables; otherwise the
endpoint falls back to the local deterministic simulation so the flow always
completes.

> Identity, liveness and IPRS on the Score platform are backed by MetaMap
> (`api.getmati.com` OAuth + GovChecks), verified against
> <https://docs.metamap.com>. Equipment itself does **not** call MetaMap
> directly — it delegates to Score.

## 4a. Read-only wallet & ledger sync — `GET /v3/equipment-sync/*`

Score exposes a dedicated **read-only** sync surface that Equipment polls to
render lender/API wallet visibility, drill-down auditing, and the unified
ledger. It reuses the same auth as §4 (`Authorization: Bearer <client_id>:<secret>`
+ optional HMAC signing) and is guarded by `apiGuard('credit:read')` — **no new
secret is introduced**. `backend/score-client.ts` (`scoreWallets`,
`scoreWalletDetail`, `scoreTransactions`) speaks this scheme and degrades to
`{ live: false }` when Score is unconfigured/unreachable.

| Method & path | Returns |
|---|---|
| `GET /v3/equipment-sync/wallets` | All orgs LEFT JOIN wallets → wallet list with metadata, balance, currency, low-threshold, status (`active`/`low`/`empty`), active API keys, last-activity timestamp. |
| `GET /v3/equipment-sync/wallets/:orgId?limit=` | Wallet snapshot + time-stamped ledger (`wallet_transactions`, category `settlement`/`debit`/`hold`) + `consumption` = { `endpoints` (from `api_telemetry` aggregated by path+method+status class) , `service_fees` (verification debits × `service_pricing`) }. |
| `GET /v3/equipment-sync/transactions?limit=&since=` | Normalized transaction stream: status → `SUCCESS`/`PENDING`/`FAILED`, `source: "score"`, `origin_platform: "score_app"`, `inventory_type: "score"` — shaped to match Equipment's `central_transactions` for the unified ledger. |

On the Equipment side these back `GET /api/score-wallets`,
`GET /api/score-wallets/:orgId`, and the Score stream of `GET /api/ledger`
(see the Equipment README → "Lender API / Score wallet visibility"). When Score
is down, Equipment falls back to the mirrored `score_wallet_ledger` table.

## 5. Environment variables

```
SCORE_CROSS_APP_HMAC_SECRET=<shared with Score — direct Score↔Equipment channel>
# CROSS_APP_HMAC_SECRET=<legacy fallback / generic Feed⇄Equipment SSO>
SCORE_APP_URL=https://credit.farmsky.africa
SCORE_API_URL=https://credit.farmsky.africa
SCORE_API_CLIENT=<API client id Score issued to Equipment>
SCORE_API_SECRET=<paired secret>
```

---

## 6. Credit tenant — metered wallet billing (payment gateway)

The Score app (**credit.farmsky.africa**) is also a **payment tenant** of this Equipment gateway. In addition to the SSO / scoring integration above, it delegates its **pay-as-you-go API-call billing** and **wallet deductions** to the central master wallet documented in `PAYMENT-GATEWAY-INTEGRATION.md §8–§9`.

- **Provisioning:** register Score as a tenant via the `/admin/tenants` dashboard **or** the env-var overrides:
  ```
  TENANT_CREDIT_CLIENT_KEY="credit"          # or "score" — must match Score's PAYMENT_CLIENT_KEY
  TENANT_CREDIT_HMAC_SECRET="<256-bit hex>"  # must match Score's PAYMENT_HMAC_SECRET
  TENANT_CREDIT_WEBHOOK_URL="https://credit.farmsky.africa/api/v1/payment-webhook"
  ```
- **Debit:** Score calls `POST /api/v1/wallet/debit` per billable live API call (atomic, idempotent). A shortfall returns HTTP **402 `INSUFFICIENT_WALLET_BALANCE`**, which Score surfaces to its user as **402 `PAYMENT_REQUIRED`** with a `top_up_url`.
- **Low-balance alerts:** after each debit the gateway fires a signed `WALLET_LOW_BALANCE` webhook to Score's `/api/v1/payment-webhook`, plus SMS + email, honouring the user's thresholds synced via `PUT /api/v1/settings/thresholds`.
- **Coexistence:** this is **non-breaking** — the existing `POST /api/score-ledger/mirror` receiver (Score is the primary local ledger; movements are mirrored here for audit) continues to work unchanged. The master-wallet path is opt-in on the Score side (`PAYMENT_CENTRAL_WALLET=1`).
