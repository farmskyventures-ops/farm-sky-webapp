import 'dotenv/config'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Hono } from 'hono'
import app from './index'
import { openDatabase } from './db-postgres'
import { initializeDatabase } from './db-init'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, '..')

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/farmsky'
const migrateOnly = process.argv.includes('--migrate-only')

// Open a pool immediately (cheap, lazy connections) so `d1` can be wired into ENV
// before the (potentially slow) migration/seed pass runs. On Render cold starts the
// migration pass can take several seconds; we must NOT let it block the HTTP port
// from binding, otherwise inbound webhooks (e.g. SasaPay callbacks) hit a refused /
// timed-out connection => "Max retries exceeded" and the settlement is lost.
const { d1, raw } = await openDatabase(DATABASE_URL)

// Tracks whether migrations/seed have finished. Requests that need the DB before
// this flips true get a fast 503 (retryable) instead of hanging the connection.
let dbReady = false
let dbInitError: string | null = null

if (migrateOnly) {
  // In migrate-only mode we DO want to block and exit after migrating.
  await initializeDatabase(raw, PROJECT_ROOT)
  console.log(`PostgreSQL ready: ${DATABASE_URL.replace(/:[^:@/]+@/, ':***@')}`)
  await raw.end()
  process.exit(0)
}

const ENV = {
  DB: d1,
  MPESA_CONSUMER_KEY: process.env.MPESA_CONSUMER_KEY,
  MPESA_CONSUMER_SECRET: process.env.MPESA_CONSUMER_SECRET,
  MPESA_SHORTCODE: process.env.MPESA_SHORTCODE,
  MPESA_PASSKEY: process.env.MPESA_PASSKEY,
  MPESA_ENV: process.env.MPESA_ENV,
  MPESA_CALLBACK_URL: process.env.MPESA_CALLBACK_URL,
  // SasaPay - accept either CLIENT_* or CONSUMER_* naming (auto-alias)
  SASAPAY_CLIENT_ID:     process.env.SASAPAY_CLIENT_ID     || process.env.SASAPAY_CONSUMER_KEY,
  SASAPAY_CLIENT_SECRET: process.env.SASAPAY_CLIENT_SECRET || process.env.SASAPAY_CONSUMER_SECRET,
  SASAPAY_CONSUMER_KEY:    process.env.SASAPAY_CONSUMER_KEY    || process.env.SASAPAY_CLIENT_ID,
  SASAPAY_CONSUMER_SECRET: process.env.SASAPAY_CONSUMER_SECRET || process.env.SASAPAY_CLIENT_SECRET,
  SASAPAY_MERCHANT_CODE: process.env.SASAPAY_MERCHANT_CODE,
  SASAPAY_ENV: process.env.SASAPAY_ENV,
  SASAPAY_CALLBACK_URL: process.env.SASAPAY_CALLBACK_URL,
  SASAPAY_B2C_CALLBACK_URL: process.env.SASAPAY_B2C_CALLBACK_URL || process.env.SASAPAY_CALLBACK_URL,
  BUNI_CLIENT_ID: process.env.BUNI_CLIENT_ID,
  BUNI_CLIENT_SECRET: process.env.BUNI_CLIENT_SECRET,
  BUNI_API_KEY: process.env.BUNI_API_KEY,
  BUNI_TILL_NUMBER: process.env.BUNI_TILL_NUMBER,
  BUNI_ENV: process.env.BUNI_ENV,
  BUNI_CALLBACK_URL: process.env.BUNI_CALLBACK_URL,
  SMS_PROVIDER: process.env.SMS_PROVIDER,
  SMS_API_URL: process.env.SMS_API_URL,
  SMS_API_TOKEN: process.env.SMS_API_TOKEN,
  SMS_SENDER_ID: process.env.SMS_SENDER_ID,
  SMS_BODY_TEMPLATE: process.env.SMS_BODY_TEMPLATE,
  SMS_PHONE_FIELD: process.env.SMS_PHONE_FIELD,
  SMS_MESSAGE_FIELD: process.env.SMS_MESSAGE_FIELD,
  EMAIL_PROVIDER: process.env.EMAIL_PROVIDER,
  EMAIL_API_URL: process.env.EMAIL_API_URL,
  EMAIL_API_TOKEN: process.env.EMAIL_API_TOKEN,
  EMAIL_FROM: process.env.EMAIL_FROM,
  TRANSUNION_API_URL: process.env.TRANSUNION_API_URL,
  TRANSUNION_API_KEY: process.env.TRANSUNION_API_KEY,
  TRANSUNION_CLIENT_ID: process.env.TRANSUNION_CLIENT_ID,
  TRANSUNION_ENV: process.env.TRANSUNION_ENV,
  // Cross-platform + Phase 4 auth hashing (must be added here or they are
  // undefined at runtime because the Node server builds ENV explicitly).
  APP_TYPE: process.env.APP_TYPE,
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
  CROSS_APP_URL: process.env.CROSS_APP_URL,
  // Farmsky Score origin for the "Use APIs" / API Management SSO hand-off.
  // Without this the Node server left it undefined at runtime, so
  // score_configured was always false and the lender "Use APIs" button + admin
  // API Management SSO never appeared even when SCORE_APP_URL was set on Render.
  SCORE_APP_URL: process.env.SCORE_APP_URL,
  CROSS_APP_HMAC_SECRET: process.env.CROSS_APP_HMAC_SECRET,
  SCORE_CROSS_APP_HMAC_SECRET: process.env.SCORE_CROSS_APP_HMAC_SECRET,
  SCORE_API_URL: process.env.SCORE_API_URL,
  SCORE_API_CLIENT: process.env.SCORE_API_CLIENT,
  SCORE_API_SECRET: process.env.SCORE_API_SECRET,
  // Phase 3 — Score payment-gateway tenant (env-driven; credit.farmsky.africa
  // must not be hardcoded).
  SCORE_CLIENT_KEY: process.env.SCORE_CLIENT_KEY,
  SCORE_HMAC_SECRET: process.env.SCORE_HMAC_SECRET,
  SCORE_ORIGIN_URL: process.env.SCORE_ORIGIN_URL,
  SCORE_CALLBACK_URL: process.env.SCORE_CALLBACK_URL,
  SCORE_LEDGER_HMAC_SECRET: process.env.SCORE_LEDGER_HMAC_SECRET,
  AUTH_HASH_ITERATIONS: process.env.AUTH_HASH_ITERATIONS,
  AUTH_HASH_KEYLEN: process.env.AUTH_HASH_KEYLEN,
  AUTH_PEPPER: process.env.AUTH_PEPPER,
  // Optional explicit default tenant for user rows created outside an admin
  // session (public self-signup / bulk import). Built explicitly here because
  // the Node server constructs ENV by hand — otherwise undefined at runtime.
  EQUIPMENT_ORG_ID: process.env.EQUIPMENT_ORG_ID,
  DEFAULT_ORG_ID: process.env.DEFAULT_ORG_ID,
  // Automated backup email delivery (every 6h) + external cron trigger token.
  // Built explicitly because the Node server constructs ENV by hand.
  BACKUP_EMAIL_TO: process.env.BACKUP_EMAIL_TO,
  BACKUP_NOTIFY_EMAIL: process.env.BACKUP_NOTIFY_EMAIL,
  ADMIN_TASK_TOKEN: process.env.ADMIN_TASK_TOKEN,
  // Per-boot nonce so the in-process 6h backup scheduler can authorize itself to
  // POST /api/backups/run-auto without exposing a token. Never leaves the process.
  INTERNAL_SCHEDULER_NONCE: crypto.randomUUID()
}

const root = new Hono()

// ---------------------------------------------------------------------------
// Ultra-lightweight liveness endpoints. These are dependency-free and are
// declared BEFORE the static/catch-all handlers so they respond the instant the
// process is listening — even while migrations are still running. Point a free
// uptime pinger (UptimeRobot / cron-job.org, every 5-10 min) at /health to keep
// the Render service warm so SasaPay callbacks never hit a cold-start timeout.
// ---------------------------------------------------------------------------
root.get('/health', (c) => c.json({ ok: true, dbReady, ts: Date.now() }))
root.get('/healthz', (c) => c.text(dbReady ? 'ok' : 'starting', dbReady ? 200 : 200))
root.get('/api/ping', (c) => c.json({ ok: true, service: 'farmsky', dbReady, ts: Date.now() }))

root.use('/static/*', serveStatic({ root: './frontend' }))

// A Node-side executionCtx shim so `c.executionCtx.waitUntil(promise)` inside the
// app (used by runInBackground for webhook settlement) keeps the promise alive on
// the event loop instead of silently falling through. This makes background
// settlement after the instant callback ACK reliable on the Node runtime.
const nodeExecutionCtx = {
  waitUntil: (p: Promise<any>) => { Promise.resolve(p).catch(() => {}) },
  passThroughOnException: () => {}
}

// Serve the app for every request. We do NOT gate requests behind `dbReady`:
// gating caused the whole site to return 503 "service_starting" whenever DB init
// was slow or errored on Render. Instead we bind the port immediately and let the
// app run; the pool uses lazy connections, so the rare request that lands in the
// sub-second window before migrations finish either succeeds (pool waits for a
// connection) or fails at the individual query and the client retries. The page,
// login and webhooks all work as soon as the process is listening.
root.all('*', (c) => app.fetch(c.req.raw, ENV as any, nodeExecutionCtx as any))

const PORT = Number(process.env.PORT || 8080)
serve({ fetch: root.fetch, port: PORT }, (info) => {
  console.log(`Farmsky server running on http://0.0.0.0:${info.port} (binding port first; DB migrating in background)`)

  // Kick off migrations/seed AFTER the port is bound. This guarantees the socket
  // accepts connections immediately on cold start, eliminating the connection-level
  // timeout that caused SasaPay "Max retries exceeded" callback failures.
  initializeDatabase(raw, PROJECT_ROOT)
    .then(async () => {
      dbReady = true
      console.log(`PostgreSQL ready: ${DATABASE_URL.replace(/:[^:@/]+@/, ':***@')}`)
      // Phase 3 — env-driven registration of the Score (credit.farmsky.africa)
      // payment-gateway tenant. Keeps client_key/hmac_secret/origin/callback in
      // sync with env WITHOUT hardcoding the credit.farmsky.africa domain.
      try {
        const clientKey = process.env.SCORE_CLIENT_KEY || 'score'
        const secret = process.env.SCORE_HMAC_SECRET || process.env.SCORE_CROSS_APP_HMAC_SECRET || process.env.CROSS_APP_HMAC_SECRET || ''
        const origin = process.env.SCORE_ORIGIN_URL || process.env.SCORE_APP_URL || ''
        const callback = process.env.SCORE_CALLBACK_URL
          || (origin ? `${origin.replace(/\/+$/, '')}/v3/app/wallet/callback` : '')
        if (secret) {
          await raw.query(
            `INSERT INTO app_clients (client_key, display_name, origin_url, hmac_secret, callback_url, is_active)
             VALUES ($1, $2, $3, $4, $5, 1)
             ON CONFLICT (client_key) DO UPDATE SET
               origin_url = COALESCE(NULLIF(EXCLUDED.origin_url, ''), app_clients.origin_url),
               hmac_secret = EXCLUDED.hmac_secret,
               callback_url = COALESCE(NULLIF(EXCLUDED.callback_url, ''), app_clients.callback_url),
               is_active = 1`,
            [clientKey, 'Farmsky Score', origin || 'https://credit.farmsky.africa', secret, callback]
          )
          console.log(`Score gateway client '${clientKey}' registered (origin ${origin || 'default'}).`)
        } else {
          console.warn('Score gateway client NOT registered: SCORE_HMAC_SECRET / SCORE_CROSS_APP_HMAC_SECRET / CROSS_APP_HMAC_SECRET unset.')
        }
      } catch (e: any) {
        console.warn('Score gateway client registration skipped:', e?.message || e)
      }

      // Phase 4 — GENERIC multi-tenant provisioning (Option B, Infrastructure-
      // as-Code fallback for the /admin/tenants dashboard). Any environment
      // variable named TENANT_<NAME>_CLIENT_KEY provisions a client tenant in
      // app_clients, using TENANT_<NAME>_HMAC_SECRET and TENANT_<NAME>_WEBHOOK_URL.
      // Example (Credit):
      //   TENANT_CREDIT_CLIENT_KEY="credit_farmsky_key"
      //   TENANT_CREDIT_HMAC_SECRET="..."
      //   TENANT_CREDIT_WEBHOOK_URL="https://credit.farmsky.africa/api/v1/payment-webhook"
      // Existing admin-UI edits are preserved: the secret is only overwritten
      // from env when it actually changed, and webhook/origin fall back to the
      // stored value when the env var is blank. Non-breaking and idempotent.
      try {
        const tenantKeys = Object.keys(process.env).filter((k) => /^TENANT_[A-Z0-9]+_CLIENT_KEY$/.test(k))
        for (const keyVar of tenantKeys) {
          const name = keyVar.replace(/^TENANT_/, '').replace(/_CLIENT_KEY$/, '')
          const clientKey = String(process.env[keyVar] || '').trim()
          const secret = String(process.env[`TENANT_${name}_HMAC_SECRET`] || '').trim()
          const webhook = String(process.env[`TENANT_${name}_WEBHOOK_URL`] || '').trim()
          const origin = String(process.env[`TENANT_${name}_ORIGIN_URL`] || '').trim()
          const display = String(process.env[`TENANT_${name}_DISPLAY_NAME`] || `Farmsky ${name.charAt(0)}${name.slice(1).toLowerCase()}`).trim()
          if (!clientKey || !secret) {
            console.warn(`Tenant '${name}' NOT provisioned: TENANT_${name}_CLIENT_KEY / _HMAC_SECRET missing.`)
            continue
          }
          await raw.query(
            `INSERT INTO app_clients (client_key, display_name, origin_url, hmac_secret, callback_url, webhook_url, is_active, provisioned_via)
             VALUES ($1, $2, $3, $4, $5, $5, 1, 'env')
             ON CONFLICT (client_key) DO UPDATE SET
               display_name = EXCLUDED.display_name,
               origin_url = COALESCE(NULLIF(EXCLUDED.origin_url, ''), app_clients.origin_url),
               hmac_secret = EXCLUDED.hmac_secret,
               webhook_url = COALESCE(NULLIF(EXCLUDED.webhook_url, ''), app_clients.webhook_url),
               callback_url = COALESCE(NULLIF(EXCLUDED.callback_url, ''), app_clients.callback_url),
               is_active = 1`,
            [clientKey, display, origin || webhook.replace(/\/api\/.*$/, '') || 'https://example.invalid', secret, webhook || null]
          )
          console.log(`Tenant '${name}' provisioned via env (client_key '${clientKey}').`)
        }
      } catch (e: any) {
        console.warn('Env-driven tenant provisioning skipped:', e?.message || e)
      }
    })
    .catch((err: any) => {
      dbInitError = err?.message || String(err)
      console.error('Database initialization failed:', dbInitError)
    })
  
  // Both gateways default to PRODUCTION unless *_ENV is explicitly a sandbox value.
  const sandboxValues = ['sandbox', 'development', 'dev', 'test', 'uat']
  const modeOf = (v?: string) => sandboxValues.includes(String(v || '').trim().toLowerCase()) ? 'sandbox' : 'production'

  // Status check for M-Pesa
  console.log(
    process.env.MPESA_CONSUMER_KEY
      ? 'M-Pesa: LIVE credentials detected (' + modeOf(process.env.MPESA_ENV) + ')'
      : 'M-Pesa: SIMULATION mode (no Daraja credentials set).'
  )

  // Status check for SasaPay
  const sasapayId = process.env.SASAPAY_CLIENT_ID || process.env.SASAPAY_CONSUMER_KEY
  const sasapaySecret = process.env.SASAPAY_CLIENT_SECRET || process.env.SASAPAY_CONSUMER_SECRET
  const sasapayMerchant = process.env.SASAPAY_MERCHANT_CODE
  console.log(
    (sasapayId && sasapaySecret && sasapayMerchant)
      ? 'SasaPay: LIVE credentials detected (' + modeOf(process.env.SASAPAY_ENV) + ')'
      : `SasaPay: SIMULATION mode (missing ${[!sasapayId && 'CLIENT_ID', !sasapaySecret && 'CLIENT_SECRET', !sasapayMerchant && 'MERCHANT_CODE'].filter(Boolean).join(', ') || 'credentials'}).`
  )

  // ------------------------------------------------------------------------
  // Automated 6-hourly backups (Node/Render). Cloudflare/Workers has no long-
  // lived process, so on the edge this is driven by GET /api/backups (on admin
  // dashboard load) or an external cron hitting POST /api/backups/run-auto with
  // x-admin-task-token. On the persistent Node server we ALSO self-trigger so
  // backups + email delivery happen even when no admin is logged in. The handler
  // itself is idempotent (skips if the last auto backup is < 6h old).
  // ------------------------------------------------------------------------
  const BACKUP_TICK_MS = 30 * 60 * 1000 // check every 30 min; handler dedupes to 6h
  const runAutoBackup = async () => {
    if (!dbReady) return
    try {
      const req = new Request('http://internal/api/backups/run-auto', {
        method: 'POST',
        headers: { 'x-internal-scheduler': String((ENV as any).INTERNAL_SCHEDULER_NONCE || ''), 'content-type': 'application/json' },
        body: '{}'
      })
      const res = await app.fetch(req, ENV as any, nodeExecutionCtx as any)
      if (res.ok) {
        const j: any = await res.json().catch(() => ({}))
        if (j?.ran) console.log(`Auto-backup ran; email ${j?.emailed?.sent ? 'sent to ' + (j.emailed.to || []).join(', ') : 'skipped (' + (j?.emailed?.reason || 'n/a') + ')'}`)
      }
    } catch (e: any) {
      console.warn('Auto-backup tick failed:', e?.message || e)
    }
  }
  // First tick shortly after boot (once DB is ready), then on the interval.
  setTimeout(runAutoBackup, 60 * 1000)
  setInterval(runAutoBackup, BACKUP_TICK_MS)
})
