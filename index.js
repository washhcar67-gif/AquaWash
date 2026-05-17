/**
 * AquaWash — Firebase Cloud Functions
 * BOG Pay + TBC Pay webhook handlers
 *
 * SETUP:
 *   npm install -g firebase-tools
 *   firebase login
 *   firebase init functions  (choose your project: aquawash-5ddf9)
 *   ამ ფაილის კოდი ჩასვი functions/index.js-ში
 *   npm install axios crypto  (functions/ დირექტორიაში)
 *   firebase deploy --only functions
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const crypto = require("crypto");
const axios = require("axios");

admin.initializeApp();
const db = admin.database();

// ─────────────────────────────────────────────
// დამხმარე: config Firebase-იდან
// ─────────────────────────────────────────────
async function getConfig() {
  const snap = await db.ref("config").once("value");
  return snap.val() || {};
}

// ─────────────────────────────────────────────
// დამხმარე: pending txn-ი orderId-ით
// ─────────────────────────────────────────────
async function findPendingTxn(orderId) {
  const snap = await db.ref("transactions").orderByChild("id").equalTo(orderId).once("value");
  if (!snap.val()) return null;
  let result = null;
  snap.forEach((child) => {
    if (child.val().status === "pending") {
      result = { _key: child.key, ...child.val() };
    }
  });
  return result;
}

// ─────────────────────────────────────────────
// დამხმარე: txn დადასტურება + მანქანა busy
// ─────────────────────────────────────────────
async function confirmTxnAndStartMachine(txnKey, txnData, config) {
  // 1. txn → success
  await db.ref(`transactions/${txnKey}`).update({ status: "success" });

  // 2. machine → busy
  const machinesSnap = await db.ref("config/machines").once("value");
  const machines = machinesSnap.val();
  if (Array.isArray(machines)) {
    const washMs = (Number(config.washTimeout) || 30) * 60 * 1000;
    const updated = machines.map((m) => {
      if (Number(m.id) === Number(txnData.machineId)) {
        return { ...m, status: "busy", busyUntil: Date.now() + washMs, _pending: false };
      }
      return m;
    });
    await db.ref("config/machines").set(updated);
  }
}

// ═══════════════════════════════════════════════════════════
//  BOG PAY WEBHOOK
//  BOG Developer Portal-ში Callback URL:
//  https://us-central1-aquawash-5ddf9.cloudfunctions.net/bogWebhook
// ═══════════════════════════════════════════════════════════
exports.bogWebhook = functions.https.onRequest(async (req, res) => {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  try {
    const config = await getConfig();
    const secretKey = config.bogSecretKey || "";

    // ── ხელმოწერის შემოწმება ──────────────────────────────
    // BOG აგზავნის X-Signature header-ს: HMAC-SHA256(rawBody, secretKey)
    const signature = req.headers["x-signature"] || req.headers["x-callback-signature"] || "";
    const rawBody = JSON.stringify(req.body); // Firebase functions ავტომატურად parse-ავს JSON-ს

    if (secretKey) {
      const expected = crypto
        .createHmac("sha256", secretKey)
        .update(rawBody)
        .digest("hex");

      if (signature !== expected) {
        console.error("BOG: ხელმოწერა არასწორია", { received: signature, expected });
        return res.status(401).json({ error: "Invalid signature" });
      }
    }

    // ── BOG-ის payload სტრუქტურა ─────────────────────────
    // { order_id, status, amount, currency, ... }
    const { order_id, status, amount } = req.body;

    console.log("BOG webhook:", { order_id, status, amount });

    if (status !== "SUCCESS" && status !== "COMPLETED") {
      // გადახდა ჯერ არ დასრულებულა ან ჩაიშალა
      if (status === "FAILED" || status === "REJECTED") {
        const txn = await findPendingTxn(order_id);
        if (txn) {
          await db.ref(`transactions/${txn._key}`).update({ status: "rejected" });
          // მანქანა free-ზე ვაბრუნებთ
          const machSnap = await db.ref("config/machines").once("value");
          const machs = machSnap.val();
          if (Array.isArray(machs)) {
            const upd = machs.map((m) =>
              Number(m.id) === Number(txn.machineId) && m._pending
                ? { ...m, status: "free", busyUntil: null, _pending: false }
                : m
            );
            await db.ref("config/machines").set(upd);
          }
        }
      }
      return res.status(200).json({ received: true });
    }

    // ── გადახდა წარმატებული ─────────────────────────────
    const txn = await findPendingTxn(order_id);
    if (!txn) {
      console.warn("BOG: txn ვერ მოიძებნა:", order_id);
      return res.status(200).json({ received: true }); // 200 — BOG რომ არ გაიმეოროს
    }

    await confirmTxnAndStartMachine(txn._key, txn, config);
    console.log("BOG: მანქანა ჩაირთო:", txn.machineId);

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("BOG webhook შეცდომა:", err);
    return res.status(500).json({ error: "Internal error" });
  }
});

// ═══════════════════════════════════════════════════════════
//  TBC PAY WEBHOOK
//  TBC Developer Portal-ში Callback URL:
//  https://us-central1-aquawash-5ddf9.cloudfunctions.net/tbcWebhook
// ═══════════════════════════════════════════════════════════
exports.tbcWebhook = functions.https.onRequest(async (req, res) => {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  try {
    const config = await getConfig();
    const secretKey = config.tbcSecretKey || "";

    // ── ხელმოწერის შემოწმება ──────────────────────────────
    // TBC აგზავნის X-Signature ან Authorization header-ს
    const signature = req.headers["x-signature"] || "";
    const rawBody = JSON.stringify(req.body);

    if (secretKey && signature) {
      const expected = crypto
        .createHmac("sha256", secretKey)
        .update(rawBody)
        .digest("hex");

      if (signature !== expected) {
        console.error("TBC: ხელმოწერა არასწორია");
        return res.status(401).json({ error: "Invalid signature" });
      }
    }

    // ── TBC-ის payload სტრუქტურა ─────────────────────────
    // { payId, status, amount, currency, orderId, ... }
    const { orderId, status, payId } = req.body;
    const order_id = orderId || req.body.order_id;

    console.log("TBC webhook:", { order_id, status, payId });

    // TBC სტატუსები: CREATED, PROCESSING, SUCCEEDED, FAILED, CANCELLED
    if (status !== "SUCCEEDED" && status !== "SUCCESS") {
      if (status === "FAILED" || status === "CANCELLED") {
        const txn = await findPendingTxn(order_id);
        if (txn) {
          await db.ref(`transactions/${txn._key}`).update({ status: "rejected" });
          const machSnap = await db.ref("config/machines").once("value");
          const machs = machSnap.val();
          if (Array.isArray(machs)) {
            const upd = machs.map((m) =>
              Number(m.id) === Number(txn.machineId) && m._pending
                ? { ...m, status: "free", busyUntil: null, _pending: false }
                : m
            );
            await db.ref("config/machines").set(upd);
          }
        }
      }
      return res.status(200).json({ received: true });
    }

    // ── გადახდა წარმატებული ─────────────────────────────
    const txn = await findPendingTxn(order_id);
    if (!txn) {
      console.warn("TBC: txn ვერ მოიძებნა:", order_id);
      return res.status(200).json({ received: true });
    }

    await confirmTxnAndStartMachine(txn._key, txn, config);
    console.log("TBC: მანქანა ჩაირთო:", txn.machineId);

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("TBC webhook შეცდომა:", err);
    return res.status(500).json({ error: "Internal error" });
  }
});

// ═══════════════════════════════════════════════════════════
//  BOG PAY — Checkout URL გენერაცია (კლიენტი იძახებს)
//  კლიენტი → ეს function → BOG API → checkout URL → redirect
// ═══════════════════════════════════════════════════════════
exports.bogCreateOrder = functions.https.onRequest(async (req, res) => {
  // CORS — client HTML-ისთვის
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  try {
    const config = await getConfig();
    const { txnId, amount, machineId, machineName } = req.body;

    if (!txnId || !amount || !machineId) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const merchantId = config.bogMerchantId;
    const secretKey = config.bogSecretKey;
    const apiKey = config.bogApiKey;
    const callbackUrl = config.bogCallbackUrl ||
      "https://us-central1-aquawash-5ddf9.cloudfunctions.net/bogWebhook";

    if (!merchantId || !secretKey) {
      return res.status(503).json({ error: "BOG credentials not configured" });
    }

    // BOG Pay API — order შექმნა
    // დოკუმენტაცია: https://developer.bog.ge/docs/payment
    const bogResponse = await axios.post(
      "https://api.bog.ge/payments/v1/ecommerce/orders",
      {
        callback_url: callbackUrl,
        external_order_id: txnId,
        purchase_units: {
          currency: "GEL",
          total_amount: Number(amount),
          basket: [{ product_id: `machine_${machineId}`, quantity: 1, unit_price: Number(amount), description: machineName || "AquaWash" }],
        },
        redirect_urls: {
          success: req.headers.origin + "?payment=success&txn=" + txnId,
          fail: req.headers.origin + "?payment=fail&txn=" + txnId,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey || secretKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": txnId,
        },
      }
    );

    const checkoutUrl = bogResponse.data?.links?.redirect ||
                        bogResponse.data?.redirect_url ||
                        bogResponse.data?.checkout_url;

    if (!checkoutUrl) {
      console.error("BOG: checkout URL ვერ მოიძებნა", bogResponse.data);
      return res.status(502).json({ error: "BOG did not return checkout URL" });
    }

    return res.status(200).json({ checkoutUrl });
  } catch (err) {
    console.error("BOG createOrder შეცდომა:", err?.response?.data || err.message);
    return res.status(500).json({ error: "BOG order creation failed" });
  }
});

// ═══════════════════════════════════════════════════════════
//  TBC PAY — Checkout URL გენერაცია
// ═══════════════════════════════════════════════════════════
exports.tbcCreateOrder = functions.https.onRequest(async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  try {
    const config = await getConfig();
    const { txnId, amount, machineId, machineName } = req.body;

    if (!txnId || !amount || !machineId) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const merchantId = config.tbcMerchantId;
    const secretKey = config.tbcSecretKey;
    const apiKey = config.tbcApiKey;
    const callbackUrl = config.tbcCallbackUrl ||
      "https://us-central1-aquawash-5ddf9.cloudfunctions.net/tbcWebhook";

    if (!merchantId || !secretKey) {
      return res.status(503).json({ error: "TBC credentials not configured" });
    }

    // TBC Pay API — access token მიღება
    const tokenResp = await axios.post(
      "https://api.tbcbank.ge/v1/tpay/access-token",
      `client_id=${encodeURIComponent(apiKey || merchantId)}&client_secret=${encodeURIComponent(secretKey)}&grant_type=client_credentials`,
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
    const accessToken = tokenResp.data?.access_token;
    if (!accessToken) {
      return res.status(502).json({ error: "TBC token failed" });
    }

    // TBC Pay API — order შექმნა
    // დოკუმენტაცია: https://developers.tbcbank.ge/docs/tpay
    const tbcResponse = await axios.post(
      "https://api.tbcbank.ge/v1/tpay/orders",
      {
        amount: { currency: "GEL", total: Number(amount), subtotal: Number(amount) },
        intent: "CHARGE",
        returnUrl: req.headers.origin + "?payment=success&txn=" + txnId,
        callbackUrl: callbackUrl,
        merchantOrderId: txnId,
        items: [{ name: machineName || "AquaWash", price: Number(amount), quantity: 1 }],
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    const checkoutUrl = tbcResponse.data?.links?.find(l => l.rel === "approve")?.href ||
                        tbcResponse.data?.checkout_url ||
                        tbcResponse.data?.redirectUrl;

    if (!checkoutUrl) {
      console.error("TBC: checkout URL ვერ მოიძებნა", tbcResponse.data);
      return res.status(502).json({ error: "TBC did not return checkout URL" });
    }

    return res.status(200).json({ checkoutUrl });
  } catch (err) {
    console.error("TBC createOrder შეცდომა:", err?.response?.data || err.message);
    return res.status(500).json({ error: "TBC order creation failed" });
  }
});
