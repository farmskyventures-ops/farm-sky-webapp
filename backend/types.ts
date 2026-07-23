import type { MpesaEnv } from './mpesa'
import type { SmsEnv } from './sms'
import type { EmailEnv } from './email'
import type { SasaPayEnv } from './sasapay'
import type { BuniEnv } from './buni'

export type Bindings = MpesaEnv & SmsEnv & EmailEnv & SasaPayEnv & BuniEnv & {
  DB: any
  TRANSUNION_API_URL?: string
  TRANSUNION_API_KEY?: string
  TRANSUNION_CLIENT_ID?: string
  TRANSUNION_ENV?: string
  // Cross-platform (Equipment <-> Feed) configuration
  APP_TYPE?: string                 // 'equipment' | 'feed' — data-scope + payment-host context
  PUBLIC_BASE_URL?: string          // this app's public origin (hosted checkout URLs)
  CROSS_APP_URL?: string            // sibling app origin ('Shop Equipment'/'Shop Feeds' target)
  CROSS_APP_HMAC_SECRET?: string    // shared secret for cross-app SSO handoff tokens
  // score.farmsky.africa — SSO handoff target + API consumption
  SCORE_APP_URL?: string            // score.farmsky.africa origin (SSO "Open Score" button)
  SCORE_API_URL?: string            // score API base (e.g. https://score.farmsky.africa)
  SCORE_API_CLIENT?: string         // Score API client id issued to Equipment
  SCORE_API_SECRET?: string         // Score API secret (paired with the client id)
  // Phase 4 — standardized auth hashing (must match Feed values)
  AUTH_HASH_ITERATIONS?: string
  AUTH_HASH_KEYLEN?: string
  AUTH_PEPPER?: string
}

export type SessionUser = {
  id: number
  full_name: string
  phone: string
  email?: string | null
  avatar_url?: string | null
  role: string
  region?: string
  label?: string
  permissions?: Record<string, boolean>
}
