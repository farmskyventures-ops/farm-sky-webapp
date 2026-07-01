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

const { d1, raw } = await openDatabase(DATABASE_URL)
await initializeDatabase(raw, PROJECT_ROOT)
console.log(`PostgreSQL ready: ${DATABASE_URL.replace(/:[^:@/]+@/, ':***@')}`)

if (migrateOnly) {
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
  TRANSUNION_ENV: process.env.TRANSUNION_ENV
}

const root = new Hono()
root.use('/static/*', serveStatic({ root: './public' }))
root.all('*', (c) => app.fetch(c.req.raw, ENV as any))

const PORT = Number(process.env.PORT || 8080)
serve({ fetch: root.fetch, port: PORT }, (info) => {
  console.log(`Farmsky server running on http://0.0.0.0:${info.port}`)
  
  // Status check for M-Pesa
  console.log(
    process.env.MPESA_CONSUMER_KEY
      ? 'M-Pesa: LIVE credentials detected (' + (process.env.MPESA_ENV || 'sandbox') + ')'
      : 'M-Pesa: SIMULATION mode (no Daraja credentials set).'
  )

  // Status check for SasaPay
  const sasapayId = process.env.SASAPAY_CLIENT_ID || process.env.SASAPAY_CONSUMER_KEY
  const sasapaySecret = process.env.SASAPAY_CLIENT_SECRET || process.env.SASAPAY_CONSUMER_SECRET
  const sasapayMerchant = process.env.SASAPAY_MERCHANT_CODE
  console.log(
    (sasapayId && sasapaySecret && sasapayMerchant)
      ? 'SasaPay: LIVE credentials detected (' + (process.env.SASAPAY_ENV || 'sandbox') + ')'
      : `SasaPay: SIMULATION mode (missing ${[!sasapayId && 'CLIENT_ID', !sasapaySecret && 'CLIENT_SECRET', !sasapayMerchant && 'MERCHANT_CODE'].filter(Boolean).join(', ') || 'credentials'}).`
  )
})
