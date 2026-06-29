// =====================================================================
// SasaPay payment integration (Sandbox + Production)
// Docs: https://developer.sasapay.app/docs/getting-started
// =====================================================================

export type SasaPayEnv = {
  SASAPAY_CLIENT_ID?: string
  SASAPAY_CLIENT_SECRET?: string
  SASAPAY_MERCHANT_CODE?: string          // Business/Merchant short code
  SASAPAY_ENV?: string                    // 'production' or 'sandbox'
  SASAPAY_CALLBACK_URL?: string
}

const SANDBOX_BASE = 'https://sandbox.sasapay.app/api/v1'
const PROD_BASE = 'https://api.sasapay.app/api/v1'

export function sasapayConfigured(env: SasaPayEnv): boolean {
  return !!(env.SASAPAY_CLIENT_ID && env.SASAPAY_CLIENT_SECRET && env.SASAPAY_MERCHANT_CODE)
}

function baseUrl(env: SasaPayEnv): string {
  return env.SASAPAY_ENV === 'production' ? PROD_BASE : SANDBOX_BASE
}

function normalizePhone(phone: string): string {
  let p = String(phone || '').replace(/[^0-9]/g, '')
  if (p.startsWith('0')) p = '254' + p.slice(1)
  if (p.startsWith('7') && p.length === 9) p = '254' + p
  if (p.startsWith('2540')) p = '254' + p.slice(4)
  return p
}

async function getToken(env: SasaPayEnv): Promise<string> {
  const auth = btoa(`${env.SASAPAY_CLIENT_ID}:${env.SASAPAY_CLIENT_SECRET}`)
  const res = await fetch(`${baseUrl(env)}/auth/token/?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` }
  })
  if (!res.ok) throw new Error('Failed to obtain SasaPay token: ' + res.status)
  const data: any = await res.json()
  return data.access_token
}

export type SasaPayResult = {
  simulated: boolean
  success: boolean
  checkout_request_id?: string
  merchant_request_id?: string
  customer_message?: string
  error?: string
}

export async function sasapayStkPush(
  env: SasaPayEnv,
  opts: { phone: string; amount: number; account: string; description: string }
): Promise<SasaPayResult> {
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
    const body = {
      MerchantCode: env.SASAPAY_MERCHANT_CODE,
      NetworkCode: '0',
      PhoneNumber: phone,
      TransactionDesc: opts.description.slice(0, 20),
      AccountReference: opts.account.slice(0, 20),
      Currency: 'KES',
      Amount: Math.max(1, Math.round(opts.amount)),
      CallBackURL: env.SASAPAY_CALLBACK_URL || 'https://example.com/api/sasapay/callback'
    }
    const res = await fetch(`${baseUrl(env)}/payments/request-payment/`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    const data: any = await res.json()
    if (data.status === true || data.ResponseCode === '0') {
      return {
        simulated: false,
        success: true,
        checkout_request_id: data.CheckoutRequestID || data.MerchantRequestID,
        merchant_request_id: data.MerchantRequestID || data.CheckoutRequestID,
        customer_message: data.CustomerMessage || 'STK push sent via SasaPay. Enter your PIN on your phone.'
      }
    }
    return { simulated: false, success: false, error: data.message || data.detail || 'SasaPay STK push failed' }
  } catch (e: any) {
    return { simulated: false, success: false, error: e.message || 'SasaPay request failed' }
  }
}

export async function sasapayQuery(env: SasaPayEnv, checkoutRequestId: string): Promise<any> {
  if (!sasapayConfigured(env)) return { ResultCode: '0', ResultDesc: 'Simulated success' }
  const token = await getToken(env)
  const res = await fetch(`${baseUrl(env)}/payments/transaction-status/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      MerchantCode: env.SASAPAY_MERCHANT_CODE,
      CheckoutRequestID: checkoutRequestId
    })
  })
  return await res.json()
}

export { normalizePhone as sasapayNormalizePhone }
