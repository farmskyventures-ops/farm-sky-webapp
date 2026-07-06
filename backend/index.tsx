import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import type { Bindings, SessionUser } from './types'
import { stkPush, stkQuery, mpesaConfigured, normalizePhone } from './mpesa'
import { sasapayStkPush, sasapayQuery, sasapayConfigured } from './sasapay'
import { buniStkPush, buniQuery, buniConfigured } from './buni'
import paymentGateway from './payment-gateway'
import { sendSms, smsConfigured, generateOtp } from './sms'
import { sendEmail, emailConfigured } from './email'

const app = new Hono<{ Bindings: Bindings; Variables: { user: SessionUser } }>()

app.use('/api/*', cors())

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function genToken(): string {
  return crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '')
}
function ref(prefix: string): string {
  const n = Math.floor(Math.random() * 900000 + 100000)
  return `${prefix}-${Date.now().toString().slice(-6)}${n}`
}
function safeJson<T = any>(value: any, fallback: T): T {
  try { return value ? JSON.parse(String(value)) : fallback } catch { return fallback }
}
// Fallback permissions when role catalog has not loaded yet.
function builtinDefaults(role: string): Record<string, boolean> {
  if (['super_admin', 'admin'].includes(role)) {
    return { view: true, edit: true, delete: true, deactivate: true, approve: true, dispatch: true, add_farmer: true, view_farmers: true, view_credit_purchases: true, manage_users: true, request_admin_action: true }
  }
  if (role === 'operations_finance') {
    return { view: true, approve: true, dispatch: true, view_farmers: true, view_credit_purchases: true, request_admin_action: true }
  }
  if (role === 'agent') {
    return { view: true, add_farmer: true, view_farmers: true, view_credit_purchases: true }
  }
  if (role === 'support') {
    return { view: true, view_farmers: true, view_credit_purchases: true }
  }
  return { view: true }
}
async function loadRoleTemplate(c: any, role: string): Promise<Record<string, boolean>> {
  try {
    const row = await c.env.DB.prepare(`SELECT permissions FROM role_templates WHERE role_key=?`).bind(role).first<any>()
    if (row?.permissions) {
      const parsed = safeJson<Record<string, boolean>>(row.permissions, {})
      if (parsed && Object.keys(parsed).length) return parsed
    }
  } catch (_) {}
  return builtinDefaults(role)
}
function defaultPermissions(role: string): Record<string, boolean> {
  return builtinDefaults(role)
}
function parsePermissions(raw: any, role: string, fallback?: Record<string, boolean>) {
  const base = fallback ?? defaultPermissions(role)
  return { ...base, ...safeJson<Record<string, boolean>>(raw, {}) }
}
async function permissionsForRole(c: any, role: string, override?: Record<string, boolean>) {
  const base = await loadRoleTemplate(c, role)
  return { ...base, ...(override || {}) }
}
function hasPermission(user: SessionUser, perm: string) {
  if (['super_admin', 'admin'].includes(user.role)) return true
  return Boolean(user.permissions?.[perm])
}
// Visibility permissions are opt-out: absent key = allowed (backward compatible),
// explicit false = hidden. Admins always allowed.
function hasVisibility(user: SessionUser, perm: string) {
  if (['super_admin', 'admin'].includes(user.role)) return true
  const v = user.permissions?.[perm]
  return v === undefined ? true : Boolean(v)
}
// Redact farmer records based on Data Object Visibility permissions.
const FINANCIAL_FIELDS = ['existing_loans', 'credit_score', 'risk_band', 'annual_production']
const PROFILE_FIELDS = ['value_chain', 'value_chain_type', 'county', 'sub_county', 'ward', 'village', 'acreage', 'herd_size', 'farm_experience', 'sacco_membership', 'date_of_birth', 'gender', 'latitude', 'longitude']
const DOCUMENT_FIELDS = ['id_front_url', 'id_back_url', 'selfie_url', 'passport_photo_url']
function redactCustomer(user: SessionUser, cust: any) {
  if (!cust) return cust
  const out = { ...cust }
  if (!hasVisibility(user, 'view_financial_data')) for (const f of FINANCIAL_FIELDS) if (f in out) out[f] = null
  if (!hasVisibility(user, 'view_farmer_profile_data')) for (const f of PROFILE_FIELDS) if (f in out) out[f] = null
  if (!hasVisibility(user, 'view_document_attachments')) for (const f of DOCUMENT_FIELDS) if (f in out) out[f] = null
  return out
}
function numberVal(value: any, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}
function boolInt(value: any, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase())
}
function roundMoney(value: number) {
  return Math.round((Number(value) || 0) * 100) / 100
}
// ---- App settings (key/value JSON store) ----
async function getSetting<T = any>(c: any, key: string, fallback: T): Promise<T> {
  try {
    const row = await c.env.DB.prepare(`SELECT setting_value FROM app_settings WHERE setting_key=?`).bind(key).first<any>()
    if (row?.setting_value) return safeJson<T>(row.setting_value, fallback)
  } catch (_) {}
  return fallback
}
async function setSetting(c: any, key: string, value: any): Promise<void> {
  const json = JSON.stringify(value)
  const existing = await c.env.DB.prepare(`SELECT setting_key FROM app_settings WHERE setting_key=?`).bind(key).first<any>()
  if (existing) {
    await c.env.DB.prepare(`UPDATE app_settings SET setting_value=?, updated_at=CURRENT_TIMESTAMP WHERE setting_key=?`).bind(json, key).run()
  } else {
    await c.env.DB.prepare(`INSERT INTO app_settings (setting_key, setting_value) VALUES (?,?)`).bind(key, json).run()
  }
}
const DEFAULT_PROCESSING_FEE = { enabled: false, mode: 'percentage', percentage_rate: 0, tiers: [] as Array<{ min: number; max: number; fee: number }> }
function normalizeProcessingFee(raw: any) {
  const cfg: any = { ...DEFAULT_PROCESSING_FEE, ...(raw && typeof raw === 'object' ? raw : {}) }
  cfg.enabled = Boolean(cfg.enabled)
  cfg.mode = cfg.mode === 'tiered' ? 'tiered' : 'percentage'
  cfg.percentage_rate = numberVal(cfg.percentage_rate, 0)
  cfg.tiers = Array.isArray(cfg.tiers)
    ? cfg.tiers
        .map((t: any) => ({ min: numberVal(t.min, 0), max: numberVal(t.max, 0), fee: numberVal(t.fee, 0) }))
        .filter((t: any) => t.max >= t.min)
    : []
  return cfg
}
// Compute the processing fee applied to a borrowed (financed) amount.
function computeProcessingFee(cfg: any, borrowedAmount: number): number {
  const c = normalizeProcessingFee(cfg)
  if (!c.enabled) return 0
  const amount = Number(borrowedAmount) || 0
  if (c.mode === 'percentage') return roundMoney(amount * (c.percentage_rate / 100))
  const tier = c.tiers.find((t: any) => amount >= t.min && amount <= t.max)
  return tier ? roundMoney(tier.fee) : 0
}
// ---- Time-based access windows ----
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
function parseHM(value: any): number | null {
  const m = String(value || '').match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}
// Returns { allowed:boolean, reason?:string } given a schedule config and current time.
function checkAccessWindow(schedule: { enabled?: any; days?: any; start?: any; end?: any }, now = new Date()): { allowed: boolean; reason?: string } {
  if (!schedule || !schedule.enabled) return { allowed: true }
  const days: string[] = Array.isArray(schedule.days) ? schedule.days.map((d: string) => String(d).toLowerCase()) : []
  const today = DAY_KEYS[now.getDay()]
  if (days.length && !days.includes(today)) {
    return { allowed: false, reason: 'Access is not permitted on this day for your role.' }
  }
  const start = parseHM(schedule.start)
  const end = parseHM(schedule.end)
  if (start !== null && end !== null) {
    const cur = now.getHours() * 60 + now.getMinutes()
    if (cur < start || cur > end) {
      return { allowed: false, reason: `Access is only permitted between ${schedule.start} and ${schedule.end}.` }
    }
  }
  return { allowed: true }
}
// Resolve the effective login window for a user (user override, else role template).
async function resolveAccessWindow(c: any, user: any): Promise<{ enabled: boolean; days: string[]; start: string; end: string }> {
  if (Number(user.schedule_enabled) === 1) {
    return { enabled: true, days: safeJson<string[]>(user.access_days, []), start: user.access_start || '', end: user.access_end || '' }
  }
  try {
    const row = await c.env.DB.prepare(`SELECT schedule_enabled, access_days, access_start, access_end FROM role_templates WHERE role_key=?`).bind(user.role).first<any>()
    if (row && Number(row.schedule_enabled) === 1) {
      return { enabled: true, days: safeJson<string[]>(row.access_days, []), start: row.access_start || '', end: row.access_end || '' }
    }
  } catch (_) {}
  return { enabled: false, days: [], start: '', end: '' }
}
function normalizeProductPayload(b: any) {
  const buying = numberVal(b.buying_price)
  const cashMarkup = numberVal(b.cash_markup_pct, 10)
  const creditMarkup = numberVal(b.credit_markup_pct, 20)
  const cashPrice = numberVal(b.cash_price, roundMoney(buying * (1 + cashMarkup / 100)))
  const creditPrice = numberVal(b.credit_price, roundMoney(buying * (1 + creditMarkup / 100)))
  const paymentMode = b.payment_option_mode || (boolInt(b.cash_enabled, true) && boolInt(b.financing_enabled, true) ? 'both' : boolInt(b.cash_enabled, true) ? 'cash' : 'financing')
  return {
    sku: String(b.sku || '').trim(),
    name: String(b.name || '').trim(),
    category: String(b.category || 'Equipment').trim(),
    description: b.description || null,
    product_type: b.product_type || 'equipment',
    supplier_id: b.supplier_id || null,
    buying_price: buying,
    cash_markup_pct: cashMarkup,
    credit_markup_pct: creditMarkup,
    cash_price: cashPrice,
    credit_price: creditPrice,
    quantity: numberVal(b.quantity, 0),
    unit: b.unit || 'unit',
    reorder_threshold: numberVal(b.reorder_threshold, 10),
    image: b.image || null,
    cash_enabled: boolInt(b.cash_enabled, paymentMode !== 'financing'),
    financing_enabled: boolInt(b.financing_enabled, paymentMode !== 'cash'),
    payment_option_mode: paymentMode,
    financing_model: b.financing_model || 'loan_interest',
    financing_interest_pct: numberVal(b.financing_interest_pct, 0),
    financing_frequency: b.financing_frequency || 'monthly',
    financing_term_min_months: numberVal(b.financing_term_min_months, 3),
    financing_term_max_months: numberVal(b.financing_term_max_months, 12),
    cash_deposit_pct: numberVal(b.cash_deposit_pct, 100),
    financing_deposit_pct: numberVal(b.financing_deposit_pct, 10),
    cash_terms_text: b.cash_terms_text || null,
    financing_terms_text: b.financing_terms_text || null,
    cash_terms_doc_url: b.cash_terms_doc_url || null,
    financing_terms_doc_url: b.financing_terms_doc_url || null,
    transunion_product_code: b.transunion_product_code || null
  }
}
function financingQuote(p: any, quantity: any, paymentType: string, termMonths: any, processingFeeCfg?: any) {
  const qty = Math.max(1, numberVal(quantity, 1))
  const supplier_cost = roundMoney(numberVal(p.buying_price) * qty)
  if (paymentType === 'cash') {
    const total = roundMoney(numberVal(p.cash_price) * qty)
    const deposit_pct = numberVal(p.cash_deposit_pct, 100)
    const amount_due_now = roundMoney(total * deposit_pct / 100)
    return {
      quantity: qty,
      supplier_cost,
      payment_type: 'cash',
      financing_model: 'cash',
      markup_pct: numberVal(p.cash_markup_pct, 0),
      amount_due_now,
      deposit_pct,
      deposit_amount: amount_due_now,
      finance_principal: total,
      term_months: 0,
      payment_frequency: 'one_off',
      installment_count: 0,
      installment_amount: 0,
      total_price: total,
      total_payable: total,
      outstanding_after_deposit: roundMoney(total - amount_due_now),
      disclosure_note: deposit_pct >= 100 ? 'Full cash payment is required at checkout.' : deposit_pct > 0 ? `A ${deposit_pct}% deposit is required to confirm the cash order.` : 'No deposit is required at checkout for this cash order.',
      terms_text: p.cash_terms_text || null,
      terms_document_url: p.cash_terms_doc_url || null
    }
  }
  const term = Math.max(numberVal(p.financing_term_min_months, 3), Math.min(numberVal(termMonths, numberVal(p.financing_term_min_months, 3)), numberVal(p.financing_term_max_months, 12)))
  const principalBase = roundMoney(numberVal(p.credit_price || p.cash_price) * qty)
  const deposit_pct = numberVal(p.financing_deposit_pct, 10)
  const deposit_amount = roundMoney(principalBase * deposit_pct / 100)
  const finance_principal = roundMoney(principalBase - deposit_amount)
  const interestRate = numberVal(p.financing_interest_pct, 0)
  const model = p.financing_model || 'loan_interest'
  const frequency = p.financing_frequency || (model === 'paygo' ? 'daily' : 'monthly')
  const installment_count = frequency === 'daily' ? term * 30 : frequency === 'weekly' ? term * 4 : term
  const financing_charge = model === 'loan_interest'
    ? roundMoney(finance_principal * (interestRate / 100) * (term / 12))
    : roundMoney(finance_principal * (interestRate / 100) * (term / 12))
  // Processing fee is calculated on the amount borrowed (finance principal).
  const processing_fee = computeProcessingFee(processingFeeCfg, finance_principal)
  const financed_total = roundMoney(finance_principal + financing_charge + processing_fee)
  const installment_amount = installment_count > 0 ? roundMoney(financed_total / installment_count) : financed_total
  const total_payable = roundMoney(deposit_amount + financed_total)
  return {
    quantity: qty,
    supplier_cost,
    payment_type: 'financing',
    financing_model: model,
    markup_pct: interestRate,
    amount_due_now: deposit_amount,
    deposit_pct,
    deposit_amount,
    finance_principal,
    processing_fee,
    interest_rate_pct: interestRate,
    term_months: term,
    payment_frequency: frequency,
    installment_count,
    installment_amount,
    monthly_payment: frequency === 'monthly' ? installment_amount : roundMoney(financed_total / Math.max(term, 1)),
    total_price: principalBase,
    total_payable,
    outstanding_after_deposit: financed_total,
    disclosure_note: (model === 'paygo'
      ? 'PAYGO financing uses an upfront deposit and scheduled unlock payments similar to M-KOPA, adapted for agricultural equipment.'
      : 'Normal financing applies the configured flat interest across the selected term.')
      + (processing_fee > 0 ? ` A processing fee of ${processing_fee.toLocaleString()} applies to the financed amount.` : ''),
    terms_text: p.financing_terms_text || null,
    terms_document_url: p.financing_terms_doc_url || null
  }
}
async function getSessionUser(c: any): Promise<SessionUser | null> {
  const token = getCookie(c, 'session') || c.req.header('Authorization')?.replace('Bearer ', '')
  if (!token) return null
  const row = await c.env.DB.prepare(
    `SELECT u.id, u.full_name, u.phone, u.role, u.region, u.label, u.permissions, u.status,
            u.schedule_enabled, u.access_days, u.access_start, u.access_end, s.expires_at
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`
  ).bind(token).first<any>()
  if (!row) return null
  if (Number(row.expires_at) < Date.now()) return null
  if (row.status !== 'active') return null
  // Enforce time-based access window on every request.
  const window = await resolveAccessWindow(c, row)
  const access = checkAccessWindow({ enabled: window.enabled, days: window.days, start: window.start, end: window.end })
  if (!access.allowed) return null
  const fallback = await loadRoleTemplate(c, row.role)
  return {
    id: row.id,
    full_name: row.full_name,
    phone: row.phone,
    role: row.role,
    region: row.region,
    label: row.label || null,
    permissions: parsePermissions(row.permissions, row.role, fallback)
  }
}
async function requireAuth(c: any, next: any) {
  const user = await getSessionUser(c)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  c.set('user', user)
  await next()
}
function requireRole(...roles: string[]) {
  return async (c: any, next: any) => {
    const user = c.get('user') as SessionUser
    if (!roles.includes(user.role)) return c.json({ error: 'Forbidden' }, 403)
    await next()
  }
}
function requirePermission(...perms: string[]) {
  return async (c: any, next: any) => {
    const user = c.get('user') as SessionUser
    if (!perms.some((perm) => hasPermission(user, perm))) return c.json({ error: 'Forbidden' }, 403)
    await next()
  }
}
async function audit(c: any, userId: number | null, action: string, entity: string, detail: string) {
  try {
    await c.env.DB.prepare(`INSERT INTO audit_logs (user_id, action, entity, detail) VALUES (?,?,?,?)`)
      .bind(userId, action, entity, detail).run()
  } catch (_) {}
}
function genPassword(): string {
  return String(Math.floor(1000 + Math.random() * 9000))
}
async function createSession(c: any, user: any) {
  const token = genToken()
  const expires = Date.now() + 1000 * 60 * 60 * 12
  await c.env.DB.prepare(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)`).bind(token, user.id, expires).run()
  setCookie(c, 'session', token, { path: '/', httpOnly: true, maxAge: 60 * 60 * 12, sameSite: 'Lax' })
  return token
}
// Issue an OTP, persist it, and send via SMS. Returns demo_otp when SMS not configured.
async function issueOtp(c: any, phone: string, purpose: string) {
  const code = generateOtp()
  const expires = Date.now() + 1000 * 60 * 5 // 5 minutes
  // Invalidate previous unconsumed OTPs for this phone+purpose
  await c.env.DB.prepare(`UPDATE otp_codes SET consumed=1 WHERE phone=? AND purpose=? AND consumed=0`).bind(phone, purpose).run()
  await c.env.DB.prepare(`INSERT INTO otp_codes (phone, code, purpose, expires_at) VALUES (?,?,?,?)`).bind(phone, code, purpose, expires).run()
  const msg = `Your Farmsky verification code is ${code}. It expires in 5 minutes.`
  const sms = await sendSms(c.env, phone, msg)
  return { sms, demo_otp: sms.simulated ? code : undefined }
}
// Validate an OTP; marks it consumed on success.
async function verifyOtp(c: any, phone: string, code: string, purpose: string): Promise<{ ok: boolean; error?: string }> {
  const row = await c.env.DB.prepare(
    `SELECT * FROM otp_codes WHERE phone=? AND purpose=? AND consumed=0 ORDER BY id DESC LIMIT 1`
  ).bind(phone, purpose).first<any>()
  if (!row) return { ok: false, error: 'No active code. Request a new one.' }
  if (Number(row.expires_at) < Date.now()) return { ok: false, error: 'Code expired. Request a new one.' }
  if (Number(row.attempts) >= 5) return { ok: false, error: 'Too many attempts. Request a new code.' }
  if (String(row.code) !== String(code).trim()) {
    await c.env.DB.prepare(`UPDATE otp_codes SET attempts=attempts+1 WHERE id=?`).bind(row.id).run()
    return { ok: false, error: 'Incorrect code.' }
  }
  await c.env.DB.prepare(`UPDATE otp_codes SET consumed=1 WHERE id=?`).bind(row.id).run()
  return { ok: true }
}

// ----------------------------------------------------------------------------
// AUTH
// ----------------------------------------------------------------------------
app.post('/api/login', async (c) => {
  const { phone, password } = await c.req.json()
  const raw = String(phone || '').trim()
  const norm = normalizePhone(raw)
  // Match either the exact entered value or the normalized 2547... form,
  // so seeded "+254..." accounts and OTP-normalized accounts both work.
  let user = await c.env.DB.prepare(`SELECT * FROM users WHERE phone = ? OR phone = ?`).bind(raw, norm).first<any>()
  if (!user || user.password !== String(password)) return c.json({ error: 'Invalid phone number or password' }, 401)
  if (user.status !== 'active') return c.json({ error: 'Account suspended' }, 403)
  // Enforce time-based access windows (per-user override, else role template).
  const window = await resolveAccessWindow(c, user)
  const access = checkAccessWindow({ enabled: window.enabled, days: window.days, start: window.start, end: window.end })
  if (!access.allowed) return c.json({ error: access.reason || 'Access is restricted at this time.' }, 403)
  const token = await createSession(c, user)
  await audit(c, user.id, 'login', 'user', `${user.role} logged in`)
  const loginFallback = await loadRoleTemplate(c, user.role)
  return c.json({ token, user: { id: user.id, full_name: user.full_name, phone: user.phone, role: user.role, region: user.region, label: user.label || null, permissions: parsePermissions(user.permissions, user.role, loginFallback) } })
})
app.post('/api/logout', async (c) => {
  const token = getCookie(c, 'session')
  if (token) await c.env.DB.prepare(`DELETE FROM sessions WHERE token = ?`).bind(token).run()
  deleteCookie(c, 'session', { path: '/' })
  return c.json({ ok: true })
})
app.get('/api/me', requireAuth, (c) => c.json({ user: c.get('user') }))

// ---- Auth provider status (so the UI can show live vs demo) ----
app.get('/api/auth/status', (c) => c.json({ sms_live: smsConfigured(c.env) }))
app.get('/api/integrations/transunion/status', requireAuth, (c) => {
  const live = Boolean(c.env.TRANSUNION_API_URL && c.env.TRANSUNION_API_KEY)
  return c.json({ live, environment: c.env.TRANSUNION_ENV || 'stub', ready_for_mapping: live })
})

// ---- Customer SIGN-UP via SMS OTP ----
// Step 1: request an OTP for a new phone number.
app.post('/api/signup/request-otp', async (c) => {
  const { phone, full_name } = await c.req.json()
  const p = normalizePhone(phone || '')
  if (!p || p.length < 9) return c.json({ error: 'Enter a valid phone number' }, 400)
  if (!full_name || String(full_name).trim().length < 2) return c.json({ error: 'Enter your full name' }, 400)
  const existing = await c.env.DB.prepare(`SELECT id FROM users WHERE phone=?`).bind(p).first()
  if (existing) return c.json({ error: 'An account with this phone already exists. Please sign in.' }, 409)
  const { sms, demo_otp } = await issueOtp(c, p, 'signup')
  if (!sms.simulated && !sms.success) return c.json({ error: sms.error || 'Failed to send OTP' }, 502)
  return c.json({ ok: true, phone: p, message: sms.simulated ? 'Demo mode: use the code shown below.' : `OTP sent to ${p}.`, demo_otp })
})
// Step 2: verify OTP + set password -> create account + auto sign-in.
app.post('/api/signup/verify', async (c) => {
  const { phone, full_name, code, password, region, national_id, id_front_url, id_back_url } = await c.req.json()
  const p = normalizePhone(phone || '')
  if (!password || String(password).length < 4) return c.json({ error: 'Password must be at least 4 characters' }, 400)
  if (!id_front_url || !id_back_url) return c.json({ error: 'Upload front and back of the national ID to continue' }, 400)
  const v = await verifyOtp(c, p, code, 'signup')
  if (!v.ok) return c.json({ error: v.error }, 400)
  const existing = await c.env.DB.prepare(`SELECT id FROM users WHERE phone=?`).bind(p).first()
  if (existing) return c.json({ error: 'Account already exists. Please sign in.' }, 409)
  const role = 'customer'
  const farmerPerms = await permissionsForRole(c, role)
  const r = await c.env.DB.prepare(
    `INSERT INTO users (full_name, phone, password, role, status, region, password_set, label, permissions) VALUES (?,?,?, ?, 'active', ?, 1, ?, ?)`
  ).bind(String(full_name).trim(), p, String(password), role, region || null, 'Farmer', JSON.stringify(farmerPerms)).run()
  const userId = r.meta.last_row_id
  await c.env.DB.prepare(
    `INSERT INTO customers (user_id, full_name, national_id, mobile, id_front_url, id_back_url, kyc_status) VALUES (?,?,?,?,?,?, 'pending')`
  ).bind(userId, String(full_name).trim(), national_id || null, p, id_front_url, id_back_url).run()
  const user = { id: userId, full_name: String(full_name).trim(), phone: p, role, region, label: 'Farmer', permissions: farmerPerms }
  await createSession(c, user)
  await audit(c, userId, 'signup', 'user', 'customer self-registered via SMS OTP with ID documents')
  return c.json({ ok: true, user })
})

// ---- PASSWORD RESET via SMS OTP ----
app.post('/api/reset-password/request-otp', async (c) => {
  const { phone } = await c.req.json()
  const p = normalizePhone(phone || '')
  const user = await c.env.DB.prepare(`SELECT id FROM users WHERE phone=?`).bind(p).first()
  // Do not reveal whether the phone exists; but in demo we send anyway only if it exists.
  if (!user) return c.json({ ok: true, phone: p, message: 'If the number is registered, an OTP has been sent.' })
  const { sms, demo_otp } = await issueOtp(c, p, 'reset')
  if (!sms.simulated && !sms.success) return c.json({ error: sms.error || 'Failed to send OTP' }, 502)
  return c.json({ ok: true, phone: p, message: sms.simulated ? 'Demo mode: use the code shown below.' : `OTP sent to ${p}.`, demo_otp })
})
app.post('/api/reset-password/verify', async (c) => {
  const { phone, code, password } = await c.req.json()
  const p = normalizePhone(phone || '')
  if (!password || String(password).length < 4) return c.json({ error: 'Password must be at least 4 characters' }, 400)
  const v = await verifyOtp(c, p, code, 'reset')
  if (!v.ok) return c.json({ error: v.error }, 400)
  const user = await c.env.DB.prepare(`SELECT id FROM users WHERE phone=?`).bind(p).first<any>()
  if (!user) return c.json({ error: 'Account not found' }, 404)
  await c.env.DB.prepare(`UPDATE users SET password=?, password_set=1 WHERE id=?`).bind(String(password), user.id).run()
  await audit(c, user.id, 'reset_password', 'user', 'password reset via SMS OTP')
  return c.json({ ok: true, message: 'Password updated. You can now sign in.' })
})

// ----------------------------------------------------------------------------
// PRODUCTS / INVENTORY
// ----------------------------------------------------------------------------
app.get('/api/products', requireAuth, async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT * FROM products ORDER BY name`).all()
  const withStatus = results.map((p: any) => ({
    ...p,
    stock_status: p.quantity <= 0 ? 'out_of_stock' : p.quantity <= p.reorder_threshold ? 'low_stock' : 'in_stock'
  }))
  return c.json({ products: withStatus })
})
app.post('/api/products', requireAuth, requireRole('admin', 'super_admin'), async (c) => {
  const p = normalizeProductPayload(await c.req.json())
  if (!p.sku || !p.name) return c.json({ error: 'SKU and name are required' }, 400)
  const r = await c.env.DB.prepare(
    `INSERT INTO products (sku,name,category,description,product_type,supplier_id,buying_price,cash_markup_pct,credit_markup_pct,cash_price,credit_price,quantity,unit,reorder_threshold,image,cash_enabled,financing_enabled,payment_option_mode,financing_model,financing_interest_pct,financing_frequency,financing_term_min_months,financing_term_max_months,cash_deposit_pct,financing_deposit_pct,cash_terms_text,financing_terms_text,cash_terms_doc_url,financing_terms_doc_url,transunion_product_code)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    p.sku, p.name, p.category, p.description, p.product_type, p.supplier_id, p.buying_price, p.cash_markup_pct, p.credit_markup_pct,
    p.cash_price, p.credit_price, p.quantity, p.unit, p.reorder_threshold, p.image, p.cash_enabled, p.financing_enabled,
    p.payment_option_mode, p.financing_model, p.financing_interest_pct, p.financing_frequency, p.financing_term_min_months,
    p.financing_term_max_months, p.cash_deposit_pct, p.financing_deposit_pct, p.cash_terms_text, p.financing_terms_text,
    p.cash_terms_doc_url, p.financing_terms_doc_url, p.transunion_product_code
  ).run()
  await audit(c, c.get('user').id, 'create', 'product', `${p.name} (${p.payment_option_mode})`)
  return c.json({ id: r.meta.last_row_id })
})
app.put('/api/products/:id', requireAuth, requireRole('admin', 'super_admin'), async (c) => {
  const id = c.req.param('id')
  const p = normalizeProductPayload(await c.req.json())
  await c.env.DB.prepare(
    `UPDATE products SET sku=?, name=?, category=?, description=?, product_type=?, buying_price=?, cash_markup_pct=?, credit_markup_pct=?, cash_price=?, credit_price=?, quantity=?, unit=?, reorder_threshold=?, image=COALESCE(?, image), cash_enabled=?, financing_enabled=?, payment_option_mode=?, financing_model=?, financing_interest_pct=?, financing_frequency=?, financing_term_min_months=?, financing_term_max_months=?, cash_deposit_pct=?, financing_deposit_pct=?, cash_terms_text=?, financing_terms_text=?, cash_terms_doc_url=?, financing_terms_doc_url=?, transunion_product_code=? WHERE id=?`
  ).bind(
    p.sku, p.name, p.category, p.description, p.product_type, p.buying_price, p.cash_markup_pct, p.credit_markup_pct,
    p.cash_price, p.credit_price, p.quantity, p.unit, p.reorder_threshold, p.image || null, p.cash_enabled, p.financing_enabled,
    p.payment_option_mode, p.financing_model, p.financing_interest_pct, p.financing_frequency, p.financing_term_min_months,
    p.financing_term_max_months, p.cash_deposit_pct, p.financing_deposit_pct, p.cash_terms_text, p.financing_terms_text,
    p.cash_terms_doc_url, p.financing_terms_doc_url, p.transunion_product_code, id
  ).run()
  await audit(c, c.get('user').id, 'update', 'product', p.name)
  return c.json({ ok: true })
})
app.delete('/api/products/:id', requireAuth, requireRole('admin', 'super_admin'), async (c) => {
  const id = c.req.param('id')
  const used = await c.env.DB.prepare(`SELECT COUNT(*)::int n FROM murabaha_contracts WHERE product_id=?`).bind(id).first<any>()
  if (used?.n > 0) return c.json({ error: 'Cannot delete: product is referenced by existing purchases' }, 400)
  await c.env.DB.prepare(`DELETE FROM products WHERE id=?`).bind(id).run()
  await audit(c, c.get('user').id, 'delete', 'product', String(id))
  return c.json({ ok: true })
})
app.put('/api/products/:id/stock', requireAuth, requireRole('admin', 'super_admin'), async (c) => {
  const id = c.req.param('id')
  const { quantity, movement_type } = await c.req.json()
  await c.env.DB.prepare(`UPDATE products SET quantity = quantity + ? WHERE id = ?`).bind(Number(quantity), id).run()
  await c.env.DB.prepare(`INSERT INTO stock_movements (product_id, movement_type, quantity, reference) VALUES (?,?,?,?)`)
    .bind(id, movement_type || 'purchase', quantity, 'manual adjustment').run()
  return c.json({ ok: true })
})

// ----------------------------------------------------------------------------
// CUSTOMERS / ONBOARDING / VERIFICATION
// ----------------------------------------------------------------------------
app.get('/api/customers', requireAuth, async (c) => {
  const user = c.get('user')
  let query = `SELECT * FROM customers`
  let binds: any[] = []
  if (user.role === 'agent') { query += ` WHERE agent_id = ?`; binds = [user.id] }
  query += ` ORDER BY created_at DESC`
  const { results } = await c.env.DB.prepare(query).bind(...binds).all()
  return c.json({ customers: (results as any[]).map((r) => redactCustomer(user, r)) })
})
app.get('/api/customers/:id', requireAuth, async (c) => {
  const user = c.get('user') as SessionUser
  const cust = await c.env.DB.prepare(`SELECT * FROM customers WHERE id=?`).bind(c.req.param('id')).first()
  if (!cust) return c.json({ error: 'Not found' }, 404)
  const tu = await c.env.DB.prepare(`SELECT * FROM transunion_checks WHERE customer_id=? ORDER BY id DESC LIMIT 1`).bind(c.req.param('id')).first()
  const idv = await c.env.DB.prepare(`SELECT * FROM id_verifications WHERE customer_id=? ORDER BY id DESC LIMIT 1`).bind(c.req.param('id')).first()
  const showFinancial = hasVisibility(user, 'view_financial_data')
  return c.json({ customer: redactCustomer(user, cust), transunion: showFinancial ? tu : null, id_verification: idv })
})
app.post('/api/customers', requireAuth, requireRole('agent', 'admin', 'super_admin'), async (c) => {
  const b = await c.req.json()
  const user = c.get('user')
  const saccoMember = ['yes', 'true', '1', 'on'].includes(String(b.sacco_membership || '').toLowerCase())
  const r = await c.env.DB.prepare(
    `INSERT INTO customers (agent_id,full_name,national_id,date_of_birth,gender,mobile,alt_mobile,county,sub_county,ward,village,latitude,longitude,value_chain_type,value_chain,acreage,herd_size,farm_experience,annual_production,existing_loans,sacco_membership,id_front_url,id_back_url,kyc_status,status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'pending', 'active')`
  ).bind(
    user.role === 'agent' ? user.id : (b.agent_id || user.id),
    b.full_name, b.national_id, b.date_of_birth, b.gender, b.mobile, b.alt_mobile, b.county, b.sub_county,
    b.ward, b.village, b.latitude || null, b.longitude || null, b.value_chain_type, b.value_chain,
    b.acreage || null, b.herd_size || null, b.farm_experience || null, b.annual_production || null,
    b.existing_loans || null,
    saccoMember ? 'yes' : 'no',
    b.id_front_url || null, b.id_back_url || null
  ).run()
  await audit(c, user.id, 'onboard', 'customer', b.full_name)
  return c.json({ id: r.meta.last_row_id })
})
// Update farmer profile (admin + agent for their own customer)
app.put('/api/customers/:id', requireAuth, async (c) => {
  const user = c.get('user') as SessionUser
  const id = c.req.param('id')
  const cust = await c.env.DB.prepare(`SELECT * FROM customers WHERE id=?`).bind(id).first<any>()
  if (!cust) return c.json({ error: 'Not found' }, 404)
  const isAdmin = ['admin', 'super_admin'].includes(user.role)
  const isOwningAgent = user.role === 'agent' && cust.agent_id === user.id
  if (!isAdmin && !isOwningAgent) return c.json({ error: 'Forbidden' }, 403)
  const b = await c.req.json()
  const saccoProvided = b.sacco_membership !== undefined
  const saccoMember = ['yes', 'true', '1', 'on'].includes(String(b.sacco_membership || '').toLowerCase())
  await c.env.DB.prepare(
    `UPDATE customers SET
      full_name=COALESCE(?, full_name),
      national_id=COALESCE(?, national_id),
      date_of_birth=COALESCE(?, date_of_birth),
      gender=COALESCE(?, gender),
      mobile=COALESCE(?, mobile),
      alt_mobile=COALESCE(?, alt_mobile),
      county=COALESCE(?, county),
      sub_county=COALESCE(?, sub_county),
      ward=COALESCE(?, ward),
      village=COALESCE(?, village),
      latitude=COALESCE(?, latitude),
      longitude=COALESCE(?, longitude),
      value_chain_type=COALESCE(?, value_chain_type),
      value_chain=COALESCE(?, value_chain),
      acreage=COALESCE(?, acreage),
      herd_size=COALESCE(?, herd_size),
      farm_experience=COALESCE(?, farm_experience),
      annual_production=COALESCE(?, annual_production),
      existing_loans=COALESCE(?, existing_loans),
      sacco_membership=COALESCE(?, sacco_membership),
      id_front_url=COALESCE(?, id_front_url),
      id_back_url=COALESCE(?, id_back_url)
     WHERE id=?`
  ).bind(
    b.full_name ?? null, b.national_id ?? null, b.date_of_birth ?? null, b.gender ?? null,
    b.mobile ?? null, b.alt_mobile ?? null, b.county ?? null, b.sub_county ?? null,
    b.ward ?? null, b.village ?? null, b.latitude ?? null, b.longitude ?? null,
    b.value_chain_type ?? null, b.value_chain ?? null, b.acreage ?? null, b.herd_size ?? null,
    b.farm_experience ?? null, b.annual_production ?? null, b.existing_loans ?? null,
    saccoProvided ? (saccoMember ? 'yes' : 'no') : null,
    b.id_front_url ?? null, b.id_back_url ?? null, id
  ).run()
  await audit(c, user.id, 'update', 'customer', String(id))
  return c.json({ ok: true })
})
// Admin can suspend / reactivate farmer profiles
app.put('/api/customers/:id/status', requireAuth, requireRole('admin', 'super_admin'), async (c) => {
  const id = c.req.param('id')
  const { status } = await c.req.json()
  if (!['active', 'suspended'].includes(String(status))) return c.json({ error: 'Status must be active or suspended' }, 400)
  const cust = await c.env.DB.prepare(`SELECT user_id FROM customers WHERE id=?`).bind(id).first<any>()
  if (!cust) return c.json({ error: 'Not found' }, 404)
  await c.env.DB.prepare(`UPDATE customers SET status=? WHERE id=?`).bind(status, id).run()
  if (cust.user_id) {
    await c.env.DB.prepare(`UPDATE users SET status=? WHERE id=?`).bind(status, cust.user_id).run()
    if (status === 'suspended') await c.env.DB.prepare(`DELETE FROM sessions WHERE user_id=?`).bind(cust.user_id).run()
  }
  await audit(c, c.get('user').id, status === 'active' ? 'activate' : 'deactivate', 'customer', String(id))
  return c.json({ ok: true })
})
// Admin can delete farmer profiles (and the linked customer-role user)
app.delete('/api/customers/:id', requireAuth, requireRole('admin', 'super_admin'), async (c) => {
  const id = c.req.param('id')
  const cust = await c.env.DB.prepare(`SELECT user_id FROM customers WHERE id=?`).bind(id).first<any>()
  if (!cust) return c.json({ error: 'Not found' }, 404)
  const open = await c.env.DB.prepare(`SELECT COUNT(*)::int n FROM murabaha_contracts WHERE customer_id=? AND status IN ('active','pending','pending_payment')`).bind(id).first<any>()
  if (Number(open?.n || 0) > 0) return c.json({ error: 'Farmer has open contracts. Settle or cancel them first.' }, 400)
  await c.env.DB.prepare(`DELETE FROM transunion_checks WHERE customer_id=?`).bind(id).run()
  await c.env.DB.prepare(`DELETE FROM id_verifications WHERE customer_id=?`).bind(id).run()
  await c.env.DB.prepare(`DELETE FROM customers WHERE id=?`).bind(id).run()
  if (cust.user_id) {
    await c.env.DB.prepare(`DELETE FROM sessions WHERE user_id=?`).bind(cust.user_id).run()
    await c.env.DB.prepare(`DELETE FROM users WHERE id=? AND role='customer'`).bind(cust.user_id).run()
  }
  await audit(c, c.get('user').id, 'delete', 'customer', String(id))
  return c.json({ ok: true })
})
// Verification engine (TransUnion integration-ready; simulated scoring until live mapping is added)
app.post('/api/customers/:id/verify', requireAuth, async (c) => {
  const id = c.req.param('id')
  const user = c.get('user')
  const cust = await c.env.DB.prepare(`SELECT * FROM customers WHERE id=?`).bind(id).first<any>()
  if (!cust) return c.json({ error: 'Not found' }, 404)
  if (!['admin', 'super_admin', 'agent', 'operations_finance'].includes(user.role)) {
    if (!(user.role === 'customer' && cust.user_id === user.id)) return c.json({ error: 'Forbidden' }, 403)
  }
  if (!cust.id_front_url || !cust.id_back_url) return c.json({ error: 'Front and back national ID uploads are required before verification' }, 400)
  const transunionLive = Boolean(c.env.TRANSUNION_API_URL && c.env.TRANSUNION_API_KEY)
  const score = Math.floor(Math.random() * 350 + 450)
  const band = score >= 700 ? 'low' : score >= 600 ? 'medium' : 'high'
  const providerRef = `TU-${Date.now()}`
  await c.env.DB.prepare(`INSERT INTO transunion_checks (customer_id,credit_score,risk_band,defaults_found,raw_response,provider_reference,integration_status) VALUES (?,?,?,?,?,?,?)`)
    .bind(id, score, band, band === 'high' ? 1 : 0, JSON.stringify({ score, band, integration_ready: transunionLive }), providerRef, transunionLive ? 'ready_for_live_mapping' : 'stubbed').run()
  await c.env.DB.prepare(`INSERT INTO id_verifications (customer_id,face_match,liveness,ocr_name,ocr_dob,ocr_id_number,status) VALUES (?,?,?,?,?,?, 'verified')`)
    .bind(id, 1, 1, cust.full_name, cust.date_of_birth, cust.national_id).run()
  await c.env.DB.prepare(`UPDATE customers SET kyc_status='verified', risk_band=?, credit_score=? WHERE id=?`).bind(band, score, id).run()
  await audit(c, user.id, 'verify', 'customer', `KYC verified for ${cust.full_name}`)
  return c.json({ ok: true, credit_score: score, risk_band: band, face_match: true, liveness: true, transunion_integration_ready: transunionLive, provider_reference: providerRef })
})

// ----------------------------------------------------------------------------
// MURABAHA
// ----------------------------------------------------------------------------
app.post('/api/murabaha/quote', requireAuth, async (c) => {
  const { product_id, quantity, payment_type, term_months } = await c.req.json()
  const p = await c.env.DB.prepare(`SELECT * FROM products WHERE id=?`).bind(product_id).first<any>()
  if (!p) return c.json({ error: 'Product not found' }, 404)
  if (payment_type === 'cash' && !p.cash_enabled) return c.json({ error: 'Cash purchase is not enabled for this equipment' }, 400)
  if (payment_type !== 'cash' && !p.financing_enabled) return c.json({ error: 'Financing is not enabled for this equipment' }, 400)
  const feeCfg = await getSetting(c, 'processing_fee', DEFAULT_PROCESSING_FEE)
  const q = financingQuote(p, quantity, payment_type === 'cash' ? 'cash' : 'financing', term_months, feeCfg)
  return c.json({ product: p.name, ...q })
})
app.post('/api/murabaha/apply', requireAuth, async (c) => {
  const user = c.get('user')
  const { customer_id, product_id, quantity, payment_type, term_months, delivery_location, consent } = await c.req.json()
  if (!consent) return c.json({ error: 'Customer consent to the configured terms is required' }, 400)
  const p = await c.env.DB.prepare(`SELECT * FROM products WHERE id=?`).bind(product_id).first<any>()
  if (!p) return c.json({ error: 'Product not found' }, 404)
  const qty = Math.max(1, Number(quantity) || 1)
  if (p.quantity < qty) return c.json({ error: 'Insufficient stock' }, 400)
  let custId = customer_id
  if (user.role === 'customer') {
    const myCust = await c.env.DB.prepare(`SELECT id, agent_id FROM customers WHERE user_id=?`).bind(user.id).first<any>()
    if (!myCust) return c.json({ error: 'Customer profile not found' }, 404)
    custId = myCust.id
  }
  const custRow = await c.env.DB.prepare(`SELECT * FROM customers WHERE id=?`).bind(custId).first<any>()
  const normalizedPaymentType = payment_type === 'cash' ? 'cash' : 'financing'
  if (normalizedPaymentType === 'financing' && custRow?.kyc_status !== 'verified') {
    return c.json({
      error: 'kyc_required',
      message: 'Complete registration (TransUnion credit check, ID upload, and liveness verification) before equipment financing purchases.',
      customer_id: custId
    }, 412)
  }
  const feeCfg = await getSetting(c, 'processing_fee', DEFAULT_PROCESSING_FEE)
  const q = financingQuote(p, qty, normalizedPaymentType, term_months, feeCfg)
  const contractRef = ref(normalizedPaymentType === 'cash' ? 'CSH' : (q.financing_model === 'paygo' ? 'PGO' : 'FIN'))
  const status = normalizedPaymentType === 'cash'
    ? (q.amount_due_now > 0 ? 'pending_payment' : 'awaiting_cash_balance')
    : 'pending'
  const r = await c.env.DB.prepare(
    `INSERT INTO murabaha_contracts (contract_ref,customer_id,agent_id,product_id,quantity,payment_type,supplier_cost,markup_pct,murabaha_price,term_months,monthly_payment,delivery_location,status,ownership_recorded,consent_given,amount_paid,outstanding,financing_model,interest_rate_pct,deposit_pct,deposit_amount,finance_principal,payment_frequency,installment_amount,dispatch_status,terms_document_url,terms_text)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    contractRef, custId, custRow?.agent_id || null, product_id, qty, normalizedPaymentType, q.supplier_cost, q.markup_pct,
    q.total_payable, q.term_months, q.monthly_payment || q.installment_amount || 0, delivery_location || '', status,
    0, 1, 0, q.total_payable, q.financing_model, q.interest_rate_pct || 0, q.deposit_pct, q.deposit_amount,
    q.finance_principal, q.payment_frequency, q.installment_amount || 0, 'pending', q.terms_document_url || null, q.terms_text || null
  ).run()
  const contractId = r.meta.last_row_id
  await audit(c, user.id, 'apply', 'financing', `${normalizedPaymentType} ${contractRef}`)
  return c.json({
    id: contractId,
    contract_ref: contractRef,
    status,
    payment_type: normalizedPaymentType,
    financing_model: q.financing_model,
    amount_due_now: q.amount_due_now,
    total_payable: q.total_payable,
    outstanding: q.total_payable,
    installment_amount: q.installment_amount,
    monthly_payment: q.monthly_payment || q.installment_amount,
    requires_payment: normalizedPaymentType === 'cash' && q.amount_due_now > 0,
    payment_frequency: q.payment_frequency
  })
})
app.get('/api/murabaha', requireAuth, async (c) => {
  const user = c.get('user')
  let q = `SELECT mc.*, p.name as product_name, cu.full_name as customer_name
           FROM murabaha_contracts mc JOIN products p ON p.id = mc.product_id JOIN customers cu ON cu.id = mc.customer_id`
  const binds: any[] = []
  const where: string[] = []
  if (user.role === 'agent') { where.push(`mc.agent_id = ?`); binds.push(user.id) }
  else if (user.role === 'customer') {
    const myCust = await c.env.DB.prepare(`SELECT id FROM customers WHERE user_id=?`).bind(user.id).first<any>()
    where.push(`mc.customer_id = ?`); binds.push(myCust?.id || -1)
  } else {
    // Staff roles: enforce Sales Visibility permissions (cash vs financed).
    const canCash = hasVisibility(user, 'view_cash_sales')
    const canFin = hasVisibility(user, 'view_financed_sales')
    if (!canCash && !canFin) { where.push(`1 = 0`) }
    else if (canCash && !canFin) { where.push(`mc.payment_type = 'cash'`) }
    else if (!canCash && canFin) { where.push(`mc.payment_type = 'financing'`) }
  }
  if (where.length) q += ` WHERE ` + where.join(' AND ')
  q += ` ORDER BY mc.created_at DESC`
  const { results } = await c.env.DB.prepare(q).bind(...binds).all()
  return c.json({ contracts: results })
})
app.get('/api/murabaha/:id', requireAuth, async (c) => {
  const id = c.req.param('id')
  const contract = await c.env.DB.prepare(
    `SELECT mc.*, p.name as product_name, p.unit, cu.full_name as customer_name, cu.national_id, cu.county
     FROM murabaha_contracts mc JOIN products p ON p.id=mc.product_id JOIN customers cu ON cu.id=mc.customer_id WHERE mc.id=?`
  ).bind(id).first()
  if (!contract) return c.json({ error: 'Not found' }, 404)
  const { results: repayments } = await c.env.DB.prepare(`SELECT * FROM repayments WHERE contract_id=? ORDER BY installment_no`).bind(id).all()
  const { results: txns } = await c.env.DB.prepare(`SELECT * FROM transactions WHERE contract_id=? ORDER BY id`).bind(id).all()
  return c.json({ contract, repayments, transactions: txns })
})
app.post('/api/murabaha/:id/decision', requireAuth, requireRole('admin', 'super_admin', 'operations_finance'), async (c) => {
  const id = c.req.param('id')
  const { action, notes } = await c.req.json()
  const contract = await c.env.DB.prepare(`SELECT * FROM murabaha_contracts WHERE id=?`).bind(id).first<any>()
  if (!contract) return c.json({ error: 'Not found' }, 404)
  if (contract.status !== 'pending') return c.json({ error: 'Application is not pending' }, 400)
  await c.env.DB.prepare(`INSERT INTO approvals (contract_id,reviewer_id,action,notes) VALUES (?,?,?,?)`).bind(id, c.get('user').id, action, notes || '').run()
  if (action === 'approve') {
    await c.env.DB.prepare(`UPDATE murabaha_contracts SET status='active', ownership_recorded=1 WHERE id=?`).bind(id).run()
    await c.env.DB.prepare(`UPDATE products SET quantity = quantity - ? WHERE id=?`).bind(contract.quantity, contract.product_id).run()
    await c.env.DB.prepare(`INSERT INTO stock_movements (product_id,movement_type,quantity,reference) VALUES (?,?,?,?)`).bind(contract.product_id, contract.financing_model === 'paygo' ? 'paygo_allocation' : 'credit_allocation', contract.quantity, contract.contract_ref).run()
    await c.env.DB.prepare(`INSERT INTO invoices (invoice_ref,contract_id,customer_id,amount,status) VALUES (?,?,?,?, 'unpaid')`).bind(ref('INV'), id, contract.customer_id, contract.murabaha_price).run()
    const term = Number(contract.term_months) || 0
    const installment = Number(contract.installment_amount || contract.monthly_payment || 0)
    const frequency = contract.payment_frequency || 'monthly'
    const count = frequency === 'daily' ? term * 30 : frequency === 'weekly' ? term * 4 : term
    const start = new Date()
    for (let i = 1; i <= count; i++) {
      const due = new Date(start)
      if (frequency === 'weekly') due.setDate(due.getDate() + i * 7)
      else if (frequency === 'daily') due.setDate(due.getDate() + i)
      else due.setMonth(due.getMonth() + i)
      const amount = i === count ? roundMoney(Number(contract.outstanding) - installment * (count - 1)) : installment
      await c.env.DB.prepare(`INSERT INTO repayments (contract_id,installment_no,due_date,amount_due,status) VALUES (?,?,?,?, 'current')`)
        .bind(id, i, due.toISOString().slice(0, 10), amount > 0 ? amount : installment).run()
    }
  } else if (action === 'reject') {
    await c.env.DB.prepare(`UPDATE murabaha_contracts SET status='rejected' WHERE id=?`).bind(id).run()
  }
  await audit(c, c.get('user').id, action, 'financing', contract.contract_ref)
  return c.json({ ok: true, action })
})
app.post('/api/murabaha/:id/dispatch', requireAuth, requireRole('admin', 'super_admin', 'operations_finance'), async (c) => {
  const id = c.req.param('id')
  const contract = await c.env.DB.prepare(`SELECT * FROM murabaha_contracts WHERE id=?`).bind(id).first<any>()
  if (!contract) return c.json({ error: 'Not found' }, 404)
  if (!['active', 'completed', 'awaiting_cash_balance'].includes(contract.status)) return c.json({ error: 'Only approved or paid purchases can be dispatched' }, 400)
  await c.env.DB.prepare(`UPDATE murabaha_contracts SET dispatch_status='dispatched', dispatched_at=CURRENT_TIMESTAMP, dispatched_by=? WHERE id=?`).bind(c.get('user').id, id).run()
  await audit(c, c.get('user').id, 'dispatch', 'contract', contract.contract_ref)
  return c.json({ ok: true })
})

// ----------------------------------------------------------------------------
// PAYMENTS - M-Pesa Daraja STK Push (real when configured, simulated otherwise)
// ----------------------------------------------------------------------------
async function applyPayment(c: any, contract: any, amt: number, receipt: string, method: string, phone: string) {
  const isCash = contract.payment_type === 'cash'
  const currentPaid = numberVal(contract.amount_paid, 0)
  const totalDue = numberVal(contract.murabaha_price, 0)
  const newPaid = roundMoney(currentPaid + amt)
  const newOutstanding = roundMoney(Math.max(0, totalDue - newPaid))
  const firstCashCollection = isCash && !contract.ownership_recorded
  if (firstCashCollection) {
    await c.env.DB.prepare(`UPDATE products SET quantity = quantity - ? WHERE id=?`).bind(contract.quantity, contract.product_id).run()
    await c.env.DB.prepare(`INSERT INTO stock_movements (product_id,movement_type,quantity,reference) VALUES (?,?,?,?)`).bind(contract.product_id, 'sale', contract.quantity, contract.contract_ref).run()
    await c.env.DB.prepare(`INSERT INTO invoices (invoice_ref,contract_id,customer_id,amount,status) VALUES (?,?,?,?, ?)`).bind(ref('INV'), contract.id, contract.customer_id, totalDue, newOutstanding <= 0 ? 'paid' : 'partial').run()
  }
  await c.env.DB.prepare(`INSERT INTO transactions (txn_ref,contract_id,customer_id,amount,method,type,mpesa_receipt,phone,status) VALUES (?,?,?,?,?,?,?,?, 'success')`)
    .bind(ref('TXN'), contract.id, contract.customer_id, amt, method, isCash ? 'cash_sale' : (contract.financing_model === 'paygo' ? 'paygo_repayment' : 'repayment'), receipt, phone).run()
  const status = isCash
    ? (newOutstanding <= 0 ? 'completed' : 'awaiting_cash_balance')
    : (newOutstanding <= 0 ? 'completed' : 'active')
  await c.env.DB.prepare(`UPDATE murabaha_contracts SET amount_paid=?, outstanding=?, status=?, ownership_recorded=1 WHERE id=?`).bind(newPaid, newOutstanding, status, contract.id).run()
  let remaining = amt
  const { results: due } = await c.env.DB.prepare(`SELECT * FROM repayments WHERE contract_id=? AND status!='completed' ORDER BY installment_no`).bind(contract.id).all<any>()
  for (const inst of due) {
    if (remaining <= 0) break
    const need = numberVal(inst.amount_due) - numberVal(inst.amount_paid)
    const pay = Math.min(need, remaining)
    const paidTotal = roundMoney(numberVal(inst.amount_paid) + pay)
    const st = paidTotal >= numberVal(inst.amount_due) ? 'completed' : 'current'
    await c.env.DB.prepare(`UPDATE repayments SET amount_paid=?, status=?, paid_at=CURRENT_TIMESTAMP WHERE id=?`).bind(paidTotal, st, inst.id).run()
    remaining = roundMoney(remaining - pay)
  }
  await c.env.DB.prepare(`UPDATE invoices SET status=? WHERE contract_id=?`).bind(newOutstanding <= 0 ? 'paid' : 'partial', contract.id).run()
  return { amount_paid: newPaid, outstanding: newOutstanding, status }
}
app.post('/api/mpesa/stkpush', requireAuth, async (c) => {
  const { contract_id, amount, phone } = await c.req.json()
  const contract = await c.env.DB.prepare(`SELECT * FROM murabaha_contracts WHERE id=?`).bind(contract_id).first<any>()
  if (!contract) return c.json({ error: 'Contract not found' }, 404)
  if (contract.payment_type === 'cash' && ['pending_payment', 'awaiting_cash_balance', 'completed'].includes(contract.status)) {
    const p = await c.env.DB.prepare(`SELECT quantity FROM products WHERE id=?`).bind(contract.product_id).first<any>()
    if ((!contract.ownership_recorded) && (!p || p.quantity < contract.quantity)) return c.json({ error: 'This item is now out of stock.' }, 409)
  } else if (contract.payment_type !== 'cash' && !['active', 'completed'].includes(contract.status)) {
    return c.json({ error: 'This purchase is not open for payment.' }, 400)
  }
  const amt = Number(amount)
  if (amt <= 0) return c.json({ error: 'Invalid amount' }, 400)
  if (amt > Number(contract.outstanding || 0)) return c.json({ error: 'Amount exceeds outstanding balance' }, 400)
  const desc = contract.payment_type === 'cash' ? 'Cash Equipment Purchase' : (contract.financing_model === 'paygo' ? 'PAYGO Equipment Payment' : 'Equipment Financing Payment')
  const result = await stkPush(c.env, { phone: phone || c.get('user').phone, amount: amt, account: contract.contract_ref, description: desc })
  if (!result.success) return c.json({ error: result.error || 'STK push failed' }, 502)
  await c.env.DB.prepare(`INSERT INTO payment_intents (checkout_request_id,merchant_request_id,contract_id,customer_id,amount,phone,method,status) VALUES (?,?,?,?,?,?,?, 'pending')`)
    .bind(result.checkout_request_id, result.merchant_request_id, contract_id, contract.customer_id, amt, normalizePhone(phone || c.get('user').phone), 'mpesa').run()
  await audit(c, c.get('user').id, 'stk_push', 'mpesa', `KES ${amt} to ${contract.contract_ref} (${result.simulated ? 'sim' : 'live'})`)
  return c.json({ ok: true, simulated: result.simulated, checkout_request_id: result.checkout_request_id, customer_message: result.customer_message })
})
app.post('/api/mpesa/confirm', requireAuth, async (c) => {
  const { checkout_request_id } = await c.req.json()
  const intent = await c.env.DB.prepare(`SELECT * FROM payment_intents WHERE checkout_request_id=?`).bind(checkout_request_id).first<any>()
  if (!intent) return c.json({ error: 'Payment intent not found' }, 404)
  if (intent.status === 'success') return c.json({ ok: true, status: 'success', mpesa_receipt: intent.mpesa_receipt })
  let success = false, receipt = ''
  if (!mpesaConfigured(c.env) || String(checkout_request_id).includes('SIM')) {
    success = true; receipt = 'SLE' + Math.random().toString(36).slice(2, 9).toUpperCase()
  } else {
    const q = await stkQuery(c.env, checkout_request_id)
    if (q.ResultCode === '0' || q.ResultCode === 0) { success = true; receipt = 'LIVE' + Date.now().toString().slice(-7) }
    else if (q.ResultCode) return c.json({ ok: false, status: 'failed', result_desc: q.ResultDesc || 'Payment not completed' })
    else return c.json({ ok: false, status: 'pending' })
  }
  if (success) {
    const contract = await c.env.DB.prepare(`SELECT * FROM murabaha_contracts WHERE id=?`).bind(intent.contract_id).first<any>()
    const res = await applyPayment(c, contract, intent.amount, receipt, 'mpesa', intent.phone)
    await c.env.DB.prepare(`UPDATE payment_intents SET status='success', mpesa_receipt=? WHERE checkout_request_id=?`).bind(receipt, checkout_request_id).run()
    return c.json({ ok: true, status: 'success', mpesa_receipt: receipt, ...res })
  }
  return c.json({ ok: false, status: 'pending' })
})
app.post('/api/mpesa/callback', async (c) => {
  try {
    const body: any = await c.req.json()
    const cb = body?.Body?.stkCallback
    if (!cb) return c.json({ ResultCode: 0, ResultDesc: 'Accepted' })
    const checkout = cb.CheckoutRequestID
    const intent = await c.env.DB.prepare(`SELECT * FROM payment_intents WHERE checkout_request_id=?`).bind(checkout).first<any>()
    if (intent && intent.status === 'pending') {
      if (cb.ResultCode === 0) {
        const items = cb.CallbackMetadata?.Item || []
        const receiptItem = items.find((i: any) => i.Name === 'MpesaReceiptNumber')
        const receipt = receiptItem?.Value || 'LIVE' + Date.now()
        const contract = await c.env.DB.prepare(`SELECT * FROM murabaha_contracts WHERE id=?`).bind(intent.contract_id).first<any>()
        if (contract) await applyPayment(c, contract, intent.amount, String(receipt), 'mpesa', intent.phone)
        await c.env.DB.prepare(`UPDATE payment_intents SET status='success', mpesa_receipt=?, result_desc=? WHERE checkout_request_id=?`).bind(String(receipt), cb.ResultDesc || '', checkout).run()
      } else {
        await c.env.DB.prepare(`UPDATE payment_intents SET status='failed', result_desc=? WHERE checkout_request_id=?`).bind(cb.ResultDesc || 'Failed', checkout).run()
      }
    }
    return c.json({ ResultCode: 0, ResultDesc: 'Accepted' })
  } catch (e) {
    return c.json({ ResultCode: 0, ResultDesc: 'Accepted' })
  }
})
app.get('/api/mpesa/status', requireAuth, (c) => {
  return c.json({ live: mpesaConfigured(c.env), mode: mpesaConfigured(c.env) ? (c.env.MPESA_ENV || 'sandbox') : 'simulation' })
})

// ----------------------------------------------------------------------------
// PAYMENTS - SasaPay STK Push (real when configured, simulated otherwise)
// Docs: https://developer.sasapay.app/docs/getting-started
// ----------------------------------------------------------------------------
app.post('/api/sasapay/stkpush', requireAuth, async (c) => {
  const { 
    contract_id, 
    amount, 
    phone,
    // Add C2B routing fields for channel elasticity
    channel,           // 'MOBILE_MONEY' or 'BANK'
    channel_code,      // Network code (e.g. '639021') or Bank Code (e.g. '01000')
    account_number     // Customer's destination Bank Account number if channel === 'BANK'
  } = await c.req.json()

  const contract = await c.env.DB.prepare(`SELECT * FROM murabaha_contracts WHERE id=?`).bind(contract_id).first<any>()
  if (!contract) return c.json({ error: 'Contract not found' }, 404)
  
  if (contract.payment_type === 'cash' && ['pending_payment', 'awaiting_cash_balance', 'completed'].includes(contract.status)) {
    const p = await c.env.DB.prepare(`SELECT quantity FROM products WHERE id=?`).bind(contract.product_id).first<any>()
    if ((!contract.ownership_recorded) && (!p || p.quantity < contract.quantity)) return c.json({ error: 'This item is now out of stock.' }, 409)
  } else if (contract.payment_type !== 'cash' && !['active', 'completed'].includes(contract.status)) {
    return c.json({ error: 'This purchase is not open for payment.' }, 400)
  }

  const amt = Number(amount)
  if (amt <= 0) return c.json({ error: 'Invalid amount' }, 400)
  if (amt > Number(contract.outstanding || 0)) return c.json({ error: 'Amount exceeds outstanding balance' }, 400)

  // Enforce mandatory bank credentials if the user explicitly switches the flow to Bank Transfer
  const selectedChannel = channel === 'BANK' ? 'BANK' : 'MOBILE_MONEY'
  if (selectedChannel === 'BANK' && (!account_number || !channel_code)) {
    return c.json({ error: 'Bank Code (channel_code) and Bank Account number are required for Bank payments.' }, 400)
  }

  const desc = contract.payment_type === 'cash' ? 'Cash Equipment Purchase' : 'Equipment Financing Payment'
  
  // Forward parameters elegantly inside the options structure
  const result = await sasapayStkPush(c.env, { 
    phone: phone || c.get('user').phone, 
    amount: amt, 
    account: contract.contract_ref, 
    description: desc,
    channel: selectedChannel,
    channelCode: channel_code || '639032', // Falls back safely to default Safaricom C2B token if empty
    accountNumber: account_number || ''
  })

  if (!result.success) return c.json({ error: result.error || 'SasaPay transaction initialization failed' }, 502)

  await c.env.DB.prepare(
    `INSERT INTO payment_intents (checkout_request_id, merchant_request_id, contract_id, customer_id, amount, phone, method, status) 
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`
  ).bind(
    result.checkout_request_id, 
    result.merchant_request_id, 
    contract_id, 
    contract.customer_id, 
    amt, 
    normalizePhone(phone || c.get('user').phone), 
    `sasapay_${selectedChannel.toLowerCase()}` // Appending type signature simplifies trace visibility down the line
  ).run()

  await audit(c, c.get('user').id, 'stk_push', 'sasapay', `KES ${amt} via ${selectedChannel} to ${contract.contract_ref} (${result.simulated ? 'sim' : 'live'})`)
  
  return c.json({ 
    ok: true, 
    simulated: result.simulated, 
    checkout_request_id: result.checkout_request_id, 
    customer_message: result.customer_message || (selectedChannel === 'BANK' ? 'Bank push payment initiated successfully.' : 'STK Push sent.')
  })
})

app.post('/api/sasapay/confirm', requireAuth, async (c) => {
  const { checkout_request_id } = await c.req.json()
  const intent = await c.env.DB.prepare(`SELECT * FROM payment_intents WHERE checkout_request_id=?`).bind(checkout_request_id).first<any>()
  if (!intent) return c.json({ error: 'Payment intent not found' }, 404)
  if (intent.status === 'success') return c.json({ ok: true, status: 'success', mpesa_receipt: intent.mpesa_receipt })
  
  let success = false, receipt = ''
  if (!sasapayConfigured(c.env) || String(checkout_request_id).includes('SIM')) {
    success = true; receipt = 'SP' + Math.random().toString(36).slice(2, 9).toUpperCase()
  } else {
    const q = await sasapayQuery(c.env, checkout_request_id)
    if (q?.pending === true) return c.json({ ok: false, status: 'pending' })
    
    const code = q.ResultCode ?? q.status_code
    if (code === '0' || code === 0 || q.status === true) { 
      success = true; receipt = 'SPL' + Date.now().toString().slice(-7) 
    } else if (code !== undefined && code !== null && code !== '' && code !== 'ERR') {
      const rawDesc = String(q.ResultDesc || q.message || 'Payment not completed')
      const safeDesc = /</.test(rawDesc) ? 'Payment not completed' : rawDesc
      return c.json({ ok: false, status: 'failed', result_desc: safeDesc })
    } else return c.json({ ok: false, status: 'pending' })
  }

  if (success) {
    const contract = await c.env.DB.prepare(`SELECT * FROM murabaha_contracts WHERE id=?`).bind(intent.contract_id).first<any>()
    const res = await applyPayment(c, contract, intent.amount, receipt, 'sasapay', intent.phone)
    await c.env.DB.prepare(`UPDATE payment_intents SET status='success', mpesa_receipt=? WHERE checkout_request_id=?`).bind(receipt, checkout_request_id).run()
    return c.json({ ok: true, status: 'success', mpesa_receipt: receipt, ...res })
  }
  return c.json({ ok: false, status: 'pending' })
})

app.post('/api/sasapay/callback', async (c) => {
  try {
    const body: any = await c.req.json()
    const checkout = body?.CheckoutRequestID || body?.MerchantRequestID
    if (!checkout) return c.json({ ResultCode: 0, ResultDesc: 'Accepted' })
    
    const intent = await c.env.DB.prepare(`SELECT * FROM payment_intents WHERE checkout_request_id=?`).bind(checkout).first<any>()
    if (intent && intent.status === 'pending') {
      const code = body.ResultCode ?? body.status_code
      if (code === 0 || code === '0' || body.status === true) {
        const receipt = body.TransactionID || body.MpesaReceiptNumber || 'SPL' + Date.now()
        const contract = await c.env.DB.prepare(`SELECT * FROM murabaha_contracts WHERE id=?`).bind(intent.contract_id).first<any>()
        if (contract) await applyPayment(c, contract, intent.amount, String(receipt), 'sasapay', intent.phone)
        await c.env.DB.prepare(`UPDATE payment_intents SET status='success', mpesa_receipt=?, result_desc=? WHERE checkout_request_id=?`).bind(String(receipt), body.ResultDesc || '', checkout).run()
      } else {
        await c.env.DB.prepare(`UPDATE payment_intents SET status='failed', result_desc=? WHERE checkout_request_id=?`).bind(body.ResultDesc || body.message || 'Failed', checkout).run()
      }
    }
    return c.json({ ResultCode: 0, ResultDesc: 'Accepted' })
  } catch { return c.json({ ResultCode: 0, ResultDesc: 'Accepted' }) }
})

app.get('/api/sasapay/status', requireAuth, (c) => {
  return c.json({ live: sasapayConfigured(c.env), mode: sasapayConfigured(c.env) ? (c.env.SASAPAY_ENV || 'sandbox') : 'simulation' })
})
// ----------------------------------------------------------------------------
// PAYMENTS - KCB Buni STK Push (real when configured, simulated otherwise)
// Docs: https://buni.kcbgroup.com/getting-started
// ----------------------------------------------------------------------------
app.post('/api/buni/stkpush', requireAuth, async (c) => {
  const { contract_id, amount, phone } = await c.req.json()
  const contract = await c.env.DB.prepare(`SELECT * FROM murabaha_contracts WHERE id=?`).bind(contract_id).first<any>()
  if (!contract) return c.json({ error: 'Contract not found' }, 404)
  if (contract.payment_type === 'cash' && ['pending_payment', 'awaiting_cash_balance', 'completed'].includes(contract.status)) {
    const p = await c.env.DB.prepare(`SELECT quantity FROM products WHERE id=?`).bind(contract.product_id).first<any>()
    if ((!contract.ownership_recorded) && (!p || p.quantity < contract.quantity)) return c.json({ error: 'This item is now out of stock.' }, 409)
  } else if (contract.payment_type !== 'cash' && !['active', 'completed'].includes(contract.status)) {
    return c.json({ error: 'This purchase is not open for payment.' }, 400)
  }
  const amt = Number(amount)
  if (amt <= 0) return c.json({ error: 'Invalid amount' }, 400)
  if (amt > Number(contract.outstanding || 0)) return c.json({ error: 'Amount exceeds outstanding balance' }, 400)
  const desc = contract.payment_type === 'cash' ? 'Cash Equipment Purchase' : 'Equipment Financing Payment'
  const result = await buniStkPush(c.env, { phone: phone || c.get('user').phone, amount: amt, account: contract.contract_ref, description: desc })
  if (!result.success) return c.json({ error: result.error || 'KCB Buni STK push failed' }, 502)
  await c.env.DB.prepare(`INSERT INTO payment_intents (checkout_request_id,merchant_request_id,contract_id,customer_id,amount,phone,method,status) VALUES (?,?,?,?,?,?,?, 'pending')`)
    .bind(result.checkout_request_id, result.merchant_request_id, contract_id, contract.customer_id, amt, normalizePhone(phone || c.get('user').phone), 'buni').run()
  await audit(c, c.get('user').id, 'stk_push', 'buni', `KES ${amt} to ${contract.contract_ref} (${result.simulated ? 'sim' : 'live'})`)
  return c.json({ ok: true, simulated: result.simulated, checkout_request_id: result.checkout_request_id, customer_message: result.customer_message })
})
app.post('/api/buni/confirm', requireAuth, async (c) => {
  const { checkout_request_id } = await c.req.json()
  const intent = await c.env.DB.prepare(`SELECT * FROM payment_intents WHERE checkout_request_id=?`).bind(checkout_request_id).first<any>()
  if (!intent) return c.json({ error: 'Payment intent not found' }, 404)
  if (intent.status === 'success') return c.json({ ok: true, status: 'success', mpesa_receipt: intent.mpesa_receipt })
  let success = false, receipt = ''
  if (!buniConfigured(c.env) || String(checkout_request_id).includes('SIM')) {
    success = true; receipt = 'BUNI' + Math.random().toString(36).slice(2, 9).toUpperCase()
  } else {
    const q = await buniQuery(c.env, checkout_request_id)
    const code = q.ResultCode ?? q.status_code
    if (code === '0' || code === 0 || q.status === true) { success = true; receipt = 'BUNI' + Date.now().toString().slice(-7) }
    else if (code) return c.json({ ok: false, status: 'failed', result_desc: q.ResultDesc || q.message || 'Payment not completed' })
    else return c.json({ ok: false, status: 'pending' })
  }
  if (success) {
    const contract = await c.env.DB.prepare(`SELECT * FROM murabaha_contracts WHERE id=?`).bind(intent.contract_id).first<any>()
    const res = await applyPayment(c, contract, intent.amount, receipt, 'buni', intent.phone)
    await c.env.DB.prepare(`UPDATE payment_intents SET status='success', mpesa_receipt=? WHERE checkout_request_id=?`).bind(receipt, checkout_request_id).run()
    return c.json({ ok: true, status: 'success', mpesa_receipt: receipt, ...res })
  }
  return c.json({ ok: false, status: 'pending' })
})
app.post('/api/buni/callback', async (c) => {
  try {
    const body: any = await c.req.json()
    const checkout = body?.CheckoutRequestID || body?.TransactionID
    if (!checkout) return c.json({ ResultCode: 0, ResultDesc: 'Accepted' })
    const intent = await c.env.DB.prepare(`SELECT * FROM payment_intents WHERE checkout_request_id=?`).bind(checkout).first<any>()
    if (intent && intent.status === 'pending') {
      const code = body.ResultCode ?? body.status_code
      if (code === 0 || code === '0' || body.status === true) {
        const receipt = body.TransactionID || body.ReceiptNumber || 'BUNI' + Date.now()
        const contract = await c.env.DB.prepare(`SELECT * FROM murabaha_contracts WHERE id=?`).bind(intent.contract_id).first<any>()
        if (contract) await applyPayment(c, contract, intent.amount, String(receipt), 'buni', intent.phone)
        await c.env.DB.prepare(`UPDATE payment_intents SET status='success', mpesa_receipt=?, result_desc=? WHERE checkout_request_id=?`).bind(String(receipt), body.ResultDesc || '', checkout).run()
      } else {
        await c.env.DB.prepare(`UPDATE payment_intents SET status='failed', result_desc=? WHERE checkout_request_id=?`).bind(body.ResultDesc || body.message || 'Failed', checkout).run()
      }
    }
    return c.json({ ResultCode: 0, ResultDesc: 'Accepted' })
  } catch { return c.json({ ResultCode: 0, ResultDesc: 'Accepted' }) }
})
app.get('/api/buni/status', requireAuth, (c) => {
  // Buni is hidden from the front-end user. The gateway routes remain
  // functional for server-to-server integrations, but the UI never exposes it.
  return c.json({ live: buniConfigured(c.env), mode: buniConfigured(c.env) ? (c.env.BUNI_ENV || 'sandbox') : 'simulation', hidden: true })
})

// ----------------------------------------------------------------------------
// CENTRAL PAYMENT GATEWAY (shared by equipment / feed / input marketplaces)
// Public endpoint URL:  https://equipment.farmsky.africa/api/v1/payments/*
// ----------------------------------------------------------------------------
app.route('/api/v1/payments', paymentGateway)

// Admin-only view of cross-app payment activity
app.get('/api/v1/payments-admin/summary', requireAuth, requireRole('admin', 'super_admin'), async (c) => {
  const res = await fetch(new URL('/api/v1/payments/admin/summary', c.req.url).toString())
  return c.json(await res.json())
})

// ----------------------------------------------------------------------------
// DASHBOARD / ANALYTICS
// ----------------------------------------------------------------------------
app.get('/api/dashboard', requireAuth, async (c) => {
  const user = c.get('user'), db = c.env.DB
  if (user.role === 'customer') {
    const myCust = await db.prepare(`SELECT id FROM customers WHERE user_id=?`).bind(user.id).first<any>()
    const cid = myCust?.id || -1
    const contracts = await db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(outstanding),0) out FROM murabaha_contracts WHERE customer_id=? AND status='active'`).bind(cid).first<any>()
    const completed = await db.prepare(`SELECT COUNT(*)::int n FROM murabaha_contracts WHERE customer_id=? AND status='completed'`).bind(cid).first<any>()
    const nextDue = await db.prepare(`SELECT r.* FROM repayments r JOIN murabaha_contracts mc ON mc.id=r.contract_id WHERE mc.customer_id=? AND r.status!='completed' ORDER BY r.due_date LIMIT 1`).bind(cid).first<any>()
    return c.json({ role: 'customer', active_contracts: contracts?.n || 0, total_outstanding: contracts?.out || 0, completed_contracts: completed?.n || 0, next_payment: nextDue || null })
  }
  if (user.role === 'agent') {
    const cust = await db.prepare(`SELECT COUNT(*)::int n FROM customers WHERE agent_id=?`).bind(user.id).first<any>()
    const active = await db.prepare(`SELECT COUNT(*)::int n FROM murabaha_contracts WHERE agent_id=? AND status='active'`).bind(user.id).first<any>()
    const pending = await db.prepare(`SELECT COUNT(*)::int n FROM murabaha_contracts WHERE agent_id=? AND status='pending'`).bind(user.id).first<any>()
    const portfolio = await db.prepare(`SELECT COALESCE(SUM(murabaha_price),0) tot, COALESCE(SUM(outstanding),0) out FROM murabaha_contracts WHERE agent_id=?`).bind(user.id).first<any>()
    const late = await db.prepare(`SELECT COUNT(*)::int n FROM repayments r JOIN murabaha_contracts mc ON mc.id=r.contract_id WHERE mc.agent_id=? AND r.status='late'`).bind(user.id).first<any>()
    const creditOnly = await db.prepare(`SELECT COUNT(*)::int n FROM murabaha_contracts WHERE agent_id=? AND payment_type='financing'`).bind(user.id).first<any>()
    const par = portfolio?.tot ? Math.round((portfolio.out / portfolio.tot) * 100) : 0
    return c.json({ role: 'agent', customers_onboarded: cust?.n || 0, active_contracts: active?.n || 0, pending_approvals: pending?.n || 0, portfolio_value: portfolio?.tot || 0, portfolio_at_risk: par, late_installments: late?.n || 0, commission: Math.round((portfolio?.tot || 0) * 0.025), credit_purchases: creditOnly?.n || 0 })
  }
  const sales = await db.prepare(`SELECT COALESCE(SUM(amount),0) tot FROM transactions WHERE status='success'`).first<any>()
  const financed = await db.prepare(`SELECT COALESCE(SUM(murabaha_price),0) tot FROM murabaha_contracts WHERE payment_type='financing'`).first<any>()
  const cashSales = await db.prepare(`SELECT COALESCE(SUM(murabaha_price),0) tot FROM murabaha_contracts WHERE payment_type='cash'`).first<any>()
  const activeCust = await db.prepare(`SELECT COUNT(*)::int n FROM customers`).first<any>()
  const invValue = await db.prepare(`SELECT COALESCE(SUM(buying_price*quantity),0) tot FROM products`).first<any>()
  const totalRepay = await db.prepare(`SELECT COUNT(*)::int n FROM repayments`).first<any>()
  const completedRepay = await db.prepare(`SELECT COUNT(*)::int n FROM repayments WHERE status='completed'`).first<any>()
  const defaulted = await db.prepare(`SELECT COUNT(*)::int n FROM repayments WHERE status='defaulted'`).first<any>()
  const pending = await db.prepare(`SELECT COUNT(*)::int n FROM murabaha_contracts WHERE status='pending'`).first<any>()
  const repayRate = totalRepay?.n ? Math.round((completedRepay.n / totalRepay.n) * 100) : 0
  const defaultRate = totalRepay?.n ? Math.round((defaulted.n / totalRepay.n) * 100) : 0
  const { results: topProducts } = await db.prepare(`SELECT p.name, COUNT(mc.id) sales FROM murabaha_contracts mc JOIN products p ON p.id=mc.product_id GROUP BY p.id ORDER BY sales DESC LIMIT 5`).all()
  return c.json({ role: user.role === 'operations_finance' ? 'operations_finance' : 'admin', total_sales: sales?.tot || 0, equipment_financed: financed?.tot || 0, cash_sales: cashSales?.tot || 0, repayment_rate: repayRate, default_rate: defaultRate, inventory_value: invValue?.tot || 0, active_customers: activeCust?.n || 0, pending_approvals: pending?.n || 0, top_products: topProducts })
})

// ----------------------------------------------------------------------------
// AGENTS
// ----------------------------------------------------------------------------
app.get('/api/agents', requireAuth, requireRole('admin', 'super_admin'), async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.full_name, u.phone, u.email, u.region, u.label, u.permissions, u.status,
     (SELECT COUNT(*) FROM customers WHERE agent_id=u.id) customers,
     (SELECT COUNT(*) FROM murabaha_contracts WHERE agent_id=u.id AND status='active') active
     FROM users u WHERE u.role='agent'`
  ).all()
  const agentFallback = await loadRoleTemplate(c, 'agent')
  return c.json({ agents: results.map((a: any) => ({ ...a, permissions: parsePermissions(a.permissions, 'agent', agentFallback) })) })
})
app.post('/api/agents', requireAuth, requireRole('admin', 'super_admin'), async (c) => {
  const b = await c.req.json()
  const p = normalizePhone(b.phone || '')
  if (!b.full_name || !p) return c.json({ error: 'Name and phone are required' }, 400)
  const dup = await c.env.DB.prepare(`SELECT id FROM users WHERE phone=?`).bind(p).first()
  if (dup) return c.json({ error: 'A user with this phone already exists' }, 409)
  const provided = b.password && String(b.password).length >= 4
  const pwd = provided ? String(b.password) : genPassword()
  const perms = await permissionsForRole(c, 'agent', b.permissions || {})
  const r = await c.env.DB.prepare(`INSERT INTO users (full_name,phone,email,password,role,region,password_set,label,permissions) VALUES (?,?,?,?, 'agent', ?, ?, ?, ?)`).bind(b.full_name, p, b.email || null, pwd, b.region || null, provided, b.label || 'Agent', JSON.stringify(perms)).run()
  await c.env.DB.prepare(`INSERT INTO agents (user_id,region,permissions) VALUES (?,?,?)`).bind(r.meta.last_row_id, b.region || null, JSON.stringify(perms)).run()
  await audit(c, c.get('user').id, 'create', 'agent', b.full_name)
  return c.json({ id: r.meta.last_row_id, password: pwd, password_was_set_by_admin: provided })
})
app.post('/api/users/:id/reset-password', requireAuth, requireRole('admin', 'super_admin'), async (c) => {
  const id = c.req.param('id')
  const target = await c.env.DB.prepare(`SELECT id, full_name, role FROM users WHERE id=?`).bind(id).first<any>()
  if (!target) return c.json({ error: 'User not found' }, 404)
  if (target.role === 'super_admin' && Number(id) !== c.get('user').id) return c.json({ error: 'Cannot reset another Super Admin password' }, 400)
  const body = await c.req.json().catch(() => ({}))
  const provided = body?.password && String(body.password).length >= 4
  const pwd = provided ? String(body.password) : genPassword()
  await c.env.DB.prepare(`UPDATE users SET password=?, password_set=1 WHERE id=?`).bind(pwd, id).run()
  await c.env.DB.prepare(`DELETE FROM sessions WHERE user_id=?`).bind(id).run()
  await audit(c, c.get('user').id, 'reset_password', target.role, target.full_name)
  return c.json({ ok: true, new_password: pwd, user: target.full_name })
})
app.put('/api/agents/:id', requireAuth, requireRole('admin', 'super_admin'), async (c) => {
  const id = c.req.param('id')
  const b = await c.req.json()
  const perms = await permissionsForRole(c, 'agent', b.permissions || {})
  await c.env.DB.prepare(`UPDATE users SET full_name=?, phone=?, email=?, region=?, label=?, permissions=? WHERE id=? AND role='agent'`).bind(b.full_name, b.phone, b.email, b.region, b.label || 'Agent', JSON.stringify(perms), id).run()
  await c.env.DB.prepare(`UPDATE agents SET region=?, permissions=? WHERE user_id=?`).bind(b.region, JSON.stringify(perms), id).run()
  await audit(c, c.get('user').id, 'update', 'agent', b.full_name)
  return c.json({ ok: true })
})

// ----------------------------------------------------------------------------
// USER ACCOUNTS (admin) - create, edit, activate/deactivate, delete
// ----------------------------------------------------------------------------
app.get('/api/users', requireAuth, requireRole('admin', 'super_admin'), async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT id, full_name, phone, email, role, label, permissions, status, region, schedule_enabled, access_days, access_start, access_end, created_at FROM users ORDER BY id`).all()
  const usersWithPerms = [] as any[]
  for (const u of results as any[]) {
    const fallback = await loadRoleTemplate(c, u.role)
    usersWithPerms.push({ ...u, permissions: parsePermissions(u.permissions, u.role, fallback), access_days: safeJson(u.access_days, []) })
  }
  return c.json({ users: usersWithPerms })
})
app.post('/api/users', requireAuth, requireRole('admin', 'super_admin'), async (c) => {
  const b = await c.req.json()
  const p = normalizePhone(b.phone || '')
  if (!b.full_name || !p || !b.role) return c.json({ error: 'Name, phone and role are required' }, 400)
  const dup = await c.env.DB.prepare(`SELECT id FROM users WHERE phone=?`).bind(p).first<any>()
  if (dup) return c.json({ error: 'A user with this phone already exists' }, 409)
  const provided = b.password && String(b.password).length >= 4
  const pwd = provided ? String(b.password) : genPassword()
  const perms = await permissionsForRole(c, String(b.role), b.permissions || {})
  const templateRow = await c.env.DB.prepare(`SELECT label FROM role_templates WHERE role_key=?`).bind(String(b.role)).first<any>()
  const label = b.label || templateRow?.label || (String(b.role) === 'operations_finance' ? 'Operations & Finance' : String(b.role).replace(/_/g, ' '))
  const schedEnabled = boolInt(b.schedule_enabled, false) ? 1 : 0
  const schedDays = Array.isArray(b.access_days) ? JSON.stringify(b.access_days) : null
  const r = await c.env.DB.prepare(`INSERT INTO users (full_name, phone, email, password, role, label, permissions, status, region, password_set, schedule_enabled, access_days, access_start, access_end) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(b.full_name, p, b.email || null, pwd, b.role, label, JSON.stringify(perms), b.status || 'active', b.region || null, provided, schedEnabled, schedDays, b.access_start || null, b.access_end || null).run()
  if (b.role === 'agent') await c.env.DB.prepare(`INSERT INTO agents (user_id,region,permissions) VALUES (?,?,?)`).bind(r.meta.last_row_id, b.region || null, JSON.stringify(perms)).run()
  await audit(c, c.get('user').id, 'create', 'user', `${b.full_name} (${b.role})`)
  return c.json({ id: r.meta.last_row_id, password: pwd, password_was_set_by_admin: provided })
})
app.put('/api/users/:id', requireAuth, requireRole('admin', 'super_admin'), async (c) => {
  const id = c.req.param('id')
  const b = await c.req.json()
  const perms = await permissionsForRole(c, String(b.role), b.permissions || {})
  const schedEnabled = boolInt(b.schedule_enabled, false) ? 1 : 0
  const schedDays = Array.isArray(b.access_days) ? JSON.stringify(b.access_days) : null
  if (b.password) {
    await c.env.DB.prepare(`UPDATE users SET full_name=?, phone=?, email=?, role=?, label=?, permissions=?, region=?, schedule_enabled=?, access_days=?, access_start=?, access_end=?, password=? WHERE id=?`).bind(b.full_name, b.phone, b.email, b.role, b.label || null, JSON.stringify(perms), b.region, schedEnabled, schedDays, b.access_start || null, b.access_end || null, String(b.password), id).run()
  } else {
    await c.env.DB.prepare(`UPDATE users SET full_name=?, phone=?, email=?, role=?, label=?, permissions=?, region=?, schedule_enabled=?, access_days=?, access_start=?, access_end=? WHERE id=?`).bind(b.full_name, b.phone, b.email, b.role, b.label || null, JSON.stringify(perms), b.region, schedEnabled, schedDays, b.access_start || null, b.access_end || null, id).run()
  }
  if (b.role === 'agent') {
    const exists = await c.env.DB.prepare(`SELECT user_id FROM agents WHERE user_id=?`).bind(id).first<any>()
    if (exists) await c.env.DB.prepare(`UPDATE agents SET region=?, permissions=? WHERE user_id=?`).bind(b.region || null, JSON.stringify(perms), id).run()
    else await c.env.DB.prepare(`INSERT INTO agents (user_id,region,permissions) VALUES (?,?,?)`).bind(id, b.region || null, JSON.stringify(perms)).run()
  }
  await audit(c, c.get('user').id, 'update', 'user', b.full_name)
  return c.json({ ok: true })
})
app.put('/api/users/:id/status', requireAuth, requireRole('admin', 'super_admin'), async (c) => {
  const id = c.req.param('id')
  const { status } = await c.req.json()
  if (Number(id) === c.get('user').id) return c.json({ error: 'You cannot change your own status' }, 400)
  await c.env.DB.prepare(`UPDATE users SET status=? WHERE id=?`).bind(status, id).run()
  if (status === 'suspended') await c.env.DB.prepare(`DELETE FROM sessions WHERE user_id=?`).bind(id).run()
  await audit(c, c.get('user').id, status === 'active' ? 'activate' : 'deactivate', 'user', String(id))
  return c.json({ ok: true })
})
app.delete('/api/users/:id', requireAuth, requireRole('admin', 'super_admin'), async (c) => {
  const id = c.req.param('id')
  if (Number(id) === c.get('user').id) return c.json({ error: 'You cannot delete your own account' }, 400)
  const u = await c.env.DB.prepare(`SELECT role FROM users WHERE id=?`).bind(id).first<any>()
  if (u?.role === 'super_admin') return c.json({ error: 'Cannot delete a Super Admin account' }, 400)
  await c.env.DB.prepare(`DELETE FROM sessions WHERE user_id=?`).bind(id).run()
  await c.env.DB.prepare(`DELETE FROM agents WHERE user_id=?`).bind(id).run()
  await c.env.DB.prepare(`DELETE FROM users WHERE id=?`).bind(id).run()
  await audit(c, c.get('user').id, 'delete', 'user', String(id))
  return c.json({ ok: true })
})
// ----------------------------------------------------------------------------
// PERMISSION CATALOG & ROLE TEMPLATES (Super Admin)
// ----------------------------------------------------------------------------
app.get('/api/permissions', requireAuth, async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT permission_key, label, description, category FROM permission_catalog ORDER BY category, label`).all()
  const { results: roles } = await c.env.DB.prepare(`SELECT role_key, label, description, permissions, is_system, schedule_enabled, access_days, access_start, access_end FROM role_templates ORDER BY label`).all()
  return c.json({
    permissions: results,
    roles: (roles as any[]).map((r) => ({ ...r, permissions: safeJson(r.permissions, {}), access_days: safeJson(r.access_days, []) }))
  })
})
app.post('/api/permissions', requireAuth, requireRole('super_admin'), async (c) => {
  const b = await c.req.json()
  const key = String(b.permission_key || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_')
  if (!key || !b.label) return c.json({ error: 'Permission key and label are required' }, 400)
  await c.env.DB.prepare(`INSERT INTO permission_catalog (permission_key, label, description, category) VALUES (?,?,?,?)`)
    .bind(key, b.label, b.description || null, b.category || 'general').run()
  await audit(c, c.get('user').id, 'create', 'permission', key)
  return c.json({ ok: true, permission_key: key })
})
app.delete('/api/permissions/:key', requireAuth, requireRole('super_admin'), async (c) => {
  const key = c.req.param('key')
  await c.env.DB.prepare(`DELETE FROM permission_catalog WHERE permission_key=?`).bind(key).run()
  await audit(c, c.get('user').id, 'delete', 'permission', key)
  return c.json({ ok: true })
})
app.post('/api/role-templates', requireAuth, requireRole('super_admin'), async (c) => {
  const b = await c.req.json()
  const key = String(b.role_key || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_')
  if (!key || !b.label) return c.json({ error: 'Role key and label are required' }, 400)
  const perms = b.permissions && typeof b.permissions === 'object' ? b.permissions : {}
  const scheduleEnabled = boolInt(b.schedule_enabled, false) ? 1 : 0
  const accessDays = Array.isArray(b.access_days) ? JSON.stringify(b.access_days) : null
  const accessStart = b.access_start || null
  const accessEnd = b.access_end || null
  const existing = await c.env.DB.prepare(`SELECT id, is_system FROM role_templates WHERE role_key=?`).bind(key).first<any>()
  if (existing) {
    await c.env.DB.prepare(`UPDATE role_templates SET label=?, description=?, permissions=?, schedule_enabled=?, access_days=?, access_start=?, access_end=? WHERE role_key=?`)
      .bind(b.label, b.description || null, JSON.stringify(perms), scheduleEnabled, accessDays, accessStart, accessEnd, key).run()
  } else {
    await c.env.DB.prepare(`INSERT INTO role_templates (role_key, label, description, permissions, is_system, schedule_enabled, access_days, access_start, access_end) VALUES (?,?,?,?, 0, ?,?,?,?)`)
      .bind(key, b.label, b.description || null, JSON.stringify(perms), scheduleEnabled, accessDays, accessStart, accessEnd).run()
  }
  await audit(c, c.get('user').id, existing ? 'update' : 'create', 'role_template', key)
  return c.json({ ok: true, role_key: key })
})
app.delete('/api/role-templates/:key', requireAuth, requireRole('super_admin'), async (c) => {
  const key = c.req.param('key')
  const row = await c.env.DB.prepare(`SELECT is_system FROM role_templates WHERE role_key=?`).bind(key).first<any>()
  if (!row) return c.json({ error: 'Not found' }, 404)
  if (row.is_system) return c.json({ error: 'Built-in roles cannot be deleted' }, 400)
  const used = await c.env.DB.prepare(`SELECT COUNT(*)::int n FROM users WHERE role=?`).bind(key).first<any>()
  if (Number(used?.n || 0) > 0) return c.json({ error: 'Cannot delete: users are assigned to this role.' }, 400)
  await c.env.DB.prepare(`DELETE FROM role_templates WHERE role_key=?`).bind(key).run()
  await audit(c, c.get('user').id, 'delete', 'role_template', key)
  return c.json({ ok: true })
})

// ----------------------------------------------------------------------------
// FINANCING & MARKUP SETTINGS (processing fee + markup)
// ----------------------------------------------------------------------------
app.get('/api/settings/financing', requireAuth, async (c) => {
  const user = c.get('user') as SessionUser
  const processing_fee = normalizeProcessingFee(await getSetting(c, 'processing_fee', DEFAULT_PROCESSING_FEE))
  const financing_markup = await getSetting(c, 'financing_markup', { default_cash_markup_pct: 10, default_credit_markup_pct: 20 })
  return c.json({
    processing_fee,
    financing_markup,
    can_manage_processing_fees: hasPermission(user, 'manage_processing_fees'),
    can_manage_markup: hasPermission(user, 'manage_markup_pct')
  })
})
app.put('/api/settings/processing-fee', requireAuth, requirePermission('manage_processing_fees'), async (c) => {
  const b = await c.req.json()
  const cfg = normalizeProcessingFee(b)
  await setSetting(c, 'processing_fee', cfg)
  await audit(c, c.get('user').id, 'update', 'settings', `processing_fee:${cfg.mode}`)
  return c.json({ ok: true, processing_fee: cfg })
})
app.put('/api/settings/financing-markup', requireAuth, requirePermission('manage_markup_pct'), async (c) => {
  const b = await c.req.json()
  const cfg = {
    default_cash_markup_pct: numberVal(b.default_cash_markup_pct, 10),
    default_credit_markup_pct: numberVal(b.default_credit_markup_pct, 20)
  }
  await setSetting(c, 'financing_markup', cfg)
  await audit(c, c.get('user').id, 'update', 'settings', 'financing_markup')
  return c.json({ ok: true, financing_markup: cfg })
})

app.post('/api/change-requests', requireAuth, async (c) => {
  const user = c.get('user') as SessionUser
  if (!hasPermission(user, 'request_admin_action')) return c.json({ error: 'Forbidden' }, 403)
  const { entity_type, entity_id, requested_action, reason } = await c.req.json()
  await c.env.DB.prepare(`INSERT INTO change_requests (requester_id, entity_type, entity_id, requested_action, reason) VALUES (?,?,?,?,?)`).bind(user.id, entity_type, entity_id || null, requested_action, reason || '').run()
  await audit(c, user.id, 'request_admin_action', entity_type || 'entity', `${requested_action || 'request'} ${entity_id || ''}`)
  return c.json({ ok: true })
})

// Repayment performance
app.get('/api/repayments', requireAuth, requireRole('admin', 'super_admin', 'support', 'operations_finance'), async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT r.*, mc.contract_ref, cu.full_name customer FROM repayments r
     JOIN murabaha_contracts mc ON mc.id=r.contract_id JOIN customers cu ON cu.id=mc.customer_id ORDER BY r.due_date`
  ).all()
  return c.json({ repayments: results })
})
// Documents
app.get('/api/documents/:type/:id', requireAuth, async (c) => {
  const type = c.req.param('type'), id = c.req.param('id')
  const contract = await c.env.DB.prepare(
    `SELECT mc.*, p.name product_name, cu.full_name customer_name, cu.national_id, cu.county
     FROM murabaha_contracts mc JOIN products p ON p.id=mc.product_id JOIN customers cu ON cu.id=mc.customer_id WHERE mc.id=?`
  ).bind(id).first()
  if (!contract) return c.json({ error: 'Not found' }, 404)
  return c.json({ type, contract, txn_id: contract.contract_ref, qr: `https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=${contract.contract_ref}` })
})

// ----------------------------------------------------------------------------
// ADMIN DATA EXPORT  (filter + download CSV/Excel locally, or email a copy)
// ----------------------------------------------------------------------------
// Supported datasets and their base queries. Filters are applied safely.
const EXPORT_DATASETS: Record<string, { label: string; sql: string; cols: string[]; filterable: Record<string, string> }> = {
  users: {
    label: 'Users / Accounts',
    sql: `SELECT id, full_name, phone, email, role, label, status, region, created_at FROM users`,
    cols: ['id', 'full_name', 'phone', 'email', 'role', 'label', 'status', 'region', 'created_at'],
    filterable: { role: 'role', status: 'status', region: 'region' }
  },
  customers: {
    label: 'Customers / Farmers',
    sql: `SELECT cu.id, cu.full_name, cu.mobile, cu.county, cu.value_chain, cu.kyc_status, cu.risk_band, cu.credit_score, u.full_name agent FROM customers cu LEFT JOIN users u ON u.id=cu.agent_id`,
    cols: ['id', 'full_name', 'mobile', 'county', 'value_chain', 'kyc_status', 'risk_band', 'credit_score', 'agent'],
    filterable: { kyc_status: 'cu.kyc_status', risk_band: 'cu.risk_band', county: 'cu.county' }
  },
  agents: {
    label: 'Agents',
    sql: `SELECT id, full_name, phone, email, region, status, created_at FROM users WHERE role='agent'`,
    cols: ['id', 'full_name', 'phone', 'email', 'region', 'status', 'created_at'],
    filterable: { status: 'status', region: 'region' }
  },
  products: {
    label: 'Inventory / Products',
    sql: `SELECT id, sku, name, category, product_type, payment_option_mode, financing_model, financing_interest_pct, cash_deposit_pct, financing_deposit_pct, buying_price, cash_price, credit_price, quantity, unit, reorder_threshold FROM products`,
    cols: ['id', 'sku', 'name', 'category', 'product_type', 'payment_option_mode', 'financing_model', 'financing_interest_pct', 'cash_deposit_pct', 'financing_deposit_pct', 'buying_price', 'cash_price', 'credit_price', 'quantity', 'unit', 'reorder_threshold'],
    filterable: { category: 'category' }
  },
  contracts: {
    label: 'Murabaha Contracts',
    sql: `SELECT mc.id, mc.contract_ref, cu.full_name customer, p.name product, mc.payment_type, mc.financing_model, mc.deposit_pct, mc.deposit_amount, mc.payment_frequency, mc.installment_amount, mc.murabaha_price, mc.amount_paid, mc.outstanding, mc.status, mc.dispatch_status, mc.created_at FROM murabaha_contracts mc JOIN customers cu ON cu.id=mc.customer_id JOIN products p ON p.id=mc.product_id`,
    cols: ['id', 'contract_ref', 'customer', 'product', 'payment_type', 'financing_model', 'deposit_pct', 'deposit_amount', 'payment_frequency', 'installment_amount', 'murabaha_price', 'amount_paid', 'outstanding', 'status', 'dispatch_status', 'created_at'],
    filterable: { status: 'mc.status', payment_type: 'mc.payment_type' }
  },
  repayments: {
    label: 'Repayments',
    sql: `SELECT r.id, mc.contract_ref, cu.full_name customer, r.installment_no, r.due_date, r.amount_due, r.amount_paid, r.status FROM repayments r JOIN murabaha_contracts mc ON mc.id=r.contract_id JOIN customers cu ON cu.id=mc.customer_id`,
    cols: ['id', 'contract_ref', 'customer', 'installment_no', 'due_date', 'amount_due', 'amount_paid', 'status'],
    filterable: { status: 'r.status' }
  },
  transactions: {
    label: 'Transactions / Payments',
    sql: `SELECT t.id, t.txn_ref, cu.full_name customer, t.amount, t.method, t.type, t.mpesa_receipt, t.status, t.created_at FROM transactions t LEFT JOIN customers cu ON cu.id=t.customer_id`,
    cols: ['id', 'txn_ref', 'customer', 'amount', 'method', 'type', 'mpesa_receipt', 'status', 'created_at'],
    filterable: { status: 't.status', method: 't.method', type: 't.type' }
  },
  audit_logs: {
    label: 'Audit Log',
    sql: `SELECT a.id, u.full_name actor, a.action, a.entity, a.detail, a.created_at FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id`,
    cols: ['id', 'actor', 'action', 'entity', 'detail', 'created_at'],
    filterable: { action: 'a.action', entity: 'a.entity' }
  }
}

async function buildExport(c: any, dataset: string, filters: Record<string, string>, dateFrom?: string, dateTo?: string) {
  const def = EXPORT_DATASETS[dataset]
  if (!def) throw new Error('Unknown dataset')
  const where: string[] = []
  const binds: any[] = []
  const hasWhere = /\bwhere\b/i.test(def.sql)
  for (const [key, col] of Object.entries(def.filterable)) {
    const v = filters?.[key]
    if (v != null && String(v).trim() !== '' && String(v) !== 'all') {
      where.push(`${col} = ?`); binds.push(v)
    }
  }
  // Date range on created_at / due_date if present
  const dateCol = def.cols.includes('created_at') ? 'created_at' : (def.cols.includes('due_date') ? 'due_date' : null)
  if (dateCol && dateFrom) { where.push(`${dateCol} >= ?`); binds.push(dateFrom) }
  if (dateCol && dateTo) { where.push(`${dateCol} <= ?`); binds.push(dateTo + ' 23:59:59') }
  let sql = def.sql
  if (where.length) sql += (hasWhere ? ' AND ' : ' WHERE ') + where.join(' AND ')
  sql += ` ORDER BY 1 DESC`
  const stmt = binds.length ? c.env.DB.prepare(sql).bind(...binds) : c.env.DB.prepare(sql)
  const { results } = await stmt.all()
  return { label: def.label, cols: def.cols, rows: results || [] }
}

// base64 of a UTF-8 string, works in both Node and Workers runtimes.
function base64Utf8(s: string): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(s, 'utf8').toString('base64')
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  // @ts-ignore btoa exists in Workers
  return btoa(bin)
}
function toCsv(cols: string[], rows: any[]): string {
  const esc = (v: any) => {
    const s = v == null ? '' : String(v)
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
  }
  const head = cols.map(esc).join(',')
  const body = rows.map((r) => cols.map((cKey) => esc(r[cKey])).join(',')).join('\n')
  return head + '\n' + body
}

// Metadata: list datasets + their filter options (distinct values).
app.get('/api/export/datasets', requireAuth, requireRole('admin', 'super_admin'), (c) => {
  const list = Object.entries(EXPORT_DATASETS).map(([key, d]) => ({ key, label: d.label, filters: Object.keys(d.filterable), cols: d.cols }))
  return c.json({ datasets: list, email_configured: emailConfigured(c.env) })
})
// Return filtered data as JSON (frontend turns it into CSV/XLSX for local download).
app.post('/api/export/data', requireAuth, requireRole('admin', 'super_admin'), async (c) => {
  const { dataset, filters, date_from, date_to } = await c.req.json()
  try {
    const out = await buildExport(c, dataset, filters || {}, date_from, date_to)
    await audit(c, c.get('user').id, 'export', dataset, `${out.rows.length} rows`)
    return c.json({ ok: true, ...out })
  } catch (e: any) {
    return c.json({ error: e.message || 'Export failed' }, 400)
  }
})
// Email a filtered export (CSV attachment) to a recipient.
app.post('/api/export/email', requireAuth, requireRole('admin', 'super_admin'), async (c) => {
  const { dataset, filters, date_from, date_to, to, format } = await c.req.json()
  if (!to || !/.+@.+\..+/.test(String(to))) return c.json({ error: 'Enter a valid recipient email' }, 400)
  if (!emailConfigured(c.env)) {
    return c.json({ error: 'email_not_configured', message: 'Email provider not configured. Use the Download button instead, or set EMAIL_API_URL/TOKEN/FROM at deploy.' }, 412)
  }
  try {
    const out = await buildExport(c, dataset, filters || {}, date_from, date_to)
    const csv = toCsv(out.cols, out.rows)
    const b64 = base64Utf8(csv)
    const fname = `farmsky-${dataset}-${new Date().toISOString().slice(0, 10)}.csv`
    const r = await sendEmail(c.env, {
      to,
      subject: `Farmsky export — ${out.label} (${out.rows.length} rows)`,
      text: `Attached is the ${out.label} export you requested from Farmsky (${out.rows.length} rows).`,
      attachments: [{ filename: fname, contentBase64: b64, contentType: 'text/csv' }]
    })
    if (!r.success) return c.json({ error: r.error || 'Email send failed' }, 502)
    await audit(c, c.get('user').id, 'export_email', dataset, `to ${to}`)
    return c.json({ ok: true, message: `Export emailed to ${to}` })
  } catch (e: any) {
    return c.json({ error: e.message || 'Export failed' }, 400)
  }
})

// ----------------------------------------------------------------------------
// FRONTEND SHELL
// ----------------------------------------------------------------------------
app.get('/', (c) => c.html(SHELL))

const SHELL = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Farmsky — Sharia-Compliant Agri-Finance</title>
  <link rel="icon" type="image/png" href="/static/favicon.png">
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js"></script>
  <link href="/static/style.css" rel="stylesheet">
</head>
<body class="bg-slate-100 text-slate-800">
  <div id="app"></div>
  <script src="/static/app.js"></script>
</body>
</html>`

export default app
