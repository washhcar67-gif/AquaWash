import crypto from 'crypto';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';

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

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  initFirebase();
  const db = getDatabase();

  try {
    const secretKey = process.env.TBC_SECRET_KEY || '';
    const signature = req.headers['x-signature'] || '';
    const rawBody = JSON.stringify(req.body);

    if (secretKey && signature) {
      const expected = crypto.createHmac('sha256', secretKey).update(rawBody).digest('hex');
      if (signature !== expected) return res.status(401).json({ error: 'Invalid signature' });
    }

    const { orderId, status } = req.body;
    const order_id = orderId || req.body.order_id;

    if (status === 'FAILED' || status === 'CANCELLED') {
      await rejectTxn(db, order_id);
      return res.status(200).json({ received: true });
    }

    if (status !== 'SUCCEEDED' && status !== 'SUCCESS') {
      return res.status(200).json({ received: true });
    }

    await confirmTxn(db, order_id);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('TBC webhook error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

async function confirmTxn(db, orderId) {
  const snap = await db.ref('transactions').orderByChild('id').equalTo(orderId).once('value');
  if (!snap.val()) return;
  let txnKey, txnData;
  snap.forEach(c => { if (c.val().status === 'pending') { txnKey = c.key; txnData = c.val(); } });
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
  snap.forEach(c => { if (c.val().status === 'pending') { txnKey = c.key; txnData = c.val(); } });
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
