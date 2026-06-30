// Add this interface or update your existing opts type
export type SasaPayStkOpts = { 
  phone: string; 
  amount: number; 
  account: string; 
  description: string; 
  networkCode?: string; // M-PESA: "63902", Airtel: "63903", T-Kash: "63907"
};

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
    const phone = normalizePhone(opts.phone);
    
    // Use the provided networkCode or default to M-PESA
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
    
    // Success code '0' or status true confirms the STK push was triggered
    if (data.status === true || data.ResponseCode === '0') {
      return {
        simulated: false,
        success: true,
        checkout_request_id: data.CheckoutRequestID || data.MerchantRequestID,
        merchant_request_id: data.MerchantRequestID || data.CheckoutRequestID,
        customer_message: data.CustomerMessage || 'STK push sent. Enter PIN on your phone.'
      };
    }
    return { simulated: false, success: false, error: data.message || data.detail };
  } catch (e: any) {
    return { simulated: false, success: false, error: e.message };
  }
}
