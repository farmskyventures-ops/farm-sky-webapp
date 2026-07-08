// =====================================================================
// SasaPay payment integration — PRODUCTION READY
// Docs (as supplied by SasaPay):
//   Auth              : GET  /api/v1/auth/token/?grant_type=client_credentials
//   C2B (collect)     : POST /api/v1/payments/request-payment/
//   Process (OTP)     : POST /api/v1/payments/process-payment/
//   B2C (payout)      : POST /api/v1/payments/b2c/
//   Account validation: POST /api/v1/accounts/account-validation/
//   Status query      : POST /api/v1/transactions/status-query/
//   Balance           : GET  /api/v1/payments/check-balance/
//
// Supports SasaPay wallet, M-PESA, Airtel Money, T-Kash and every bank in the
// SasaPay channel-code list (see SASAPAY_CHANNELS below).
// =====================================================================

export interface SasaPayEnv {
  SASAPAY_CLIENT_ID?: string
  SASAPAY_CLIENT_SECRET?: string
  SASAPAY_CONSUMER_KEY?: string
  SASAPAY_CONSUMER_SECRET?: string
  SASAPAY_MERCHANT_CODE?: string
  SASAPAY_CALLBACK_URL?: string       // C2B payin payload callback
  SASAPAY_B2C_CALLBACK_URL?: string   // B2C payout result callback (falls back to CALLBACK_URL)
  SASAPAY_ENV?: string                // 'sandbox' | 'production'
}

// ---------------------------------------------------------------------------
// Channel / bank catalogue (full SasaPay list). `type` classifies how the
// account_number is validated and which account_type is used for validation.
// ---------------------------------------------------------------------------
export type ChannelType = 'wallet' | 'mobile' | 'bank'
export interface SasaPayChannel { code: string; name: string; type: ChannelType }

export const SASAPAY_CHANNELS: SasaPayChannel[] = [
  { code: '0',     name: 'SasaPay Wallet',            type: 'wallet' },
  { code: '63902', name: 'M-PESA',                    type: 'mobile' },
  { code: '63903', name: 'Airtel Money',              type: 'mobile' },
  { code: '63907', name: 'T-Kash',                    type: 'mobile' },
  { code: '01',    name: 'KCB Bank',                  type: 'bank' },
  { code: '02',    name: 'Standard Chartered Bank KE', type: 'bank' },
  { code: '03',    name: 'Absa Bank',                 type: 'bank' },
  { code: '07',    name: 'NCBA',                       type: 'bank' },
  { code: '10',    name: 'Prime Bank',                type: 'bank' },
  { code: '11',    name: 'Cooperative Bank',          type: 'bank' },
  { code: '12',    name: 'National Bank',             type: 'bank' },
  { code: '14',    name: 'M-Oriental',                type: 'bank' },
  { code: '16',    name: 'Citibank',                  type: 'bank' },
  { code: '18',    name: 'Middle East Bank',          type: 'bank' },
  { code: '19',    name: 'Bank of Africa',            type: 'bank' },
  { code: '23',    name: 'Consolidated Bank',         type: 'bank' },
  { code: '25',    name: 'Credit Bank',               type: 'bank' },
  { code: '31',    name: 'Stanbic Bank',              type: 'bank' },
  { code: '35',    name: 'ABC Bank',                  type: 'bank' },
  { code: '36',    name: 'Choice Microfinance Bank',  type: 'bank' },
  { code: '43',    name: 'Eco Bank',                  type: 'bank' },
  { code: '50',    name: 'Paramount Universal Bank',  type: 'bank' },
  { code: '51',    name: 'Kingdom Bank',              type: 'bank' },
  { code: '53',    name: 'Guaranty Bank',             type: 'bank' },
  { code: '54',    name: 'Victoria Commercial Bank',  type: 'bank' },
  { code: '55',    name: 'Guardian Bank',             type: 'bank' },
  { code: '57',    name: 'I&M Bank',                  type: 'bank' },
  { code: '61',    name: 'HFC Bank',                  type: 'bank' },
  { code: '63',    name: 'DTB',                        type: 'bank' },
  { code: '65',    name: 'Mayfair Bank',              type: 'bank' },
  { code: '66',    name: 'Sidian Bank',               type: 'bank' },
  { code: '68',    name: 'Equity Bank',               type: 'bank' },
  { code: '70',    name: 'Family Bank',               type: 'bank' },
  { code: '72',    name: 'Gulf African Bank',         type: 'bank' },
  { code: '74',    name: 'First Community Bank',      type: 'bank' },
  { code: '75',    name: 'DIB Bank',                  type: 'bank' },
  { code: '76',    name: 'UBA',                        type: 'bank' },
  { code: '78',    name: 'KWFT Bank',                 type: 'bank' },
  { code: '89',    name: 'Stima Sacco',               type: 'bank' },
  { code: '97',    name: 'Telkom Kenya',              type: 'mobile' }
]

export function channelByCode(code: string): SasaPayChannel | undefined {
  return SASAPAY_CHANNELS.find((ch) => ch.code === String(code))
}

// account_type used by the account-validation endpoint:
//   0 = SasaPay, 1 = Mobile Money, 4 = Bank
export function accountTypeForChannel(code: string): number {
  const ch = channelByCode(code)
  if (!ch) return 1
  if (ch.type === 'wallet') return 0
  if (ch.type === 'bank') return 4
  return 1
}

// Trusted SasaPay callback source IPs (see docs: Callback Security).
export const SASAPAY_CALLBACK_IPS = [
  '47.129.43.141', '13.229.247.179', '13.215.155.141', '13.214.60.231',
  '54.169.74.198', '18.142.226.87', '47.129.243.116', '13.250.110.3',
  '155.12.30.40', '155.12.30.58'
]

export function isTrustedSasapayIp(ip?: string | null): boolean {
  if (!ip) return false
  // X-Forwarded-For may contain a comma-separated list; check each token.
  return String(ip).split(',').map((s) => s.trim()).some((t) => SASAPAY_CALLBACK_IPS.includes(t))
}

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------
export type SasaPayResult = {
  simulated: boolean
  success: boolean
  checkout_request_id?: string
  merchant_request_id?: string
  transaction_reference?: string
  payment_gateway?: string
  customer_message?: string
  needs_otp?: boolean          // true for SasaPay wallet channel ("0")
  raw?: any
  error?: string
}

export type SasaPayPayoutResult = {
  simulated: boolean
  success: boolean
  b2c_request_id?: string
  conversation_id?: string
  originator_conversation_id?: string
  transaction_charges?: string
  customer_message?: string
  raw?: any
  error?: string
}

export type SasaPayStkOpts = {
  phone: string
  amount: number
  account: string              // AccountReference / merchant transaction id
  description: string
  networkCode?: string         // channel code, e.g. "0", "63902", bank code "01"
  channel?: 'MOBILE_MONEY' | 'BANK' | 'WALLET'
  channelCode?: string         // alias for networkCode
  accountNumber?: string       // bank account number when paying a bank
  callbackUrl?: string         // override the default payin callback
}

export type SasaPayB2COpts = {
  amount: number
  receiverNumber: string       // mobile (2547…) or bank account number
  channel: string              // channel code: "0", "63902", "01" …
  reason: string
  reference: string            // MerchantTransactionReference (unique)
  callbackUrl?: string
}

// ---------- URL helpers ------------------------------------------------------
function baseUrl(env: SasaPayEnv) {
  return env.SASAPAY_ENV === 'production'
    ? 'https://api.sasapay.app'
    : 'https://sandbox.sasapay.app'
}

function clientId(env: SasaPayEnv): string | undefined {
  return (env.SASAPAY_CLIENT_ID || env.SASAPAY_CONSUMER_KEY || '').trim() || undefined
}
function clientSecret(env: SasaPayEnv): string | undefined {
  return (env.SASAPAY_CLIENT_SECRET || env.SASAPAY_CONSUMER_SECRET || '').trim() || undefined
}
export function merchantCode(env: SasaPayEnv): string | undefined {
  return (env.SASAPAY_MERCHANT_CODE || '').trim() || undefined
}

export function sasapayConfigured(env: SasaPayEnv): boolean {
  return !!(merchantCode(env) && clientId(env) && clientSecret(env))
}

export function normalizePhone(phone: string): string {
  let p = String(phone || '').replace(/[^0-9]/g, '')
  if (p.startsWith('0')) p = '254' + p.slice(1)
  if (p.startsWith('7') && p.length === 9) p = '254' + p
  if (p.startsWith('1') && p.length === 9) p = '254' + p
  if (p.startsWith('2540')) p = '254' + p.slice(4)
  return p
}

async function readBody(res: Response): Promise<{ json: any; text: string }> {
  const text = await res.text().catch(() => '')
  let json: any = null
  try { json = text ? JSON.parse(text) : null } catch { json = null }
  return { json, text }
}

// ---------- Auth (with per-process token cache) -----------------------------
type TokenCache = { token: string; expiresAt: number }
const _tokenCache = new Map<string, TokenCache>()

async function getToken(env: SasaPayEnv): Promise<string> {
  const id = clientId(env)
  const secret = clientSecret(env)
  if (!id || !secret) throw new Error('SasaPay client credentials are not configured')

  const cacheKey = `${baseUrl(env)}::${id}`
  const cached = _tokenCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token

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
    throw new Error(`SasaPay auth failed [${res.status}] :: ${msg}`)
  }
  const ttl = Number(json.expires_in || 3600) * 1000
  _tokenCache.set(cacheKey, { token: String(json.access_token), expiresAt: Date.now() + ttl })
  return String(json.access_token)
}

// ---------- C2B: request-payment (collect) ----------------------------------
// Handles SasaPay wallet (OTP), mobile money (STK) and bank (Pesalink) via the
// single request-payment endpoint, keyed on NetworkCode.
export async function sasapayStkPush(env: SasaPayEnv, opts: SasaPayStkOpts): Promise<SasaPayResult> {
  if (!sasapayConfigured(env)) {
    const code = opts.channelCode || opts.networkCode || '63902'
    return {
      simulated: true,
      success: true,
      checkout_request_id: 'SP_SIM_' + crypto.randomUUID().slice(0, 12),
      merchant_request_id: 'SPM_SIM_' + crypto.randomUUID().slice(0, 8),
      transaction_reference: 'PR_SIM_' + Date.now().toString().slice(-8),
      payment_gateway: channelByCode(code)?.name || 'SasaPay',
      needs_otp: code === '0',
      customer_message: `Simulated SasaPay ${channelByCode(code)?.name || 'payment'} request sent.`
    }
  }

  let token: string
  try { token = await getToken(env) }
  catch (e: any) { return { simulated: false, success: false, error: e?.message || 'SasaPay auth failed' } }

  const phone = normalizePhone(opts.phone)
  const networkCode = String(opts.channelCode || opts.networkCode || '63902')
  const ch = channelByCode(networkCode)

  const callbackUrl = opts.callbackUrl || env.SASAPAY_CALLBACK_URL || ''
  if (!callbackUrl) {
    return { simulated: false, success: false, error: 'SasaPay: a payin CallBackURL is required (set SASAPAY_CALLBACK_URL)' }
  }

  const body: Record<string, any> = {
    MerchantCode: merchantCode(env),
    NetworkCode: networkCode,
    PhoneNumber: phone,
    Currency: 'KES',
    Amount: String(Math.max(1, Math.round(opts.amount))),
    AccountReference: String(opts.account || '').slice(0, 20),
    TransactionDesc: String(opts.description || 'Farmsky payment').slice(0, 20),
    CallBackURL: callbackUrl
  }
  // Bank collections need the payer's bank account number.
  if (ch?.type === 'bank' && opts.accountNumber) {
    body.BillBankAccountNumber = opts.accountNumber
  }

  const url = `${baseUrl(env)}/api/v1/payments/request-payment/`
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      redirect: 'follow',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body)
    })
  } catch (e: any) {
    return { simulated: false, success: false, error: e?.message || 'SasaPay network error' }
  }

  const { json, text } = await readBody(res)
  if (res.ok && json?.status === true && (json.ResponseCode === '0' || json.ResponseCode === 0)) {
    return {
      simulated: false,
      success: true,
      checkout_request_id: String(json.CheckoutRequestID || json.MerchantRequestID || ''),
      merchant_request_id: String(json.MerchantRequestID || ''),
      transaction_reference: String(json.TransactionReference || ''),
      payment_gateway: json.PaymentGateway || ch?.name || 'SasaPay',
      needs_otp: networkCode === '0',
      customer_message: json.CustomerMessage || json.ResponseDescription || json.detail || 'Transaction processing initiated.',
      raw: json
    }
  }

  const msg = json?.detail || json?.ResponseDescription || json?.message || (text ? text.slice(0, 300) : `HTTP ${res.status}`)
  return { simulated: false, success: false, error: `SasaPay request-payment failed [${res.status}] :: ${msg}` }
}

// ---------- Process payment (SasaPay wallet OTP only) -----------------------
export async function sasapayProcessPayment(env: SasaPayEnv, checkoutRequestId: string, verificationCode: string): Promise<SasaPayResult> {
  if (!sasapayConfigured(env) || String(checkoutRequestId).includes('SIM')) {
    return { simulated: true, success: true, customer_message: 'Transaction is being processed' }
  }
  let token: string
  try { token = await getToken(env) }
  catch (e: any) { return { simulated: false, success: false, error: e?.message || 'SasaPay auth failed' } }

  const url = `${baseUrl(env)}/api/v1/payments/process-payment/`
  const body = { MerchantCode: merchantCode(env), CheckoutRequestID: checkoutRequestId, VerificationCode: String(verificationCode) }
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST', redirect: 'follow',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body)
    })
  } catch (e: any) { return { simulated: false, success: false, error: e?.message || 'SasaPay network error' } }

  const { json, text } = await readBody(res)
  if (res.ok && json?.status === true) {
    return { simulated: false, success: true, customer_message: json.detail || 'Transaction is being processed', raw: json }
  }
  const msg = json?.detail || json?.message || (text ? text.slice(0, 200) : `HTTP ${res.status}`)
  return { simulated: false, success: false, error: `SasaPay process-payment failed [${res.status}] :: ${msg}` }
}

// ---------- B2C: payout / disbursal -----------------------------------------
export async function sasapayB2C(env: SasaPayEnv, opts: SasaPayB2COpts): Promise<SasaPayPayoutResult> {
  if (!sasapayConfigured(env)) {
    return {
      simulated: true,
      success: true,
      b2c_request_id: 'B2C_SIM_' + crypto.randomUUID().slice(0, 12),
      conversation_id: 'CONV_SIM_' + crypto.randomUUID().slice(0, 8),
      originator_conversation_id: opts.reference,
      transaction_charges: '0.00',
      customer_message: `Simulated payout of KES ${opts.amount} to ${opts.receiverNumber} is being processed.`
    }
  }

  let token: string
  try { token = await getToken(env) }
  catch (e: any) { return { simulated: false, success: false, error: e?.message || 'SasaPay auth failed' } }

  const callbackUrl = opts.callbackUrl || env.SASAPAY_B2C_CALLBACK_URL || env.SASAPAY_CALLBACK_URL || ''
  if (!callbackUrl) {
    return { simulated: false, success: false, error: 'SasaPay: a payout CallBackURL is required (set SASAPAY_B2C_CALLBACK_URL)' }
  }

  const isMobile = channelByCode(opts.channel)?.type !== 'bank' && opts.channel !== '0'
  const receiver = isMobile ? normalizePhone(opts.receiverNumber) : String(opts.receiverNumber)

  const body: Record<string, any> = {
    MerchantCode: merchantCode(env),
    MerchantTransactionReference: String(opts.reference).slice(0, 40),
    Amount: String(Math.max(1, Math.round(opts.amount))),
    Currency: 'KES',
    ReceiverNumber: receiver,
    Channel: String(opts.channel),
    Reason: String(opts.reason || 'Farmsky payout').slice(0, 100),
    CallBackURL: callbackUrl
  }

  const url = `${baseUrl(env)}/api/v1/payments/b2c/`
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST', redirect: 'follow',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body)
    })
  } catch (e: any) { return { simulated: false, success: false, error: e?.message || 'SasaPay network error' } }

  const { json, text } = await readBody(res)
  if (res.ok && json?.status === true && (json.ResponseCode === '0' || json.ResponseCode === 0)) {
    return {
      simulated: false,
      success: true,
      b2c_request_id: String(json.B2CRequestID || ''),
      conversation_id: String(json.ConversationID || ''),
      originator_conversation_id: String(json.OriginatorConversationID || opts.reference),
      transaction_charges: String(json.TransactionCharges ?? '0.00'),
      customer_message: json.detail || json.ResponseDescription || 'Payout is being processed.',
      raw: json
    }
  }
  const msg = json?.detail || json?.ResponseDescription || json?.message || (text ? text.slice(0, 300) : `HTTP ${res.status}`)
  return { simulated: false, success: false, error: `SasaPay B2C failed [${res.status}] :: ${msg}` }
}

// ---------- Account validation ----------------------------------------------
export type SasaPayValidation = { success: boolean; account_name?: string; channel_name?: string; simulated?: boolean; error?: string; raw?: any }

export async function sasapayValidateAccount(env: SasaPayEnv, channelCode: string, accountNumber: string): Promise<SasaPayValidation> {
  if (!sasapayConfigured(env)) {
    return { success: true, simulated: true, account_name: 'SIMULATED ACCOUNT HOLDER', channel_name: channelByCode(channelCode)?.name }
  }
  let token: string
  try { token = await getToken(env) }
  catch (e: any) { return { success: false, error: e?.message || 'SasaPay auth failed' } }

  const isMobile = channelByCode(channelCode)?.type === 'mobile'
  const account = isMobile ? normalizePhone(accountNumber) : String(accountNumber)

  const url = `${baseUrl(env)}/api/v1/accounts/account-validation/`
  const body = {
    merchant_code: merchantCode(env),
    channel_code: String(channelCode),
    account_number: account,
    account_type: accountTypeForChannel(channelCode)
  }
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST', redirect: 'follow',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body)
    })
  } catch (e: any) { return { success: false, error: e?.message || 'SasaPay network error' } }

  const { json, text } = await readBody(res)
  if (res.ok && json?.status === true) {
    const d = json.account_details || {}
    return { success: true, account_name: d.account_name, channel_name: d.channel_name, raw: json }
  }
  const msg = json?.detail || json?.message || (text ? text.slice(0, 200) : `HTTP ${res.status}`)
  return { success: false, error: msg }
}

// ---------- Merchant balance ------------------------------------------------
export type SasaPayBalance = { success: boolean; simulated?: boolean; currency?: string; org_balance?: number; accounts?: any[]; error?: string; raw?: any }

export async function sasapayBalance(env: SasaPayEnv): Promise<SasaPayBalance> {
  if (!sasapayConfigured(env)) {
    return {
      success: true, simulated: true, currency: 'KES', org_balance: 0,
      accounts: [
        { account_label: 'Working Account', account_balance: 0 },
        { account_label: 'Utility Account', account_balance: 0 },
        { account_label: 'Bulk Payment', account_balance: 0 }
      ]
    }
  }
  let token: string
  try { token = await getToken(env) }
  catch (e: any) { return { success: false, error: e?.message || 'SasaPay auth failed' } }

  const url = `${baseUrl(env)}/api/v1/payments/check-balance/?MerchantCode=${encodeURIComponent(merchantCode(env) || '')}`
  let res: Response
  try {
    res = await fetch(url, { method: 'GET', redirect: 'follow', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } })
  } catch (e: any) { return { success: false, error: e?.message || 'SasaPay network error' } }

  const { json, text } = await readBody(res)
  if (res.ok && (json?.statusCode === '0' || json?.statusCode === 0)) {
    const d = json.data || {}
    return { success: true, currency: d.CurrencyCode || 'KES', org_balance: Number(d.OrgAccountBalance || 0), accounts: d.Accounts || [], raw: json }
  }
  const msg = json?.message || json?.detail || (text ? text.slice(0, 200) : `HTTP ${res.status}`)
  return { success: false, error: msg }
}

// ---------- Transaction status query ----------------------------------------
// Uses the status-query endpoint (results delivered to the callback). We also
// fall back to a synchronous interpretation when the API answers inline.
export async function sasapayQuery(env: SasaPayEnv, checkoutRequestId: string, callbackUrl?: string): Promise<any> {
  if (!sasapayConfigured(env) || String(checkoutRequestId).includes('SIM')) {
    return { ResultCode: '0', ResultDesc: 'Simulated success' }
  }
  try {
    const token = await getToken(env)
    const url = `${baseUrl(env)}/api/v1/transactions/status-query/`
    const body: Record<string, any> = { MerchantCode: merchantCode(env), CheckoutRequestId: checkoutRequestId }
    if (callbackUrl) body.CallbackUrl = callbackUrl
    const res = await fetch(url, {
      method: 'POST', redirect: 'follow',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body)
    })
    const { json } = await readBody(res)
    // status-query is async — the definitive result lands on the callback URL.
    if (json && (json.ResultCode !== undefined || json.status_code !== undefined)) return json
    return { pending: true, status_code: null, ResultDesc: 'Transaction still processing' }
  } catch {
    return { pending: true, status_code: null, ResultDesc: 'Transaction still processing' }
  }
}

// ---------- Callback signature verification (HMAC-SHA512) -------------------
// Message: sasapay_transaction_code-merchant_code-account_number-payment_reference-amount
// Secret : Merchant API Client ID.
export async function verifySasapaySignature(
  env: SasaPayEnv,
  headerSignature: string | null | undefined,
  fields: { sasapay_transaction_code?: string; merchant_code?: string; account_number?: string; payment_reference?: string; amount?: string | number }
): Promise<boolean> {
  if (!headerSignature) return false
  const secret = clientId(env)
  if (!secret) return false
  const message = [
    fields.sasapay_transaction_code ?? '',
    fields.merchant_code ?? '',
    fields.account_number ?? '',
    fields.payment_reference ?? '',
    fields.amount ?? ''
  ].join('-')
  try {
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']
    )
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
    const hex = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('')
    return timingSafeEqual(hex.toLowerCase(), String(headerSignature).trim().toLowerCase())
  } catch {
    return false
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
