// =====================================================================
// KCB Buni Funds Transfer API integration
// =====================================================================

export type BuniEnv = {
  BUNI_CLIENT_ID?: string
  BUNI_CLIENT_SECRET?: string
  BUNI_API_KEY?: string
  BUNI_ENV?: string // 'production' or 'sandbox'
}

const SANDBOX_BASE = 'https://uat.buni.kcbgroup.com'
const PROD_BASE = 'https://api.buni.kcbgroup.com'

function baseUrl(env: BuniEnv): string {
  return env.BUNI_ENV === 'production' ? PROD_BASE : SANDBOX_BASE
}

// 1. Corrected Token Generation (Fixes 405 Method Not Allowed)
async function getToken(env: BuniEnv): Promise<string> {
  const auth = btoa(`${env.BUNI_CLIENT_ID}:${env.BUNI_CLIENT_SECRET}`)
  
  const res = await fetch(`${baseUrl(env)}/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  })

  if (!res.ok) {
    const error = await res.text()
    throw new Error(`KCB Buni Auth Failed (${res.status}): ${error}`)
  }
  
  const data: any = await res.json()
  return data.access_token
}

// 2. Funds Transfer Request (As per API Spec Document)
export async function buniFundsTransfer(
  env: BuniEnv,
  payload: {
    companyCode: string,
    transactionType: string,
    debitAccountNumber: string,
    creditAccountNumber: string,
    debitAmount: number,
    paymentDetails: string,
    transactionReference: string,
    beneficiaryDetails: string,
    beneficiaryBankCode: string
  }
) {
  const token = await getToken(env)
  
  const res = await fetch(`${baseUrl(env)}/api/v1/transfer`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'apikey': env.BUNI_API_KEY || ''
    },
    body: JSON.stringify({
      companyCode: payload.companyCode,
      transactionType: payload.transactionType,
      debitAccountNumber: payload.debitAccountNumber,
      creditAccountNumber: payload.creditAccountNumber,
      debitAmount: payload.debitAmount,
      currency: 'KES', // As per sample request
      paymentDetails: payload.paymentDetails,
      transactionReference: payload.transactionReference,
      beneficiaryDetails: payload.beneficiaryDetails,
      beneficiaryBankCode: payload.beneficiaryBankCode
    })
  })

  return await res.json()
}
