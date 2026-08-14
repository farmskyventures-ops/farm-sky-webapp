// =====================================================================
// Farmsky Score API client  (credit.farmsky.africa)
// ---------------------------------------------------------------------
// Equipment consumes the Score platform's verification + credit APIs so
// that ID verification, liveness checks, IPRS lookups and full credit
// evaluations are performed by Score (the identity/credit engine) rather
// than being simulated locally.
//
// Auth: Score's /v3/* endpoints are protected by an API client key +
// secret (Authorization: Bearer <client_id>:<secret>). When Score is run
// in HMAC-enforced mode, each request is additionally signed with
//   X-Timestamp, X-Nonce and X-Signature = HMAC_SHA256(
//     secret, `${ts}.${nonce}.${METHOD}.${path}.${sha256(body)}` )
// which is exactly the scheme Score's apiGuard expects.
//
// All calls degrade gracefully: if SCORE_API_URL / credentials are not
// configured the helpers return { live:false, ... } so the caller can
// fall back to its local (simulated) flow without throwing.
// =====================================================================

import type { Bindings } from './types'
import { sanitizeUrl } from './url-utils'

const encoder = new TextEncoder()

async function sha256Hex(message: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(message))
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}
async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message))
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function scoreConfigured(env: Bindings): boolean {
  return !!(env.SCORE_API_URL && env.SCORE_API_CLIENT && env.SCORE_API_SECRET)
}

function scoreBase(env: Bindings): string {
  // sanitizeUrl() guards against malformed env values (stray trailing
  // ")." / quotes / whitespace) so the outbound fetch target is always valid.
  return sanitizeUrl(env.SCORE_API_URL)
}

/**
 * Low-level authenticated call to a Score /v3 endpoint.
 * `path` must start with '/v3/...'. Returns the parsed JSON body plus the
 * HTTP status. Throws only on a network error.
 */
async function scoreFetch(
  env: Bindings,
  method: 'GET' | 'POST',
  path: string,
  body?: any
): Promise<{ status: number; ok: boolean; data: any }> {
  const clientId = String(env.SCORE_API_CLIENT || '')
  const secret = String(env.SCORE_API_SECRET || '')
  const bodyText = body === undefined ? '' : JSON.stringify(body)
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${clientId}:${secret}`,
    'X-Api-Client': clientId,
    'X-Api-Secret': secret,
    'Accept': 'application/json',
  }
  if (bodyText) headers['Content-Type'] = 'application/json'

  // HMAC request signing (Score enforces this when API_HMAC_ENFORCE=1).
  const ts = String(Date.now())
  const nonce = crypto.randomUUID()
  const bodyHash = await sha256Hex(bodyText)
  const signature = await hmacSha256Hex(secret, `${ts}.${nonce}.${method}.${path}.${bodyHash}`)
  headers['X-Timestamp'] = ts
  headers['X-Nonce'] = nonce
  headers['X-Signature'] = signature

  const res = await fetch(`${scoreBase(env)}${path}`, {
    method,
    headers,
    body: bodyText || undefined,
  })
  let data: any = null
  try { data = await res.json() } catch { data = null }
  return { status: res.status, ok: res.ok, data }
}

// ---------------------------------------------------------------------
// IPRS — government registry verification of a national ID.
// ---------------------------------------------------------------------
export async function scoreIprs(env: Bindings, national_id: string): Promise<{
  live: boolean; status?: string; registry_name?: string; pep_sanctions_hit?: boolean; request_id?: string; raw?: any; error?: string
}> {
  if (!scoreConfigured(env)) return { live: false }
  try {
    const r = await scoreFetch(env, 'POST', '/v3/iprs/verify', { national_id })
    if (!r.ok) return { live: false, error: r.data?.message || `Score IPRS ${r.status}` }
    return {
      live: true,
      status: r.data?.status,
      registry_name: r.data?.registry_name,
      pep_sanctions_hit: !!r.data?.pep_sanctions_hit,
      request_id: r.data?.request_id,
      raw: r.data,
    }
  } catch (e: any) { return { live: false, error: String(e?.message || e) } }
}

// ---------------------------------------------------------------------
// KYC — combined ID verification + biometric/liveness check.
// Score returns { verified, iprs, biometric } from /v3/kyc.
// ---------------------------------------------------------------------
export async function scoreKyc(env: Bindings, args: { national_id: string; t_approve?: number; t_reject?: number }): Promise<{
  live: boolean; verified?: boolean; face_match?: boolean; liveness_passed?: boolean; liveness_score?: number; request_id?: string; iprs?: any; raw?: any; error?: string
}> {
  if (!scoreConfigured(env)) return { live: false }
  try {
    const r = await scoreFetch(env, 'POST', '/v3/kyc', { national_id: args.national_id, t_approve: args.t_approve, t_reject: args.t_reject })
    if (!r.ok) return { live: false, error: r.data?.message || `Score KYC ${r.status}` }
    const bio = r.data?.biometric || {}
    const outcome = String(bio.outcome || '').toUpperCase()
    return {
      live: true,
      verified: !!r.data?.verified,
      face_match: outcome === 'APPROVE' || outcome === 'REVIEW' || bio.match === true,
      liveness_passed: outcome !== 'REJECT',
      liveness_score: typeof bio.score === 'number' ? bio.score : undefined,
      request_id: r.data?.request_id,
      iprs: r.data?.iprs,
      raw: r.data,
    }
  } catch (e: any) { return { live: false, error: String(e?.message || e) } }
}

// ---------------------------------------------------------------------
// Liveness / biometrics — standalone liveness check.
// ---------------------------------------------------------------------
export async function scoreLiveness(env: Bindings, reference: string): Promise<{
  live: boolean; outcome?: string; score?: number; liveness_passed?: boolean; request_id?: string; raw?: any; error?: string
}> {
  if (!scoreConfigured(env)) return { live: false }
  try {
    const r = await scoreFetch(env, 'POST', '/v3/biometrics/verify', { reference })
    if (!r.ok) return { live: false, error: r.data?.message || `Score liveness ${r.status}` }
    const outcome = String(r.data?.outcome || '').toUpperCase()
    return {
      live: true,
      outcome,
      score: typeof r.data?.score === 'number' ? r.data.score : undefined,
      liveness_passed: outcome !== 'REJECT',
      request_id: r.data?.request_id,
      raw: r.data,
    }
  } catch (e: any) { return { live: false, error: String(e?.message || e) } }
}

// ---------------------------------------------------------------------
// Wallets & Payouts real-time sync (Wallets & Payouts Module)
// ---------------------------------------------------------------------
// Equipment is the central host/ledger engine; Score owns the PRIMARY
// lender API wallets. These read-only helpers pull the LIVE wallet
// metadata + balances, per-wallet ledger + API/service consumption, and a
// normalized transaction stream straight from the Score service engine
// (GET /v3/equipment-sync/*), so the Equipment dashboard reflects Score
// wallets in real time rather than relying only on the push mirror.
//
// All degrade gracefully: when Score is not configured (or the sync route
// is unavailable) they return { live:false } / empty arrays so the
// dashboard falls back to the locally-mirrored score_wallet_ledger.
// ---------------------------------------------------------------------

/** All Score lender/API wallets with metadata + current balances. */
export async function scoreWallets(env: Bindings): Promise<{
  live: boolean; wallets: any[]; synced_at?: string; error?: string
}> {
  if (!scoreConfigured(env)) return { live: false, wallets: [] }
  try {
    const r = await scoreFetch(env, 'GET', '/v3/equipment-sync/wallets')
    if (!r.ok) return { live: false, wallets: [], error: r.data?.message || `Score wallets ${r.status}` }
    return { live: true, wallets: Array.isArray(r.data?.wallets) ? r.data.wallets : [], synced_at: r.data?.synced_at }
  } catch (e: any) { return { live: false, wallets: [], error: String(e?.message || e) } }
}

/** One Score wallet's drill-down: snapshot + ledger + API/service consumption. */
export async function scoreWalletDetail(env: Bindings, orgId: string, limit = 200): Promise<{
  live: boolean; wallet?: any; ledger?: any[]; consumption?: any; synced_at?: string; error?: string
}> {
  if (!scoreConfigured(env)) return { live: false }
  const id = encodeURIComponent(String(orgId || ''))
  try {
    const r = await scoreFetch(env, 'GET', `/v3/equipment-sync/wallets/${id}?limit=${Math.max(1, Math.min(500, limit))}`)
    if (!r.ok) return { live: false, error: r.data?.message || r.data?.error || `Score wallet ${r.status}` }
    return {
      live: true,
      wallet: r.data?.wallet || null,
      ledger: Array.isArray(r.data?.ledger) ? r.data.ledger : [],
      consumption: r.data?.consumption || { endpoints: [], service_fees: [] },
      synced_at: r.data?.synced_at,
    }
  } catch (e: any) { return { live: false, error: String(e?.message || e) } }
}

/** Normalized Score transaction stream for the Unified Payment Ledger. */
export async function scoreTransactions(env: Bindings, opts: { limit?: number; since?: string } = {}): Promise<{
  live: boolean; transactions: any[]; synced_at?: string; error?: string
}> {
  if (!scoreConfigured(env)) return { live: false, transactions: [] }
  const q: string[] = []
  if (opts.limit) q.push(`limit=${Math.max(1, Math.min(1000, opts.limit))}`)
  if (opts.since) q.push(`since=${encodeURIComponent(opts.since)}`)
  const qs = q.length ? `?${q.join('&')}` : ''
  try {
    const r = await scoreFetch(env, 'GET', `/v3/equipment-sync/transactions${qs}`)
    if (!r.ok) return { live: false, transactions: [], error: r.data?.message || `Score transactions ${r.status}` }
    return { live: true, transactions: Array.isArray(r.data?.transactions) ? r.data.transactions : [], synced_at: r.data?.synced_at }
  } catch (e: any) { return { live: false, transactions: [], error: String(e?.message || e) } }
}

// ---------------------------------------------------------------------
// Credit evaluation — full credit + financing decision from Score.
// ---------------------------------------------------------------------
export async function scoreCreditEvaluation(env: Bindings, payload: any): Promise<{
  live: boolean; composite_score?: number; risk_tier?: string; decision?: string; model_version?: string; lender_reference?: string; raw?: any; error?: string
}> {
  if (!scoreConfigured(env)) return { live: false }
  try {
    const r = await scoreFetch(env, 'POST', '/v3/credit/evaluations', payload)
    if (!r.ok) return { live: false, error: r.data?.message || r.data?.error || `Score credit ${r.status}` }
    return {
      live: true,
      composite_score: r.data?.composite_score,
      risk_tier: r.data?.risk_tier,
      decision: r.data?.decision,
      model_version: r.data?.model_version,
      lender_reference: r.data?.lender_reference,
      raw: r.data,
    }
  } catch (e: any) { return { live: false, error: String(e?.message || e) } }
}
