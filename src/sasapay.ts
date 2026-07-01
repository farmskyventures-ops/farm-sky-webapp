// =====================================================================
// SasaPay payment integration (Sandbox + Production)
// Docs:
//   Auth   : https://developer.sasapay.app/docs/apis/authentication
//   C2B    : https://developer.sasapay.app/docs/apis/c2b
//   Checkout: https://developer.sasapay.app/docs/apis/checkout-payments
// =====================================================================

export interface SasaPayEnv {
  // Primary names used in the app UI / .env.example
  SASAPAY_CLIENT_ID?: string
  SASAPAY_CLIENT_SECRET?: string
  // Backwards-compat aliases (some older configs used CONSUMER_KEY / CONSUMER_SECRET)
  SASAPAY_CONSUMER_KEY?: string
  SASAPAY_CONSUMER_SECRET?: string

  SASAPAY_MERCHANT_CODE?: string
  SASAPAY_CALLBACK_URL?: string
  SASAPAY_ENV?: string // 'sandbox' | 'production'
}

export type SasaPayResult = {
  simulated: boolean
  success: boolean
  checkout_request_id?: string
  merchant_request_id?: string
  customer_message?: string
  error?: string
}

export type SasaPayStkOpts = {
  phone: string
  amount: number
  account: string
  description: string
  networkCode?: string // "63902" M-PESA (default), "0" SasaPay wallet, "63903" Airtel, "63907" T-Kash
}

// ---------- URL helpers ------------------------------------------------------
// SasaPay API base includes `/api/v1`. Auth + payment endpoints all sit under it.
function baseUrl(env: SasaPayEnv) {
  return env.SASAPAY_ENV === 'production'
    ? 'https://api.sasapay.app/api/v1'
    : 'https://sandbox.sasapay.app/api/v1'
}

function clientId(env: SasaPayEnv): string | undefined {
  return env.SASAPAY_CLIENT_ID || env.SASAPAY_CONSUMER_KEY
}
function clientSecret(env: SasaPayEnv): string | undefined {
  return env.SASAPAY_CLIENT_SECRET || env.SASAPAY_CONSUMER_SECRET
}

export function sasapayConfigured(env: SasaPayEnv): boolean {
  return !!(env.SASAPAY_MERCHANT_CODE && clientId(env) && clientSecret(env))
}

// Normalize to 2547XXXXXXXX (SasaPay only accepts the 254 format)
function normalizePhone(phone: string): string {
  let p = String(phone || '').replace(/[^0-9]/g, '')
  if (p.startsWith('0')) p = '254' + p.slice(1)
  if (p.startsWith('7') && p.length === 9) p = '254' + p
  if (p.startsWith('2540')) p = '254' + p.slice(4)
  return p
}

// ---------- Auth ------------------------------------------------------------
// GET /auth/token/?grant_type=client_credentials
// Header: Authorization: Basic base64(client_id:client_secret)
async function getToken(env: SasaPayEnv): Promise<string> {
  const id = clientId(env)
  const secret = clientSecret(env)
  if (!id || !secret) throw new Error('SasaPay client credentials are not configured')

  const auth = btoa(`${id}:${secret}`)
  const url = `${baseUrl(env)}/auth/token/?grant_type=client_credentials`
  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Basic ${auth}` }
  })

  let data: any = null
  try { data = await res.json() } catch {
    const text = await res.text().catch(() => '')
    throw new Error(`SasaPay auth returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`)
  }
  if (!res.ok || !data?.access_token) {
    const msg = data?.detail || data?.message || data?.error || `HTTP ${res.status}`
    throw new Error(`SasaPay auth failed: ${msg}`)
  }
  return String(data.access_token)
}

// ---------- STK Push (C2B request-payment) ----------------------------------
export async function sasapayStkPush(env: SasaPayEnv, opts: SasaPayStkOpts): Promise<SasaPayResult> {
  if (!sasapayConfigured(env)) {
    return {
      simulated: true,
      success: true,
      checkout_request_id: 'SP_SIM_' + crypto.randomUUID().slice(0, 12),
      merchant_request_id: 'SPM_SIM_' + crypto.randomUUID().slice(0, 8),
      customer_message: 'Simulated SasaPay STK push sent. (Configure SasaPay keys for live payments.)'
    }
  }

  try {
    const token = await getToken(env)
    const phone = normalizePhone(opts.phone)
    // Default to M-PESA network so the customer gets an STK prompt (no OTP flow).
    const networkCode = opts.networkCode || '63902'

    const body = {
      MerchantCode: env.SASAPAY_MERCHANT_CODE,
      NetworkCode: networkCode,
      PhoneNumber: phone,
      TransactionDesc: String(opts.description || 'Farmsky payment').slice(0, 20),
      AccountReference: String(opts.account || '').slice(0, 20),
      Currency: 'KES',
      Amount: String(Math.max(1, Math.round(opts.amount))),
      CallBackURL: env.SASAPAY_CALLBACK_URL || 'https://example.com/api/v1/payments/callbacks/sasapay'
    }

    const res = await fetch(`${baseUrl(env)}/payments/request-payment/`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    })

    let data: any = null
    try { data = await res.json() } catch {
      const text = await res.text().catch(() => '')
      return {
        simulated: false,
        success: false,
        error: `SasaPay returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`
      }
    }

    // SasaPay success: { status: true, ResponseCode: "0", CheckoutRequestID, MerchantRequestID, CustomerMessage, ... }
    if (data?.status === true && (data.ResponseCode === '0' || data.ResponseCode === 0)) {
      return {
        simulated: false,
        success: true,
        checkout_request_id: String(data.CheckoutRequestID || data.MerchantRequestID || ''),
        merchant_request_id: String(data.MerchantRequestID || data.CheckoutRequestID || ''),
        customer_message: data.CustomerMessage || data.ResponseDescription || data.detail || 'STK push sent.'
      }
    }

    // Extract the most informative error message SasaPay returned
    const errMsg =
      data?.detail ||
      data?.message ||
      data?.error ||
      data?.ResponseDescription ||
      data?.errors?.[0]?.errorMessage ||
      `HTTP ${res.status}`
    return { simulated: false, success: false, error: `SasaPay: ${errMsg}` }
  } catch (e: any) {
    return { simulated: false, success: false, error: e?.message || 'SasaPay request failed' }
  }
}

// ---------- Transaction status query ----------------------------------------
export async function sasapayQuery(env: SasaPayEnv, checkoutRequestId: string): Promise<any> {
  if (!sasapayConfigured(env)) return { ResultCode: '0', ResultDesc: 'Simulated success' }
  try {
    const token = await getToken(env)
    const res = await fetch(`${baseUrl(env)}/payments/transaction-status/?CheckoutRequestID=${encodeURIComponent(checkoutRequestId)}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` }
    })
    try { return await res.json() } catch { return { ResultCode: 'ERR', ResultDesc: `HTTP ${res.status}` } }
  } catch (e: any) {
    return { ResultCode: 'ERR', ResultDesc: e?.message || 'Query failed' }
  }
}
