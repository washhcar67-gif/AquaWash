import crypto from 'crypto';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';
import { rateLimit } from './_security.js';

function initFirebase() {
  if (getApps().length) return;
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
    databaseURL: process.env.FIREBASE_DATABASE_URL,
  });
}

function verifySignature(req, secret) {
  if (!secret) return true;
  const signature = req.headers['x-signature'] || req.headers['x-callback-signature'] || '';
  if (!signature) return false;
  const rawBody = JSON.stringify(req.body);
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature.padEnd(64, '0'), 'hex'),
      Buffer.from(expected.padEnd(64, '0'), 'hex')
    );
  } catch { return false; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // Rate limit webhooks
  if (!rateLimit(req, res, 'webhook')) return;

  initFirebase();
  const db = getDatabase();

  try {
    // Signature verification
    const secretKey = process.env.BOG_SECRET_KEY || '';
    if (secretKey && !verifySignature(req, secretKey)) {
      console.warn('BOG webhook: invalid signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const { order_id, status } = req.body;

    // Validate status
    if (!order_id || typeof order_id !== 'string') {
      return res.status(400).json({ error: 'Invalid order_id' });
    }

    if (status === 'FAILED' || status === 'REJECTED') {
      await rejectTxn(db, order_id);
      return res.status(200).json({ received: true });
    }

    if (status !== 'SUCCESS' && status !== 'COMPLETED') {
      return res.status(200).json({ received: true });
    }

    await confirmTxn(db, order_id);
    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('BOG webhook error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

async function confirmTxn(db, orderId) {
  const snap = await db.ref('transactions').orderByChild('id').equalTo(orderId).once('value');
  if (!snap.val()) return;
  let txnKey, txnData;
  snap.forEach(c => {
    if (c.val().status === 'pending') { txnKey = c.key; txnData = c.val(); }
  });
  if (!txnKey) return;

  await db.ref(`transactions/${txnKey}`).update({ status: 'success' });

  const configSnap = await db.ref('config').once('value');
  const config = configSnap.val() || {};
  const machSnap = await db.ref('config/machines').once('value');
  const machines = machSnap.val();
  if (Array.isArray(machines)) {
    const washMs = (Number(config.washTimeout) || 30) * 60 * 1000;
    const updated = machines.map(m =>
      Number(m.id) === Number(txnData.machineId)
        ? { ...m, status: 'busy', busyUntil: Date.now() + washMs, _pending: false }
        : m
    );
    await db.ref('config/machines').set(updated);
  }
}

async function rejectTxn(db, orderId) {
  const snap = await db.ref('transactions').orderByChild('id').equalTo(orderId).once('value');
  if (!snap.val()) return;
  let txnKey, txnData;
  snap.forEach(c => {
    if (c.val().status === 'pending') { txnKey = c.key; txnData = c.val(); }
  });
  if (!txnKey) return;

  await db.ref(`transactions/${txnKey}`).update({ status: 'rejected' });

  const machSnap = await db.ref('config/machines').once('value');
  const machines = machSnap.val();
  if (Array.isArray(machines)) {
    const updated = machines.map(m =>
      Number(m.id) === Number(txnData.machineId) && m._pending
        ? { ...m, status: 'free', busyUntil: null, _pending: false }
        : m
    );
    await db.ref('config/machines').set(updated);
  }
}
