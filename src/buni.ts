// =====================================================================
// KCB Buni payment integration (Sandbox + Production)
// Docs: https://buni.kcbgroup.com/getting-started
// =====================================================================

export type BuniEnv = {
  BUNI_CLIENT_ID?: string
  BUNI_CLIENT_SECRET?: string
  BUNI_API_KEY?: string
  BUNI_TILL_NUMBER?: string
  BUNI_CALLBACK_URL?: string
  BUNI_ENV?: string                       // 'production' or 'sandbox'
}

const SANDBOX_BASE = 'https://uat.buni.kcbgroup.com'
const PROD_BASE = 'https://api.buni.kcbgroup.com'

export function buniConfigured(env: BuniEnv): boolean {
  return !!(env.BUNI_CLIENT_ID && env.BUNI_CLIENT_SECRET && env.BUNI_TILL_NUMBER)
}

function baseUrl(env: BuniEnv): string {
  return env.BUNI_ENV === 'production' ? PROD_BASE : SANDBOX_BASE
}

function normalizePhone(phone: string): string {
  let p = String(phone || '').replace(/[^0-9]/g, '')
  if (p.startsWith('0')) p = '254' + p.slice(1)
  if (p.startsWith('7') && p.length === 9) p = '254' + p
  if (p.startsWith('2540')) p = '254' + p.slice(4)
  return p
}

async function getToken(env: BuniEnv): Promise<string> {
  const auth = btoa(`${env.BUNI_CLIENT_ID}:${env.BUNI_CLIENT_SECRET}`)
  const res = await fetch(`${baseUrl(env)}/token?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` }
  })
  if (!res.ok) throw new Error('Failed to obtain KCB Buni token: ' + res.status)
  const data: any = await res.json()
  return data.access_token
}

export type BuniResult = {
  simulated: boolean
  success: boolean
  checkout_request_id?: string
  merchant_request_id?: string
  customer_message?: string
  error?: string
}

export async function buniStkPush(
  env: BuniEnv,
  opts: { phone: string; amount: number; account: string; description: string }
): Promise<BuniResult> {
  if (!buniConfigured(env)) {
    return {
      simulated: true,
      success: true,
      checkout_request_id: 'BUNI_SIM_' + crypto.randomUUID().slice(0, 12),
      merchant_request_id: 'BUNIM_SIM_' + crypto.randomUUID().slice(0, 8),
      customer_message: 'Simulated KCB Buni STK push sent. (Configure Buni keys for live payments.)'
    }
  }
  try {
    const token = await getToken(env)
    const phone = normalizePhone(opts.phone)
    const body = {
      MerchantCode: env.BUNI_TILL_NUMBER,
      PhoneNumber: phone,
      Amount: Math.max(1, Math.round(opts.amount)),
      Currency: 'KES',
      Reference: opts.account.slice(0, 20),
      Description: opts.description.slice(0, 40),
      CallbackUrl: env.BUNI_CALLBACK_URL || 'https://example.com/api/buni/callback'
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
    if (env.BUNI_API_KEY) headers['apikey'] = env.BUNI_API_KEY
    const res = await fetch(`${baseUrl(env)}/mm/api/request/1.0.0/stkpush`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    })
    const data: any = await res.json()
    if (data.ResponseCode === '0' || data.status === true) {
      return {
        simulated: false,
        success: true,
        checkout_request_id: data.CheckoutRequestID || data.TransactionID,
        merchant_request_id: data.MerchantRequestID || data.TransactionID,
        customer_message: data.CustomerMessage || 'STK push sent via KCB Buni. Enter your PIN on your phone.'
      }
    }
    return { simulated: false, success: false, error: data.errorMessage || data.message || 'Buni STK push failed' }
  } catch (e: any) {
    return { simulated: false, success: false, error: e.message || 'KCB Buni request failed' }
  }
}

export async function buniQuery(env: BuniEnv, checkoutRequestId: string): Promise<any> {
  if (!buniConfigured(env)) return { ResultCode: '0', ResultDesc: 'Simulated success' }
  const token = await getToken(env)
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json'
  }
  if (env.BUNI_API_KEY) headers['apikey'] = env.BUNI_API_KEY
  const res = await fetch(`${baseUrl(env)}/mm/api/request/1.0.0/stkquery`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      MerchantCode: env.BUNI_TILL_NUMBER,
      CheckoutRequestID: checkoutRequestId
    })
  })
  return await res.json()
}
