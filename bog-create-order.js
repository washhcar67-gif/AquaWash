import axios from 'axios';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const { txnId, amount, machineId, machineName } = req.body;
    if (!txnId || !amount || !machineId) return res.status(400).json({ error: 'Missing fields' });

    const merchantId = process.env.BOG_MERCHANT_ID;
    const apiKey = process.env.BOG_API_KEY;
    const callbackUrl = process.env.BOG_CALLBACK_URL ||
      `https://${process.env.VERCEL_URL}/api/bog-webhook`;
    const returnUrl = req.headers.origin || `https://${process.env.VERCEL_URL}`;

    if (!merchantId || !apiKey) return res.status(503).json({ error: 'BOG not configured' });

    const bogResp = await axios.post(
      'https://api.bog.ge/payments/v1/ecommerce/orders',
      {
        callback_url: callbackUrl,
        external_order_id: txnId,
        purchase_units: {
          currency: 'GEL',
          total_amount: Number(amount),
          basket: [{ product_id: `machine_${machineId}`, quantity: 1, unit_price: Number(amount), description: machineName || 'AquaWash' }],
        },
        redirect_urls: {
          success: returnUrl + '?payment=success&txn=' + txnId,
          fail: returnUrl + '?payment=fail&txn=' + txnId,
        },
      },
      { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': txnId } }
    );

    const checkoutUrl = bogResp.data?.links?.redirect || bogResp.data?.redirect_url || bogResp.data?.checkout_url;
    if (!checkoutUrl) return res.status(502).json({ error: 'No checkout URL from BOG' });

    return res.status(200).json({ checkoutUrl });
  } catch (err) {
    console.error('BOG create order error:', err?.response?.data || err.message);
    return res.status(500).json({ error: 'BOG order creation failed' });
  }
}
