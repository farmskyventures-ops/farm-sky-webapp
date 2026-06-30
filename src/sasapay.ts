// Define your environment interface
export interface SasaPayEnv {
  SASAPAY_MERCHANT_CODE: string;
  SASAPAY_CONSUMER_KEY: string;
  SASAPAY_CONSUMER_SECRET: string;
  SASAPAY_CALLBACK_URL: string;
  SASAPAY_ENV?: 'sandbox' | 'production';
}

export type SasaPayResult = {
  simulated: boolean;
  success: boolean;
  checkout_request_id?: string;
  merchant_request_id?: string;
  customer_message?: string;
  error?: string;
};

export type SasaPayStkOpts = {
  phone: string;
  amount: number;
  account: string;
  description: string;
  networkCode?: string; // M-PESA: "63902", Airtel: "63903", T-Kash: "63907"
};

// Internal helpers
function baseUrl(env: SasaPayEnv) {
  return env.SASAPAY_ENV === 'production' 
    ? 'https://api.sasapay.app' 
    : 'https://sandbox.sasapay.app';
}

export function sasapayConfigured(env: SasaPayEnv): boolean {
  return !!(env.SASAPAY_MERCHANT_CODE && env.SASAPAY_CONSUMER_KEY && env.SASAPAY_CONSUMER_SECRET);
}

// Mocked Token Helper - Ensure this implementation matches your existing auth flow
async function getToken(env: SasaPayEnv): Promise<string> {
  // Replace with your actual OAuth/Token retrieval logic
  return "YOUR_ACCESS_TOKEN"; 
}

export async function sasapayStkPush(
  env: SasaPayEnv,
  opts: SasaPayStkOpts
): Promise<SasaPayResult> {
  if (!sasapayConfigured(env)) {
    return {
      simulated: true,
      success: true,
      checkout_request_id: 'SP_SIM_' + crypto.randomUUID().slice(0, 12),
      merchant_request_id: 'SPM_SIM_' + crypto.randomUUID().slice(0, 8),
      customer_message: 'Simulated SasaPay STK push sent.'
    };
  }

  try {
    const token = await getToken(env);
    const phone = opts.phone.replace('+', ''); // Ensure format 254...
    const networkCode = opts.networkCode || '63902'; 

    const body = {
      MerchantCode: env.SASAPAY_MERCHANT_CODE,
      NetworkCode: networkCode,
      PhoneNumber: phone,
      TransactionDesc: opts.description.slice(0, 20),
      AccountReference: opts.account.slice(0, 20),
      Currency: 'KES',
      Amount: Math.max(1, Math.round(opts.amount)).toString(),
      CallBackURL: env.SASAPAY_CALLBACK_URL
    };

    const res = await fetch(`${baseUrl(env)}/payments/request-payment/`, {
      method: 'POST',
      headers: { 
        Authorization: `Bearer ${token}`, 
        'Content-Type': 'application/json' 
      },
      body: JSON.stringify(body)
    });

    const data: any = await res.json();
    
    if (data.status === true || data.ResponseCode === '0') {
      return {
        simulated: false,
        success: true,
        checkout_request_id: data.CheckoutRequestID || data.MerchantRequestID,
        merchant_request_id: data.MerchantRequestID || data.CheckoutRequestID,
        customer_message: data.CustomerMessage || 'STK push sent.'
      };
    }
    return { simulated: false, success: false, error: data.message || data.detail };
  } catch (e: any) {
    return { simulated: false, success: false, error: e.message };
  }
}

export async function sasapayQuery(env: SasaPayEnv, checkoutRequestId: string) {
  // Implement the API call to query transaction status from SasaPay
  // Usually GET /payments/transaction-status/?CheckoutRequestID=...
  const token = await getToken(env);
  const res = await fetch(`${baseUrl(env)}/payments/transaction-status/?CheckoutRequestID=${checkoutRequestId}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return await res.json();
}
