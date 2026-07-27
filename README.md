# Farmsky — Sharia-Compliant Murabaha Agri-Finance

A demo lending platform for agriculture & livestock. Customers buy farm inputs
(feed, fertilizer, seeds, equipment, livestock) via **cash** or **Murabaha credit**
— a fixed cost-plus-markup model with **no interest, no penalties, no compounding**
(fully Sharia-compliant).

## Features
- 5 roles: Super Admin, Admin, Agent, Customer/Farmer, Customer Support
- **Customer self sign-up, sign-in & password reset with SMS OTP** — works with
  any OAuth 2.0 / Bearer-token SMS gateway (configured via env vars). If no SMS
  provider is set, runs in **demo mode** (OTP shown on screen) so flows stay testable.
- **Agent onboarding from the Admin dashboard** — set a password at creation (or
  auto-generate one) plus a **one-click "Reset Password"** button (auto-generates a
  new password and shows it to the admin to share). Agents then sign in normally.
- **Admin Data Export** — pick a dataset (users, customers, agents, products,
  contracts, repayments, transactions, audit logs), apply **filters** + date range,
  preview, then **download as CSV / Excel (.xlsx)** locally, or **share by email**
  (CSV attachment) when an email provider is configured.
- Agent-led customer onboarding (with GPS capture)
- **Complete User Registration**: TransUnion check + Live ID / liveness
  verification (camera). Required before Pay Later (Murabaha Financing) purchases.
- Inventory with **product images** (shown to buyers) + stock movements
- **Pay Later (Murabaha Financing)** quoting, application, approval, repayment tracking
- **M-Pesa Daraja STK Push** payments (live when keys set, simulated otherwise)
- Admin CRUD for users, agents, and inventory (edit / activate / deactivate / delete)
- Role-aware dashboards & analytics
- **Financing & Markup Settings** (Super Admin → *Financing Settings*): configure
  default markup percentages and a flexible **Processing Fee** — either a
  **percentage** of the amount borrowed, or a **tiered range table** (e.g.
  `100,000–200,000 → flat 8,000`) with add / edit / delete rows.
- **Dynamic role labelling & granular permissions**: Super Admins create custom
  role labels via free-text (e.g. *Operations and Finance*, *Agent*, *Lender*) and
  assign fine-grained permissions — Manage Processing Fees, Manage Markup %,
  Sales Visibility (Cash vs Financed), and Data Object Visibility (Farmer Profile,
  Financial Data, Document Attachments — Front/Back ID & passport photo).
- **Time-Based Access Control**: per-role or per-user login windows (active days +
  hour range). Access is blocked outside the configured window.
- **Payments**: M-Pesa and SasaPay only (with brand logos). KCB Buni is hidden
  from the front-end user.

## Configuration (env)
All integrations are env-driven — at deploy you just **copy-paste** the
tokens into `.env` (see `.env.example` for step-by-step instructions):
- **M-Pesa Daraja STK Push**: `MPESA_*` — sandbox defaults pre-filled; paste your
  sandbox Consumer Key/Secret to test, or leave blank for simulation. STK push
  is used for **both cash checkout and Pay Later (Murabaha) repayments**.
- **SMS OTP — TalkSASA** (`talksasa.com`): paste `SMS_API_TOKEN` + `SMS_SENDER_ID`
  (your Safaricom-registered NameID). Endpoint defaults automatically. Blank = demo
  mode (OTP shown on screen).
- **Email share — Resend** (`resend.com`): paste `EMAIL_API_TOKEN` (re_xxx) +
  `EMAIL_FROM` (verified address). Blank = email button disabled, local download
  still works.

## Test credentials
| Role | Phone | Password |
|------|-------|----------|
| Admin | `+2547500000` | `1224` |
| Agent | `+2547400000` | `1225` |
| Customer | `+2547300000` | `1226` |
| Support | `+2547200000` | `1227` |

## Run locally (Node server)
```bash
npm install
npm run build:node
cp .env.example .env     # add M-Pesa keys (optional; blank = simulation)
npm start                # http://localhost:8080
```

## Run locally (Cloudflare dev)
```bash
npm install
npm run build
npx wrangler d1 migrations apply webapp-production --local
npm run db:seed
npx wrangler pages dev dist --d1=webapp-production --local --port 3000
```

## Farmsky Score integration — "Use APIs" (Lender tier)
Lenders on the Equipment platform can enable and begin consuming the Farmsky
Score verification & credit APIs directly:

- **"Use APIs" button** — shown in the top bar **only** to users whose role is
  `lender` (and only when `SCORE_APP_URL` + `CROSS_APP_HMAC_SECRET` are set).
  Clicking it records the lender's opt-in (`POST /api/cross/use-apis`, lender-only,
  audited) then performs a single sign-on handoff to the Score console's
  **API Access** tab (`GET /api/cross/handoff?target=score&dest=api-access`) — no
  second login.
- **Feature parity** — lenders added manually here in Equipment and lenders who
  self-register on Score receive identical features, permissions, and dashboards.
- **Permission controls** — API enablement, sandbox/production mode, and pricing
  tier are governed on the Score side and approved by a Farmsky **Super-Admin**.
  The **User Accounts & Access** view documents this inline.
- **Cross-app config** — `GET /api/cross/config` returns `score_configured` /
  `score_url` so the UI only shows the button when Score is wired up.
- **Dashboard views** — lenders get an **API Access** sidebar view (feature cards +
  a visible "Use APIs" action), and admins/super-admins get an **API Management**
  view that lists lender accounts and single-sign-on into the Score **Super-Admin**
  portal (`dest=superadmin`) or a lender's console.

### Required env for seamless Score alignment
Set these so the Equipment ⇄ Score handoff works with **no second login**:

| Variable | Where | Value |
|---|---|---|
| `CROSS_APP_HMAC_SECRET` | **Both** Equipment *and* Score services | The **same** random secret on both — Score's `/sso` verifies the handoff token with it. A mismatch shows *"sign-in link could not be verified"*. |
| `SCORE_APP_URL` | Equipment service | `https://score.farmsky.africa` — without it `score_configured` is `false` and the buttons never appear. |

> The Score side must also be migrated/deployed (its `0000_repair` migration builds
> the `organizations`/`users` tables the `/sso` handoff writes to). Verify Score
> health at `GET https://score.farmsky.africa/v3/health` → `otp_deliverable: true`.

### ⚠️ Sharing this database with the Score app — Score must set `DB_SCHEMA=score`
Equipment is the **central database host**: the Score app can point at the **same**
PostgreSQL instance. Both apps independently define same-named tables (`users`,
`organizations`, `sessions`, `otp_codes`, …) but with **incompatible column
types** — Equipment uses `integer`/`bigint` ids and epoch-millisecond
`expires_at`; Score uses `uuid` ids and `timestamptz`. If both wrote to the same
`public` schema they would collide (this caused Score's login/sign-up 500s:
`operator does not exist: uuid = integer` and `invalid input syntax for type bigint`).

**Resolution — Score isolates itself into a dedicated `score` PostgreSQL schema**
by setting **`DB_SCHEMA=score`** on the *Score* service (its connections use
`search_path=score,public`). Equipment needs **no change**: it continues to own and
use the `public` schema exactly as before, and Score never reads, alters, or drops
Equipment's `public.*` tables. Equipment's own `0021_score_platform.sql`
`score_`-prefixed integration tables (subscriptions/verifications) are unaffected —
they remain in Equipment's `public` schema and are distinct from Score's internal
`score.*` schema.

> **No action required on the Equipment service** for this — just ensure the Score
> service has `DB_SCHEMA=score` set (see the Score app's README → "Sharing ONE
> database with the Equipment app"). Equipment's default `public` search_path is
> correct and unchanged.

## Database migrations (auto-apply on boot)
On startup the Node server runs every `migrations/*.sql` through
`backend/db-init.ts` (SQLite dialect → PostgreSQL, idempotent). Notes for
production databases that were created by an **older schema**:

- **`0014_demo_accounts_kyc_uniqueness.sql` — UUID/INTEGER fix.** On the shared
  central database the `users.id` (and `customers.user_id`) columns are **UUID**,
  so the original migration's integer-id UPDATEs
  (`UPDATE users … WHERE id = 1`, `UPDATE customers … WHERE user_id = 3`) failed
  with `operator does not exist: uuid = integer` (SQLSTATE `42883`) /
  `invalid input syntax for type integer` (`22P02`). The demo-phone backfill is
  now wrapped in a `DO $$ … $$` guard that inspects `users.id`'s data type and
  only runs the integer-keyed UPDATEs when the column is actually an integer
  type; the customer match casts to text (`CAST(user_id AS TEXT) = '3'`). Verified
  on a fresh UUID database: **0** `42883`/`22P02` errors, 0 skipped statements.

### User Management (Admin) fixes
- **Edit User button** now works on UUID-keyed databases. The Users-list row
  actions previously interpolated the id **without quotes**
  (`onclick="editUserModal(${u.id})"`), which produced invalid JS for a UUID
  string; they now quote + stringify (`editUserModal('${esc(String(u.id))}')`),
  and the finder loose-compares `String(x.id) === String(id)`.
- **"No Active Code, Request a New One" on Create User** is fixed. `POST /api/users`
  previously **always** required a phone OTP when no password was supplied, so a
  blank-password create always failed (no onboard OTP is ever requested). It now
  only verifies an OTP when `otp_code` is explicitly provided; otherwise the
  admin-authenticated create **auto-generates a temporary password** (SMS'd).
  The Add-User (`nu_pwd`) and Edit-User (`eu_pwd`) password fields are present.
- **`null value in column "org_id" of relation "users"` on Create User is fixed.**
  On the shared central `farmsky_central_db`, the Score platform owns
  `public.users` and declares `org_id UUID NOT NULL`. Equipment never populated
  it, so **every** user INSERT (admin create, agent create, public self-signup,
  bulk import, and the `0027` super-admin bootstrap) failed with `23502`. Each
  insert path now supplies a tenant:
  - **Admin-created** users (`POST /api/users`, `POST /api/agents`, bulk import)
    inherit the **creating admin's `org_id`** (loaded onto the session in
    `getSessionUser`, re-read from the DB if the session predates it).
  - **Public self-signup** (`/api/signup/verify`) and any creator lacking an org
    fall back to a resolved **default tenant**: `EQUIPMENT_ORG_ID` /
    `DEFAULT_ORG_ID` env → the most-populated existing `org_id` → the oldest
    `organizations` row.
  - Migration **`0027`** now inserts the super-admin with a `DO $$` block that
    detects the `org_id` column and attaches the same default tenant.
  - Every insert is **shape-aware**: the `org_id` column is only referenced when
    it actually exists (`usersHasOrgId()` probe), so the Equipment-only SQLite/D1
    dev DB (no `org_id`) still works. Verified end-to-end on a reproduced central
    shape: all 5 creation paths populate `org_id`, **0** `23502` errors.

- **`0007_widen_epoch_columns.sql` is self-healing.** `expires_at` on
  `sessions` / `otp_codes` is stored as an epoch-millisecond **BIGINT**. If a
  legacy database created those columns as `TIMESTAMP`/`TIMESTAMPTZ`, a direct
  cast is impossible and Postgres aborted the whole init with:
  `cannot cast type timestamp with time zone to bigint` →
  `Database initialization failed`. The migration now inspects each column and
  converts a timestamp to epoch-millis (`EXTRACT(EPOCH …)*1000`, dropping the
  timestamp default first), widens an integer straight to BIGINT, and skips a
  column that is already BIGINT. It is conditional + idempotent.
- The migration runner's statement splitter is **dollar-quote / quote / comment
  aware**, so PL/pgSQL `DO $$ … $$` blocks (like the one above) are executed as a
  single statement instead of being shredded at their internal semicolons.
- **`0023_ensure_users_columns.sql` is defensive & self-healing.** On the shared
  central DB a sibling app (Score) also has a `users` table. If a sibling created
  a `public.users` **before** Equipment's `0001` ran, `0001`'s
  `CREATE TABLE IF NOT EXISTS users` silently did nothing, so the Equipment
  `password` column (and others) never existed — producing
  `column "password" of relation "users" does not exist` (42703) on login/user
  management. `0023` runs LAST and idempotently `ADD COLUMN IF NOT EXISTS` for the
  **full set** of columns the app writes to `users` (`password`, `password_set`,
  `must_change_password`, `is_temp_password`, `temp_password_expires_at`,
  `created_by`, `label`, `permissions`, `avatar_url`, `schedule_enabled`,
  `access_days`, `access_start`, `access_end`), converging the schema no matter
  who created the table or in what order.
- **The runner is now resilient at the STATEMENT level, not just the file level.**
  Previously a single incompatible statement in a file (e.g. a foreign key whose
  referenced table was created by a sibling app with a different id type) threw
  and aborted every **subsequent** `CREATE TABLE` in the *same* file, leaving core
  tables (`products`, `agents`, `customers`, …) missing → downstream
  `relation … does not exist` errors. `backend/db-init.ts` now logs and **skips**
  the offending statement so the rest of the file still runs; all DDL is
  idempotent so the schema converges on the next deploy.
- **`0024_sessions_user_id_text.sql` + `0025_userref_columns_text.sql` make every
  *user-id* column type-agnostic.** On the shared central DB, Score's `users`
  table uses a **UUID** primary key, while Equipment declared its user-reference
  columns as `INTEGER`. Two failures resulted:
  1. `createSession()` inserted the (UUID) `users.id` into `sessions.user_id`
     (INTEGER) → `invalid input syntax for type integer: "90ebd36d-…"` (**22P02**)
     at `createSession`, breaking **signup, OTP verification, login and password
     reset** — every path that mints a session.
  2. Tables whose columns carried `… INTEGER … REFERENCES users(id)`
     (`customers`, `agents`, `change_requests`) could not satisfy a cross-type FK,
     so Postgres rejected the whole `CREATE TABLE` (42804) and the resilient
     runner **skipped the entire table** → `relation "customers" does not exist`
     (42P01) during signup.

  The fix is in two parts: `backend/db-init.ts` now **strips inline
  `REFERENCES users(id)` foreign keys** from `CREATE TABLE` bodies (the FK adds no
  real integrity guarantee across apps on a shared DB), so those tables always
  create; and `0024`/`0025` idempotently widen `sessions.user_id`,
  `audit_logs.user_id`, `customers.user_id`, `customers.agent_id`,
  `agents.user_id` and `change_requests.requester_id` to **TEXT** (only when not
  already text/varchar), so they losslessly hold an integer-as-string **or** a
  UUID string. The session read path joins with `CAST(u.id AS TEXT) = s.user_id`
  and all session INSERT/DELETE bind params are cast `CAST(? AS TEXT)`, so auth
  works whether `users.id` is INTEGER (Equipment's own schema) or UUID (shared
  central DB). Verified end-to-end against a reproduced UUID-users database:
  signup → OTP → login → session read → logout → password-reset all succeed with
  **zero** 22P02 / `does not exist` errors.

- **`0026_all_userref_columns_text.sql` + `0027_ensure_superadmin.sql` finish the
  job for the *legacy* Equipment features on the shared UUID DB.** `0024`/`0025`
  only widened a hand-picked set of columns, so several legacy modules still
  broke on a UUID `users.id`:
  - **Inventory** — `products.finance_set_by` (INTEGER) rejected a UUID on
    product create (**22P02**).
  - **Wallet / payouts / withdrawals** — `wallets.user_id`, `wallet_ledger.user_id`,
    `earning_rules.user_id`, `payout_batches.issued_by`, `payout_accounts.user_id`,
    `wallet_withdrawals.user_id/recipient_user_id` and every `*_by`/`*_user_id`
    audit column were INTEGER.
  - **Murabaha** — `murabaha_contracts.agent_id/created_by` were INTEGER.

  `0026` runs a **dynamic PL/pgSQL loop** that widens *every* `public` column whose
  name matches a user-reference pattern (`user_id`, `agent_id`, `requester_id`,
  `reviewer_id`, `recipient_user_id`, `created_user_id`, `initiated_by_user`, or
  `LIKE '%_by'`) and is still integer/bigint/smallint, to **TEXT** — with an
  EXCLUDE set that protects genuinely non-user id columns (`supplier_id`,
  `customer_id`, `contract_id`, `product_id`, `wallet_id`, `batch_id`, `row_id`,
  `checkout_id`, `intent_id`, `ticket_id`, `transaction_id`, `repayment_id`,
  `approval_id`, `key_id`, `backup_id`, `amendment_id`, `rule_id`, `account_id`,
  `payout_account_id`). It is idempotent (only converts non-text columns) and
  catches new user-ref columns automatically on future deploys. In tandem,
  `backend/index.tsx` now (a) returns `getSessionUser().id` as a **String**, (b)
  casts all `users.id` JOINs `CAST(u.id AS TEXT) = <textcol>` (12 sites), and (c)
  reads `b.user_id` from request bodies as a **string** (no more `Number(b.user_id)`
  → `NaN` on UUIDs) across the wallet/earning-rule/payout/direct-pay handlers.

  `0027` idempotently guarantees an **active `super_admin`** exists with the
  canonical phone **`254702875711`** (login: `0702875711` / `1224`), id-type-agnostic
  (it never references `users.id`, matching on role/phone and letting the table's
  own PK default generate the id) so it seeds correctly whether `users.id` is
  INTEGER or UUID. Verified end-to-end against a reproduced UUID-users database:
  RBAC (users/agents/permissions/role-templates/change-requests), inventory
  (product CRUD/stock/finance), **wallet (create/assign, earning rules, ledger,
  payouts single + all-agents, direct-pay, analytics, withdrawals)**, payments
  (M-Pesa/SasaPay/Buni STK push + settlement), murabaha (quote/apply/decision),
  customers/KYC, imports, backups, profile-amendments and the Score SSO handoff
  (super-admin assertion) all execute with **zero** 22P02 runtime errors.

A healthy boot logs `PostgreSQL ready: …` with no `Migration … error` lines
(occasional `statement skipped` warnings on a shared DB are expected and benign).

## Deploy
See **[AWS_DEPLOYMENT.md](./AWS_DEPLOYMENT.md)** for:
- AWS EC2 (recommended easy path) — Nginx + free HTTPS
- AWS App Runner (Docker, no server management)
- Cloudflare Pages (free tier)
- Full M-Pesa Daraja credential setup (where to copy each key)

## Tech
- **Hono** (TypeScript) — runs on Cloudflare Workers *and* Node (`@hono/node-server`)
- **SQLite** via `better-sqlite3` on Node / **Cloudflare D1** on the edge
  (same SQL, via a small D1-compatible adapter in `src/db-sqlite.ts`)
- Vanilla JS SPA (Tailwind CDN, FontAwesome, Axios)

## Project layout
```
src/index.tsx     # Hono app (all API routes + HTML shell) — shared by both builds
src/mpesa.ts      # M-Pesa Daraja STK Push integration
src/server.ts     # Node entry point (AWS)
src/db-sqlite.ts  # D1-compatible SQLite adapter for Node
src/db-init.ts    # auto-applies migrations + seed on first boot
public/static/    # app.js, style.css, farmsky-logo.png, favicon.png
migrations/       # SQL schema
seed.sql          # demo data
Dockerfile        # for App Runner / ECS
.env.example      # env + M-Pesa credential instructions
```
