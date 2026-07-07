// =====================================================================
// SasaPay payment integration (Sandbox + Production)
// Docs:
//    Auth    : https://developer.sasapay.app/docs/apis/authentication
//    C2B     : https://developer.sasapay.app/docs/apis/c2b
//    Checkout: https://developer.sasapay.app/docs/apis/checkout-payments
// =====================================================================

export interface SasaPayEnv {
  SASAPAY_CLIENT_ID?: string
  SASAPAY_CLIENT_SECRET?: string
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
  networkCode?: string    // "63902" M-PESA, "0" SasaPay wallet, "63903" Airtel
  channel?: 'MOBILE_MONEY' | 'BANK'
  channelCode?: string
  accountNumber?: string
}

// ---------- URL helpers ------------------------------------------------------
function baseUrl(env: SasaPayEnv) {
  return env.SASAPAY_ENV === 'production'
    ? 'https://api.sasapay.app'
    : 'https://sandbox.sasapay.app'
}

const STK_PATHS = [
  '/api/v1/payments/request-payment/',
  '/waas/api/v1/payments/request-payment/'
]

function clientId(env: SasaPayEnv): string | undefined {
  return (env.SASAPAY_CLIENT_ID || env.SASAPAY_CONSUMER_KEY || '').trim() || undefined
}
function clientSecret(env: SasaPayEnv): string | undefined {
  return (env.SASAPAY_CLIENT_SECRET || env.SASAPAY_CONSUMER_SECRET || '').trim() || undefined
}
function merchantCode(env: SasaPayEnv): string | undefined {
  return (env.SASAPAY_MERCHANT_CODE || '').trim() || undefined
}

export function sasapayConfigured(env: SasaPayEnv): boolean {
  return !!(merchantCode(env) && clientId(env) && clientSecret(env))
}

function normalizePhone(phone: string): string {
  let p = String(phone || '').replace(/[^0-9]/g, '')
  if (p.startsWith('0')) p = '254' + p.slice(1)
  if (p.startsWith('7') && p.length === 9) p = '254' + p
  if (p.startsWith('2540')) p = '254' + p.slice(4)
  return p
}

async function readBody(res: Response): Promise<{ json: any; text: string }> {
  const text = await res.text().catch(() => '')
  let json: any = null
  try { json = text ? JSON.parse(text) : null } catch { json = null }
  return { json, text }
}

// ---------- Auth ------------------------------------------------------------
async function getToken(env: SasaPayEnv): Promise<string> {
  const id = clientId(env)
  const secret = clientSecret(env)
  if (!id || !secret) throw new Error('SasaPay client credentials are not configured')

  const auth = btoa(`${id}:${secret}`)
  const url = `${baseUrl(env)}/api/v1/auth/token/?grant_type=client_credentials`
  const res = await fetch(url, {
    method: 'GET',
    redirect: 'follow',
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' }
  })

  const { json, text } = await readBody(res)
  if (!res.ok || !json?.access_token) {
    const msg = json?.detail || json?.message || json?.error || (text ? text.slice(0, 200) : `HTTP ${res.status}`)
    throw new Error(`SasaPay auth failed [${res.status}] at ${url} :: ${msg}`)
  }
  return String(json.access_token)
}

// ---------- STK Push (C2B request-payment) ----------------------------------
export async function sasapayStkPush(env: SasaPayEnv, opts: SasaPayStkOpts): Promise<SasaPayResult> {
  if (!sasapayConfigured(env)) {
    return {
      simulated: true,
      success: true,
      checkout_request_id: 'SP_SIM_' + crypto.randomUUID().slice(0, 12),
      merchant_request_id: 'SPM_SIM_' + crypto.randomUUID().slice(0, 8),
      customer_message: `Simulated SasaPay ${opts.channel || 'MOBILE_MONEY'} push sent.`
    }
  }

  let token: string
  try { token = await getToken(env) }
  catch (e: any) { return { simulated: false, success: false, error: e?.message || 'SasaPay auth failed' } }

  const phone = normalizePhone(opts.phone)
  
  // Safe default: use channelCode/networkCode if provided, otherwise route to '0' (SasaPay Wallet)
  let finalNetworkCode = opts.channelCode || opts.networkCode
  if (!finalNetworkCode) {
    finalNetworkCode = opts.channel === 'BANK' ? '' : '0'
  }

  const callbackUrl = env.SASAPAY_CALLBACK_URL || ''
  if (!callbackUrl) {
    return { simulated: false, success: false, error: 'SasaPay: SASAPAY_CALLBACK_URL env var is required' }
  }

  const body: Record<string, any> = {
    MerchantCode: merchantCode(env),
    NetworkCode: finalNetworkCode,
    TransactionDesc: String(opts.description || 'Farmsky payment').slice(0, 20),
    AccountReference: String(opts.account || '').slice(0, 20),
    Currency: 'KES',
    Amount: String(Math.max(1, Math.round(opts.amount))),
    CallBackURL: callbackUrl
  }

  if (opts.channel === 'BANK') {
    body.BillBankAccountNumber = opts.accountNumber || ''
    body.PhoneNumber = phone 
  } else {
    body.PhoneNumber = phone
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json'
  }

  const attempts: { url: string; status: number; body: string }[] = []

  for (const path of STK_PATHS) {
    const url = `${baseUrl(env)}${path}`
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        redirect: 'follow',
        headers,
        body: JSON.stringify(body)
      })
    } catch (e: any) {
      attempts.push({ url, status: 0, body: e?.message || 'network error' })
      continue
    }

    const { json, text } = await readBody(res)

    if (res.ok && json?.status === true && (json.ResponseCode === '0' || json.ResponseCode === 0)) {
      return {
        simulated: false,
        success: true,
        checkout_request_id: String(json.CheckoutRequestID || json.MerchantRequestID || ''),
        merchant_request_id: String(json.MerchantRequestID || json.CheckoutRequestID || ''),
        customer_message: json.CustomerMessage || json.ResponseDescription || json.detail || 'Transaction processing initiated.'
      }
    }

    attempts.push({ url, status: res.status, body: text.slice(0, 300) })
    if (res.status !== 404) break 
  }

  const last = attempts[attempts.length - 1]
  return {
    simulated: false,
    success: false,
    error: `SasaPay push failed. Tried ${attempts.length} path(s). Last: [${last.status}] ${last.url} -- ${last.body || 'no body'}`
  }
}

// ---------- Transaction status query ----------------------------------------
export async function sasapayQuery(env: SasaPayEnv, checkoutRequestId: string): Promise<any> {
  if (!sasapayConfigured(env)) return { ResultCode: '0', ResultDesc: 'Simulated success' }
  try {
    const token = await getToken(env)
    const url = `${baseUrl(env)}/api/v1/payments/transaction-status/?CheckoutRequestID=${encodeURIComponent(checkoutRequestId)}`
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
    })
    const { json } = await readBody(res)

    if (json && (json.ResultCode !== undefined || json.status_code !== undefined || json.status !== undefined)) {
      return json
    }

    return { pending: true, status_code: null, ResultDesc: 'Transaction still processing' }
  } catch (e: any) {
    return { pending: true, status_code: null, ResultDesc: 'Transaction still processing' }
  }
}
