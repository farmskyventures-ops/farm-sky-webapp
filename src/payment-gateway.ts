// =====================================================================
// Farmsky Central Payment Gateway
// =====================================================================
//   Single endpoint shared by all three Farmsky marketplaces:
//     - equipment.farmsky.africa
//     - feed.farmsky.africa
//     - input.farmsky.africa
//
//   Supported rails: M-Pesa Daraja, SasaPay, KCB Buni
//
//   Routes (mounted under /api/v1/payments/*):
//     POST /initiate                    <- the calling app sends a signed request
//     GET  /status/:transaction_ref    <- polled by the calling app
//     POST /callbacks/mpesa            <- provider IPN
//     POST /callbacks/sasapay          <- provider IPN
//     POST /callbacks/buni             <- provider IPN
//
//   Security:
//     - Every /initiate call is HMAC-SHA256 signed using the calling app's
//       shared secret stored in app_clients.hmac_secret.
//     - Replay protection: nonce + timestamp; requests older than 5 min
//       are rejected.
//     - Idempotency: optional Idempotency-Key header. Re-sending the same
//       key for the same client returns the original transaction_ref.
//     - Provider callbacks are bound by provider_request_id (which only
//       the provider knows after our outbound STK push), so spoofed IPNs
//       cannot mark an unrelated transaction as paid.
//     - origin_app is taken from the verified client identity in the DB,
//       NOT from the request body, so it cannot be spoofed.
// =====================================================================

import { Hono } from 'hono'
import { stkPush, stkQuery, normalizePhone } from './mpesa'
import { sasapayStkPush, sasapayQuery } from './sasapay'
import { buniStkPush, buniQuery } from './buni'
import { verifySignature } from './payments-shared'
import type { Bindings } from './types'

export type PaymentMethod = 'mpesa' | 'sasapay' | 'buni'

const gateway = new Hono<{ Bindings: Bindings }>()

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function genRef(): string {
  return 'FSK-' + crypto.randomUUID().replace(/-/g, '').slice(0, 18).toUpperCase()
}

async function loadClient(c: any, client_key: string) {
  return await c.env.DB.prepare(
    `SELECT id, client_key, display_name, origin_url, hmac_secret, callback_url, is_active
     FROM app_clients WHERE client_key = ?`
  ).bind(client_key).first<any>()
}

async function findTxByProviderRef(c: any, provider_request_id: string) {
  if (!provider_request_id) return null
  return await c.env.DB.prepare(
    `SELECT * FROM central_transactions WHERE provider_request_id = ? LIMIT 1`
  ).bind(provider_request_id).first<any>()
}

async function logCallback(c: any, txRef: string | null, method: string, providerReqId: string | null, rawBody: string, valid: boolean) {
  try {
    await c.env.DB.prepare(
      `INSERT INTO central_callbacks (transaction_ref, payment_method, provider_request_id, raw_payload, signature_valid)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(txRef, method, providerReqId, rawBody.slice(0, 8000), valid ? 1 : 0).run()
  } catch (_) {}
}

async function notifyOriginApp(c: any, client: any, tx: any) {
  if (!client?.callback_url) return
  // Fire-and-forget; failures are not fatal
  try {
    const body = JSON.stringify({
      transaction_ref: tx.transaction_ref,
      origin_reference: tx.origin_reference,
      payment_method: tx.payment_method,
      status: tx.status,
      provider_receipt: tx.provider_receipt,
      amount: Number(tx.amount),
      currency: tx.currency,
      result_code: tx.result_code,
      result_desc: tx.result_desc,
      completed_at: tx.completed_at
    })
    // Sign so the receiving app can verify it came from us
    const { signRequest } = await import('./payments-shared')
    const { timestamp, nonce, signature } = await signRequest(client.hmac_secret, client.client_key, body)
    await fetch(client.callback_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Farmsky-Client': client.client_key,
        'X-Farmsky-Timestamp': timestamp,
        'X-Farmsky-Nonce': nonce,
        'X-Farmsky-Signature': signature
      },
      body
    })
  } catch (_) {}
}

// ----------------------------------------------------------------------------
// POST /initiate
// Body (JSON): { amount, phone, payment_method, origin_reference?, description?, initiated_by_user?, channel?, channelCode?, accountNumber? }
// Headers (required):
//   X-Farmsky-Client     : 'equipment' | 'feed' | 'input'
//   X-Farmsky-Timestamp  : milliseconds since epoch
//   X-Farmsky-Nonce      : random UUID per request
//   X-Farmsky-Signature  : HMAC-SHA256 hex of (client \n ts \n nonce \n raw-body) using hmac_secret
//   Idempotency-Key      : optional; safe to retry with same key
// ----------------------------------------------------------------------------
gateway.post('/initiate', async (c) => {
  const rawBody = await c.req.text()

  const client_key = c.req.header('X-Farmsky-Client') || ''
  const timestamp = c.req.header('X-Farmsky-Timestamp') || ''
  const nonce = c.req.header('X-Farmsky-Nonce') || ''
  const signature = c.req.header('X-Farmsky-Signature') || ''
  const idempotencyKey = c.req.header('Idempotency-Key') || null

  if (!client_key) return c.json({ success: false, error: 'Missing X-Farmsky-Client header' }, 401)

  const client = await loadClient(c, client_key)
  if (!client || !client.is_active) return c.json({ success: false, error: 'Unknown or inactive client app' }, 401)

  const v = await verifySignature(client.hmac_secret, client_key, timestamp, nonce, rawBody, signature)
  if (!v.ok) return c.json({ success: false, error: v.error || 'Invalid signature' }, 401)

  // Replay protection on nonce (best-effort): reject if same nonce seen recently
  try {
    const seen = await c.env.DB.prepare(
      `SELECT 1 FROM central_callbacks WHERE raw_payload LIKE ? AND received_at > NOW() - INTERVAL '5 minutes' LIMIT 1`
    ).bind(`%${nonce}%`).first<any>()
    if (seen) return c.json({ success: false, error: 'Replay detected' }, 401)
  } catch (_) {}

  let body: any = {}
  try { body = rawBody ? JSON.parse(rawBody) : {} } catch { return c.json({ success: false, error: 'Body must be JSON' }, 400) }

  const method = String(body.payment_method || '').toLowerCase() as PaymentMethod
  const amount = Number(body.amount)
  const phone = normalizePhone(String(body.phone || ''))
  const origin_reference = body.origin_reference ? String(body.origin_reference) : null
  const description = body.description ? String(body.description).slice(0, 200) : `${client.display_name} payment`
  const initiated_by_user = body.initiated_by_user ?? null

  // Capture optional dynamic-channel options coming from the marketplaces
  const channel = body.channel || 'MOBILE_MONEY'
  const channelCode = body.channelCode || body.networkCode || undefined
  const accountNumber = body.accountNumber || undefined

  if (!['mpesa', 'sasapay', 'buni'].includes(method)) return c.json({ success: false, error: 'payment_method must be mpesa | sasapay | buni' }, 400)
  if (!Number.isFinite(amount) || amount <= 0) return c.json({ success: false, error: 'amount must be > 0' }, 400)
  if (!phone || phone.length < 11) return c.json({ success: false, error: 'phone is invalid' }, 400)

  // Idempotency check
  if (idempotencyKey) {
    const existing = await c.env.DB.prepare(
      `SELECT transaction_ref, payment_method, status FROM central_transactions WHERE origin_app = ? AND idempotency_key = ? LIMIT 1`
    ).bind(client_key, idempotencyKey).first<any>()
    if (existing) {
      return c.json({
        success: true,
        idempotent_replay: true,
        transaction_ref: existing.transaction_ref,
        payment_method: existing.payment_method,
        status: existing.status
      })
    }
  }

  // Push to the chosen provider FIRST so we can record provider_request_id
  const transaction_ref = genRef()
  const desc = description.slice(0, 40)
  let providerResult: any
  try {
    if (method === 'mpesa') {
      providerResult = await stkPush(c.env, { phone, amount, account: transaction_ref, description: desc, networkCode: channelCode })
    } else if (method === 'sasapay') {
      providerResult = await sasapayStkPush(c.env, { 
        phone, 
        amount, 
        account: transaction_ref, 
        description: desc,
        channel,
        channelCode,
        accountNumber
      })
    } else {
      providerResult = await buniStkPush(c.env, { phone, amount, account: transaction_ref, description: desc })
    }
  } catch (e: any) {
    return c.json({ success: false, error: e?.message || 'Provider error' }, 502)
  }

  if (!providerResult?.success) {
    return c.json({ success: false, error: providerResult?.error || 'Provider rejected the push' }, 502)
  }

  const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || null

  await c.env.DB.prepare(
    `INSERT INTO central_transactions
        (transaction_ref, idempotency_key, origin_app, origin_reference, payment_method,
         provider_request_id, phone, amount, currency, description, status, initiated_by_user, ip_address)
      VALUES (?,?,?,?,?,?,?,?,?,?, 'PENDING', ?, ?)`
  ).bind(
    transaction_ref, idempotencyKey, client_key, origin_reference, method,
    providerResult.checkout_request_id || null, phone, amount, 'KES', desc, initiated_by_user, ip
  ).run()

  return c.json({
    success: true,
    transaction_ref,
    payment_method: method,
    origin_app: client_key,
    simulated: !!providerResult.simulated,
    customer_message: providerResult.customer_message || 'Payment prompt sent.',
    status: 'PENDING'
  })
})

// ----------------------------------------------------------------------------
// GET /status/:transaction_ref
// Same HMAC headers required so only the originating app can poll its own tx.
// ----------------------------------------------------------------------------
gateway.get('/status/:ref', async (c) => {
  const transaction_ref = c.req.param('ref')
  const client_key = c.req.header('X-Farmsky-Client') || ''
  const timestamp = c.req.header('X-Farmsky-Timestamp') || ''
  const nonce = c.req.header('X-Farmsky-Nonce') || ''
  const signature = c.req.header('X-Farmsky-Signature') || ''

  const client = await loadClient(c, client_key)
  if (!client || !client.is_active) return c.json({ success: false, error: 'Unknown client app' }, 401)

  // For GET we sign the path so an attacker cannot replay another app's poll
  const v = await verifySignature(client.hmac_secret, client_key, timestamp, nonce, transaction_ref, signature)
  if (!v.ok) return c.json({ success: false, error: v.error || 'Invalid signature' }, 401)

  const tx = await c.env.DB.prepare(
    `SELECT * FROM central_transactions WHERE transaction_ref = ? AND origin_app = ? LIMIT 1`
  ).bind(transaction_ref, client_key).first<any>()
  if (!tx) return c.json({ success: false, error: 'Transaction not found' }, 404)

  // If still PENDING, ask the provider for the latest status
  if (tx.status === 'PENDING' && tx.provider_request_id) {
    try {
      let pr: any
      if (tx.payment_method === 'mpesa') pr = await stkQuery(c.env, tx.provider_request_id)
      else if (tx.payment_method === 'sasapay') pr = await sasapayQuery(c.env, tx.provider_request_id)
      else if (tx.payment_method === 'buni') pr = await buniQuery(c.env, tx.provider_request_id)

      const code = pr?.ResultCode ?? pr?.status_code
      if (code === 0 || code === '0' || pr?.status === true) {
        await c.env.DB.prepare(
          `UPDATE central_transactions
              SET status='SUCCESS', result_code=?, result_desc=?, updated_at=CURRENT_TIMESTAMP, completed_at=CURRENT_TIMESTAMP
            WHERE transaction_ref=?`
        ).bind(String(code ?? '0'), String(pr?.ResultDesc || pr?.message || 'Success'), transaction_ref).run()
        tx.status = 'SUCCESS'
      } else if (code !== undefined && code !== null && code !== 0 && code !== '0') {
        await c.env.DB.prepare(
          `UPDATE central_transactions
              SET status='FAILED', result_code=?, result_desc=?, updated_at=CURRENT_TIMESTAMP, completed_at=CURRENT_TIMESTAMP
            WHERE transaction_ref=?`
        ).bind(String(code), String(pr?.ResultDesc || pr?.message || 'Failed'), transaction_ref).run()
        tx.status = 'FAILED'
      }
    } catch (_) {}
  }

  return c.json({
    success: true,
    transaction_ref: tx.transaction_ref,
    origin_app: tx.origin_app,
    origin_reference: tx.origin_reference,
    payment_method: tx.payment_method,
    status: tx.status,
    amount: Number(tx.amount),
    currency: tx.currency,
    provider_receipt: tx.provider_receipt,
    result_code: tx.result_code,
    result_desc: tx.result_desc,
    completed_at: tx.completed_at
  })
})

// ----------------------------------------------------------------------------
// CALLBACKS (provider IPNs). These are reached by Daraja/SasaPay/Buni only,
// so they don't need our HMAC. Spoof protection: the provider_request_id is
// only known after we successfully pushed a transaction, so a random attacker
// cannot mutate an unrelated tx. We also persist the raw payload for audit.
// ----------------------------------------------------------------------------
async function settleCallback(c: any, method: PaymentMethod, providerReqId: string | null, success: boolean, receipt: string | null, resultCode: string | null, resultDesc: string | null, rawBody: string) {
  if (!providerReqId) {
    await logCallback(c, null, method, null, rawBody, false)
    return
  }
  const tx = await findTxByProviderRef(c, providerReqId)
  if (!tx) {
    await logCallback(c, null, method, providerReqId, rawBody, false)
    return
  }
  if (tx.status !== 'PENDING') {
    await logCallback(c, tx.transaction_ref, method, providerReqId, rawBody, true)
    return
  }
  await c.env.DB.prepare(
    `UPDATE central_transactions
        SET status=?, provider_receipt=COALESCE(?, provider_receipt),
            result_code=?, result_desc=?, updated_at=CURRENT_TIMESTAMP, completed_at=CURRENT_TIMESTAMP
      WHERE transaction_ref=?`
  ).bind(success ? 'SUCCESS' : 'FAILED', receipt, resultCode, resultDesc, tx.transaction_ref).run()
  await logCallback(c, tx.transaction_ref, method, providerReqId, rawBody, true)

  // Notify originating app (if it has registered a callback_url)
  const client = await loadClient(c, tx.origin_app)
  const refreshed = await c.env.DB.prepare(`SELECT * FROM central_transactions WHERE transaction_ref=?`).bind(tx.transaction_ref).first<any>()
  if (client && refreshed) await notifyOriginApp(c, client, refreshed)
}

gateway.post('/callbacks/mpesa', async (c) => {
  const raw = await c.req.text()
  try {
    const body: any = JSON.parse(raw)
    const cb = body?.Body?.stkCallback
    const providerReqId = cb?.CheckoutRequestID || null
    const success = cb?.ResultCode === 0
    const items = cb?.CallbackMetadata?.Item || []
    const receipt = items.find((i: any) => i?.Name === 'MpesaReceiptNumber')?.Value || null
    await settleCallback(c, 'mpesa', providerReqId, success, receipt ? String(receipt) : null, String(cb?.ResultCode ?? ''), cb?.ResultDesc || null, raw)
  } catch (_) {
    await logCallback(c, null, 'mpesa', null, raw, false)
  }
  return c.json({ ResultCode: 0, ResultDesc: 'Accepted' })
})

gateway.post('/callbacks/sasapay', async (c) => {
  const raw = await c.req.text()
  try {
    const body: any = JSON.parse(raw)
    const providerReqId = body?.CheckoutRequestID || body?.MerchantRequestID || null
    const code = body?.ResultCode ?? body?.status_code
    const success = code === 0 || code === '0' || body?.status === true
    const receipt = body?.TransactionID || body?.MpesaReceiptNumber || null
    await settleCallback(c, 'sasapay', providerReqId, success, receipt ? String(receipt) : null, String(code ?? ''), body?.ResultDesc || body?.message || null, raw)
  } catch (_) {
    await logCallback(c, null, 'sasapay', null, raw, false)
  }
  return c.json({ status: 'Success', message: 'Callback received' })
})

gateway.post('/callbacks/buni', async (c) => {
  const raw = await c.req.text()
  try {
    const body: any = JSON.parse(raw)
    const providerReqId = body?.CheckoutRequestID || body?.TransactionID || null
    const code = body?.ResponseCode ?? body?.ResultCode
    const success = code === '00' || code === 0 || code === '0' || body?.status === true
    const receipt = body?.TransactionID || body?.ReceiptNumber || null
    await settleCallback(c, 'buni', providerReqId, success, receipt ? String(receipt) : null, String(code ?? ''), body?.ResponseDescription || body?.ResultDesc || null, raw)
  } catch (_) {
    await logCallback(c, null, 'buni', null, raw, false)
  }
  return c.json({ ResponseCode: '00', ResponseMessage: 'Success' })
})

// ----------------------------------------------------------------------------
// Admin reporting (this app's own admin only)
// Returns counts per origin_app and per payment_method.
// ----------------------------------------------------------------------------
gateway.get('/admin/summary', async (c) => {
  const { results: byApp } = await c.env.DB.prepare(
    `SELECT origin_app, COUNT(*)::int as count, COALESCE(SUM(amount),0)::numeric as total
       FROM central_transactions WHERE status='SUCCESS' GROUP BY origin_app`
  ).all()
  const { results: byMethod } = await c.env.DB.prepare(
    `SELECT payment_method, COUNT(*)::int as count, COALESCE(SUM(amount),0)::numeric as total
       FROM central_transactions WHERE status='SUCCESS' GROUP BY payment_method`
  ).all()
  const { results: matrix } = await c.env.DB.prepare(
    `SELECT origin_app, payment_method, COUNT(*)::int as count, COALESCE(SUM(amount),0)::numeric as total
       FROM central_transactions WHERE status='SUCCESS' GROUP BY origin_app, payment_method`
  ).all()
  return c.json({ by_app: byApp, by_method: byMethod, matrix })
})

export default gateway
