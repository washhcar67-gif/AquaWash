import axios from 'axios';
import { rateLimit, validateOrderInput, setCORSHeaders } from './_security.js';

export default async function handler(req, res) {
  setCORSHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).end();

  // Rate limit
  if (!rateLimit(req, res, 'create-order')) return;

  // Input validation
  const validationError = validateOrderInput(req.body);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const { txnId, amount, machineId, machineName } = req.body;

  try {
    const clientId = process.env.TBC_API_KEY;
    const secretKey = process.env.TBC_SECRET_KEY;
    const callbackUrl = process.env.TBC_CALLBACK_URL ||
      `https://${process.env.VERCEL_URL}/api/tbc-webhook`;
    const returnUrl = req.headers.origin || `https://${process.env.VERCEL_URL}`;

    if (!clientId || !secretKey) {
      return res.status(503).json({ error: 'TBC not configured' });
    }

    // Token
    const tokenResp = await axios.post(
      'https://api.tbcbank.ge/v1/tpay/access-token',
      `client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(secretKey)}&grant_type=client_credentials`,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 8000 }
    );
    const accessToken = tokenResp.data?.access_token;
    if (!accessToken) return res.status(502).json({ error: 'TBC token failed' });

    const tbcResp = await axios.post(
      'https://api.tbcbank.ge/v1/tpay/orders',
      {
        amount: { currency: 'GEL', total: Number(amount), subtotal: Number(amount) },
        intent: 'CHARGE',
        returnUrl: returnUrl + '?payment=success&txn=' + encodeURIComponent(txnId),
        callbackUrl,
        merchantOrderId: txnId,
        items: [{
          name: String(machineName || 'AquaWash').slice(0, 100),
          price: Number(amount),
          quantity: 1
        }],
      },
      {
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        timeout: 10000,
      }
    );

    const checkoutUrl =
      tbcResp.data?.links?.find(l => l.rel === 'approve')?.href ||
      tbcResp.data?.checkout_url ||
      tbcResp.data?.redirectUrl;

    if (!checkoutUrl) return res.status(502).json({ error: 'No checkout URL from TBC' });

    return res.status(200).json({ checkoutUrl });

  } catch (err) {
    console.error('TBC create order error:', err?.response?.data || err.message);
    return res.status(500).json({ error: 'TBC order creation failed' });
  }
}
