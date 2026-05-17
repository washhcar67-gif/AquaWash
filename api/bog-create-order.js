import axios from 'axios';
import { rateLimit, validateOrderInput, setCORSHeaders, getClientIP } from './_security.js';

export default async function handler(req, res) {
  setCORSHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).end();

  // Rate limit — 5 შეკვეთა/წუთი per IP
  if (!rateLimit(req, res, 'create-order')) return;

  // Input validation
  const validationError = validateOrderInput(req.body);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const { txnId, amount, machineId, machineName } = req.body;

  try {
    const merchantId = process.env.BOG_MERCHANT_ID;
    const apiKey = process.env.BOG_API_KEY;
    const callbackUrl = process.env.BOG_CALLBACK_URL ||
      `https://${process.env.VERCEL_URL}/api/bog-webhook`;
    const returnUrl = req.headers.origin || `https://${process.env.VERCEL_URL}`;

    if (!merchantId || !apiKey) {
      return res.status(503).json({ error: 'BOG not configured' });
    }

    const bogResp = await axios.post(
      'https://api.bog.ge/payments/v1/ecommerce/orders',
      {
        callback_url: callbackUrl,
        external_order_id: txnId,
        purchase_units: {
          currency: 'GEL',
          total_amount: Number(amount),
          basket: [{
            product_id: `machine_${machineId}`,
            quantity: 1,
            unit_price: Number(amount),
            description: String(machineName || 'AquaWash').slice(0, 100)
          }],
        },
        redirect_urls: {
          success: returnUrl + '?payment=success&txn=' + encodeURIComponent(txnId),
          fail: returnUrl + '?payment=fail&txn=' + encodeURIComponent(txnId),
        },
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': txnId
        },
        timeout: 10000,
      }
    );

    const checkoutUrl =
      bogResp.data?.links?.redirect ||
      bogResp.data?.redirect_url ||
      bogResp.data?.checkout_url;

    if (!checkoutUrl) {
      return res.status(502).json({ error: 'No checkout URL from BOG' });
    }

    return res.status(200).json({ checkoutUrl });

  } catch (err) {
    console.error('BOG create order error:', err?.response?.data || err.message);
    return res.status(500).json({ error: 'BOG order creation failed' });
  }
}
