// ===== AquaWash Security Middleware =====
// გამოიყენება ყველა API endpoint-ზე

// In-memory rate limit store (Vercel serverless — per instance)
const rateLimitStore = new Map();

const RATE_LIMITS = {
  'create-order': { windowMs: 60_000, max: 5 },   // 5 შეკვეთა/წუთი per IP
  'webhook':      { windowMs: 10_000, max: 20 },  // 20 webhook/10წმ
  'default':      { windowMs: 60_000, max: 30 },
};

export function getClientIP(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

export function rateLimit(req, res, type = 'default') {
  const ip = getClientIP(req);
  const key = `${type}:${ip}`;
  const limit = RATE_LIMITS[type] || RATE_LIMITS.default;
  const now = Date.now();

  if (!rateLimitStore.has(key)) {
    rateLimitStore.set(key, { count: 1, resetAt: now + limit.windowMs });
    return true;
  }

  const entry = rateLimitStore.get(key);

  if (now > entry.resetAt) {
    rateLimitStore.set(key, { count: 1, resetAt: now + limit.windowMs });
    return true;
  }

  entry.count++;

  if (entry.count > limit.max) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    res.setHeader('Retry-After', retryAfter);
    res.setHeader('X-RateLimit-Limit', limit.max);
    res.setHeader('X-RateLimit-Remaining', 0);
    res.status(429).json({
      error: 'Too many requests. Please try again later.',
      retryAfter
    });
    return false;
  }

  res.setHeader('X-RateLimit-Limit', limit.max);
  res.setHeader('X-RateLimit-Remaining', Math.max(0, limit.max - entry.count));
  return true;
}

// Input validation
export function validateOrderInput(body) {
  const { txnId, amount, machineId, machineName } = body || {};

  if (!txnId || typeof txnId !== 'string') return 'Invalid txnId';
  if (!/^TXN\d+_[A-Z0-9]{5}$/.test(txnId)) return 'Invalid txnId format';
  if (!amount || isNaN(Number(amount))) return 'Invalid amount';
  if (Number(amount) < 0.5 || Number(amount) > 500) return 'Amount out of range';
  if (!machineId || isNaN(Number(machineId))) return 'Invalid machineId';
  if (Number(machineId) < 1 || Number(machineId) > 100) return 'MachineId out of range';
  if (machineName && typeof machineName === 'string' && machineName.length > 100) return 'MachineName too long';

  return null; // valid
}

// CORS — მხოლოდ ჩვენი დომენიდან
export function setCORSHeaders(req, res) {
  const allowedOrigins = [
    'https://aqua-wash-9ywz.vercel.app',
    'http://localhost:5500',
    'http://127.0.0.1:5500',
  ];

  const origin = req.headers.origin || '';
  if (allowedOrigins.includes(origin) || origin.endsWith('.vercel.app')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', 'https://aqua-wash-9ywz.vercel.app');
  }

  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

// Webhook signature verification
export function verifyWebhookSignature(req, secret, headerName = 'x-signature') {
  if (!secret) return true; // credentials არ არის — skip
  const signature = req.headers[headerName] || req.headers['x-callback-signature'] || '';
  if (!signature) return false;
  const rawBody = JSON.stringify(req.body);
  const expected = require('crypto')
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
  // timing-safe comparison
  try {
    return require('crypto').timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expected, 'hex')
    );
  } catch {
    return false;
  }
}

// Clean up old rate limit entries (memory management)
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of rateLimitStore.entries()) {
    if (now > val.resetAt) rateLimitStore.delete(key);
  }
}, 60_000);
