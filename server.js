const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const path    = require('path');
const admin   = require('firebase-admin');

const app  = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ── Firebase Admin SDK ───────────────────────────────────────────────────────
let db = null;
try {
  let serviceAccount;
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } else {
    serviceAccount = require('./serviceAccountKey.json');
  }
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  db = admin.firestore();
  console.log('[Firebase] Admin SDK initialized');
} catch (e) {
  console.warn('[Firebase] NOT initialized:', e.message);
  console.warn('[Firebase] Set FIREBASE_SERVICE_ACCOUNT env var on Render');
}

// ── PayHero Config ───────────────────────────────────────────────────────────
// PAYHERO_AUTH_TOKEN must be the ALREADY base64-encoded string from the PayHero
// dashboard → API Keys → copy the full Basic Auth token (without the word "Basic")
// e.g. if PayHero shows:  Basic dXNlcjpwYXNz  →  store only:  dXNlcjpwYXNz
// The cleaning below protects against common copy-paste mistakes (extra "Basic ",
// stray whitespace, accidental quotes) so a slightly-off paste doesn't silently break auth.
function cleanAuthToken(raw) {
  if (!raw) return '';
  let t = String(raw).trim();
  t = t.replace(/^["']|["']$/g, '');       // strip surrounding quotes if pasted with them
  t = t.replace(/^Basic\s+/i, '');         // strip an accidentally-included "Basic " prefix
  return t.trim();
}

const PAYHERO_AUTH_TOKEN = cleanAuthToken(process.env.PAYHERO_AUTH_TOKEN);
const PAYHERO_CHANNEL_RAW = (process.env.PAYHERO_CHANNEL_ID || '').trim();
const PAYHERO_CHANNEL    = Number(PAYHERO_CHANNEL_RAW);
const PAYHERO_PROVIDER   = process.env.PAYHERO_PROVIDER || 'm-pesa';
const PAYHERO_BASE_URL   = 'https://backend.payhero.co.ke/api/v2';
const CALLBACK_URL       = process.env.CALLBACK_URL; // e.g. https://your-app.onrender.com/api/callback

function getAuthHeader() {
  return 'Basic ' + PAYHERO_AUTH_TOKEN;
}

console.log('[PayHero] Channel ID:', Number.isFinite(PAYHERO_CHANNEL) ? PAYHERO_CHANNEL : 'INVALID — raw value was: ' + JSON.stringify(PAYHERO_CHANNEL_RAW));
console.log('[PayHero] Auth Token set:', PAYHERO_AUTH_TOKEN ? 'YES (' + PAYHERO_AUTH_TOKEN.length + ' chars)' : 'NO');
console.log('[PayHero] Callback URL:', CALLBACK_URL || 'MISSING — set CALLBACK_URL env var');

// ── In-memory payment store ──────────────────────────────────────────────────
// WARNING: this resets on every Render restart. That is WHY the status endpoint
// also checks Firestore — Firestore (pendingPayments + the order doc itself) is
// the persistent source of truth. paymentStore is only a fast local cache.
const paymentStore = {};

// Payment timeout: if PENDING for more than 2 minutes → treat as FAILED
const PAYMENT_TIMEOUT_MS = 120000;

// ── Shared: normalize a Kenyan phone number to 254XXXXXXXXX ─────────────────
function normalizePhone(phone) {
  let p = String(phone).replace(/\D/g, '');
  if (p.startsWith('254') && p.length === 12) {
    // already correct
  } else if (p.startsWith('0') && p.length === 10) {
    p = '254' + p.slice(1);
  } else if (!p.startsWith('254')) {
    p = '254' + p;
  }
  return p;
}

// ── Shared: fire the PayHero STK push and record it in paymentStore + Firestore.
// Used by both /api/order/pay (legacy two-step) and /api/order/create-and-pay
// (new one-step flow). Returns a plain object — never throws.
async function sendStkPush(amount, phone, orderId, userId) {
  const p = normalizePhone(phone);
  const usedExtRef = 'ORD_' + orderId + '_' + Date.now();
  console.log('[Pay] KES', amount, 'to', p, 'orderId:', orderId, 'extRef:', usedExtRef);

  if (!Number.isFinite(PAYHERO_CHANNEL)) {
    console.error('[Pay] ABORTED — PAYHERO_CHANNEL_ID is not a valid number. Raw env value:', JSON.stringify(PAYHERO_CHANNEL_RAW));
    return { success: false, error: 'Payment channel is not configured correctly on the server.' };
  }
  if (!PAYHERO_AUTH_TOKEN) {
    console.error('[Pay] ABORTED — PAYHERO_AUTH_TOKEN is empty.');
    return { success: false, error: 'Payment credentials are not configured correctly on the server.' };
  }

  console.log('[Pay] DEBUG — sending to PayHero: channel_id=' + PAYHERO_CHANNEL + ', provider=' + PAYHERO_PROVIDER + ', auth_token_len=' + PAYHERO_AUTH_TOKEN.length);

  try {
    const response = await axios.post(
      PAYHERO_BASE_URL + '/payments',
      {
        amount:             Number(amount),
        phone_number:       p,
        channel_id:         PAYHERO_CHANNEL,
        provider:           PAYHERO_PROVIDER,
        external_reference: usedExtRef,
        callback_url:       CALLBACK_URL,
      },
      {
        headers: {
          'Authorization': getAuthHeader(),
          'Content-Type':  'application/json',
        },
      }
    );

    const respData = response.data || {};
    console.log('[Pay] PayHero response:', JSON.stringify(respData));

    // PayHero returns { success: true, status: "QUEUED", reference: "...", CheckoutRequestID: "..." }
    // "QUEUED" means the STK push was sent to the phone — NOT a payment success yet.

    if (respData.success === false) {
      console.warn('[Pay] PayHero rejected STK:', respData);
      return {
        success: false,
        error: respData.error_message || respData.message || 'STK push was rejected. Check the phone number and try again.',
      };
    }

    const reference = respData.reference
                   || respData.CheckoutRequestID
                   || respData.id
                   || respData.transaction_id;

    const entry = {
      status:    'PENDING',
      amount:    Number(amount),
      orderId,
      userId:    userId || null,
      createdAt: Date.now(),
    };
    if (reference) paymentStore[reference] = Object.assign({}, entry);
    paymentStore[usedExtRef] = Object.assign({}, entry, { payheroRef: reference });

    // Durable backup so /api/order/status and /api/callback can recover orderId
    // even after a Render restart wipes paymentStore from memory.
    if (db) {
      await db.collection('pendingPayments').doc(usedExtRef).set({
        orderId,
        userId:    userId || null,
        amount:    Number(amount),
        status:    'PENDING',
        reference: reference || null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      }).catch(e => console.warn('[Pay] pendingPayments write failed:', e.message));

      // Stamp the order with the references we'll need to resolve status later.
      await db.collection('orders').doc(orderId).update({
        status:        'pending_payment',
        payheroRef:    reference || null,
        externalRef:   usedExtRef,
        paymentPhone:  p,
      }).catch(e => console.warn('[Pay] order stamp failed:', e.message));
    }

    return {
      success:   true,
      reference: reference,
      extRef:    usedExtRef,
      message:   'STK push sent. Check your phone.',
    };

  } catch (err) {
    const errData = err.response ? err.response.data : err.message;
    console.error('[Pay] Error:', errData);
    return {
      success: false,
      error: (errData && (errData.error_message || errData.message)) || 'Payment initiation failed',
    };
  }
}

// ── POST /api/order/create-and-pay — ONE-STEP checkout ───────────────────────
// Creates the order doc in Firestore using the Admin SDK (bypasses client-side
// security rules entirely — this is what fixes "could not save your order"
// errors caused by Firestore rules rejecting an unauthenticated browser write),
// then immediately fires the PayHero STK push. Tapping "Pay" makes exactly one
// request and both things happen together server-side.
app.post('/api/order/create-and-pay', async (req, res) => {
  const {
    items, subtotal, deliveryFee, total,
    customerName, customerPhone, mpesaPhone,
    customerEmail, uid,
    deliveryLocation, note, userId,
  } = req.body;

  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, error: 'Cart is empty.' });
  }
  if (!total || !mpesaPhone) {
    return res.status(400).json({ success: false, error: 'total and mpesaPhone are required' });
  }
  if (!db) {
    return res.status(503).json({ success: false, error: 'Server is not connected to the database right now. Please try again shortly.' });
  }

  const reference = 'GF-' + Date.now();
  let orderId;

  // Step 1: create the order doc FIRST, via Admin SDK — cannot be blocked by rules.
  try {
    const orderRef = await db.collection('orders').add({
      ref:             reference,
      items,
      subtotal:        Number(subtotal) || 0,
      deliveryFee:     Number(deliveryFee) || 0,
      total:           Number(total),
      customerName:    customerName || '',
      customerPhone:   customerPhone || '',
      customerEmail:   customerEmail || '',
      uid:             uid || '',
      mpesaPhone,
      deliveryLocation: deliveryLocation || null,
      note:            note || '',
      status:          'pending_payment',
      createdAt:       admin.firestore.FieldValue.serverTimestamp(),
    });
    orderId = orderRef.id;
  } catch (e) {
    console.error('[CreateOrder] Firestore write failed:', e.message);
    return res.status(500).json({ success: false, error: 'Could not save your order. Please check your connection and try again.' });
  }

  // Step 2: fire the STK push, tagged to the order we just created.
  const stkResult = await sendStkPush(total, mpesaPhone, orderId, userId);

  if (stkResult.success === false) {
    // Order is saved either way — customer can retry payment without re-entering the cart.
    return res.status(200).json({
      success: false,
      orderId,
      reference,
      error: stkResult.error,
    });
  }

  return res.json({
    success:   true,
    orderId,
    reference,
    payheroReference: stkResult.reference,
    extRef:    stkResult.extRef,
    message:   'Order saved. STK push sent — check your phone.',
  });
});

// ── POST /api/order/pay — Initiate STK Push for an existing order ───────────
// Legacy two-step endpoint (kept for backward compatibility). The frontend
// must create the order doc in Firestore FIRST, then call this with that
// order's Firestore doc id as `orderId`. New checkouts should use
// /api/order/create-and-pay above instead, which avoids the client-side
// Firestore write (and the security-rule failures that come with it).
app.post('/api/order/pay', async (req, res) => {
  const { amount, phone, orderId, userId } = req.body;

  if (!amount || !phone || !orderId) {
    return res.status(400).json({ error: 'amount, phone and orderId are required' });
  }

  const result = await sendStkPush(amount, phone, orderId, userId);
  if (result.success === false) {
    return res.status(400).json(result);
  }
  return res.json(result);
});

// ── GET /api/order/status — Frontend polling endpoint ────────────────────────
// Resolution order:
//   1. In-memory store (fastest — works if server didn't restart)
//   2. Firestore: read the order doc directly and trust its `status` field
//      (the callback writes 'paid' / 'payment_failed' there directly)
//   3. 2-minute timeout rule: if still pending past PAYMENT_TIMEOUT_MS → FAILED
//   4. PayHero transaction-status API (best-effort fallback)
//   5. Otherwise stays pending_payment
app.get('/api/order/status', async (req, res) => {
  const { reference, orderId } = req.query;
  if (!reference && !orderId) {
    return res.status(400).json({ error: 'reference or orderId is required' });
  }

  // ── 1. Direct in-memory lookup ──────────────────────────────────────────
  let payment = reference ? paymentStore[reference] : null;

  // Cross-ref: if frontend queries by payheroRef, find the extRef entry; or
  // search by orderId if that's all we were given.
  if (!payment || payment.status === 'PENDING') {
    for (const key of Object.keys(paymentStore)) {
      const e = paymentStore[key];
      if (reference && e.payheroRef === reference && (e.status === 'PAID' || e.status === 'FAILED')) {
        payment = e;
        break;
      }
      if (!reference && orderId && e.orderId === orderId && (e.status === 'PAID' || e.status === 'FAILED')) {
        payment = e;
        break;
      }
    }
  }

  if (payment && payment.status === 'PAID') {
    return res.json({ status: 'paid', amount: payment.amount });
  }
  if (payment && payment.status === 'FAILED') {
    return res.json({ status: 'payment_failed', amount: payment.amount || 0 });
  }

  const resolvedOrderId = orderId || (payment && payment.orderId) || null;

  // ── 2 + 3. Firestore checks ──────────────────────────────────────────────
  if (db && resolvedOrderId) {
    try {
      const orderSnap = await db.collection('orders').doc(resolvedOrderId).get();
      if (orderSnap.exists) {
        const o = orderSnap.data();
        if (o.status === 'paid') {
          paymentStore[resolvedOrderId] = { status: 'PAID', amount: o.total, orderId: resolvedOrderId, createdAt: (payment && payment.createdAt) || Date.now() };
          return res.json({ status: 'paid', amount: o.total });
        }
        if (o.status === 'payment_failed') {
          paymentStore[resolvedOrderId] = { status: 'FAILED', amount: o.total, orderId: resolvedOrderId, createdAt: (payment && payment.createdAt) || Date.now() };
          return res.json({ status: 'payment_failed', amount: o.total, reason: o.failReason || null });
        }

        // Still pending in Firestore too — check timeout against order creation time.
        const createdAtMs = (o.createdAt && o.createdAt.toMillis) ? o.createdAt.toMillis() : ((payment && payment.createdAt) || null);
        if (createdAtMs && (Date.now() - createdAtMs) > PAYMENT_TIMEOUT_MS) {
          console.log('[Status] TIMEOUT for order', resolvedOrderId, '— marking payment_failed');
          await db.collection('orders').doc(resolvedOrderId).update({
            status: 'payment_failed',
            failReason: 'timeout',
          }).catch(() => {});
          if (o.externalRef) db.collection('pendingPayments').doc(o.externalRef).delete().catch(() => {});
          paymentStore[resolvedOrderId] = { status: 'FAILED', amount: o.total, orderId: resolvedOrderId, createdAt: createdAtMs };
          return res.json({ status: 'payment_failed', amount: o.total, reason: 'timeout' });
        }
      }
    } catch (fsErr) {
      console.warn('[Status] Firestore check error:', fsErr.message);
    }
  }

  // ── 4. PayHero transaction-status API (best-effort) ──────────────────────
  const queryRef = reference || (payment && payment.payheroRef);
  if (PAYHERO_AUTH_TOKEN && queryRef) {
    try {
      const phRes = await axios.get(
        `${PAYHERO_BASE_URL}/transaction-status`,
        {
          params:  { reference: queryRef },
          headers: { 'Authorization': getAuthHeader() },
          timeout: 8000,
        }
      );

      const phData = phRes.data || {};
      console.log('[Status] PayHero transaction-status raw:', JSON.stringify(phData));

      // ResultCode is a NUMBER: 0 = success. Check with !== undefined, not ||
      const resultCode   = phData.ResultCode !== undefined ? Number(phData.ResultCode) : null;
      const phStatusStr  = String(phData.Status || phData.status || phData.transaction_status || '').toLowerCase();
      const mpesaReceipt = phData.MpesaReceiptNumber || phData.MPESA_Reference || phData.mpesa_reference || '';
      const phAmount     = Number(phData.Amount || phData.amount || (payment && payment.amount) || 0);

      console.log('[Status] resultCode:', resultCode, '| status:', phStatusStr, '| mpesa:', mpesaReceipt);

      let resolvedStatus = 'PENDING';
      if (resultCode === 0 || mpesaReceipt || phStatusStr === 'success' || phStatusStr === 'complete' || phStatusStr === 'completed') {
        resolvedStatus = 'PAID';
      }
      if ((resultCode !== null && resultCode !== 0) || ['failed', 'fail', 'cancelled', 'canceled', 'expired', 'timeout'].includes(phStatusStr)) {
        resolvedStatus = 'FAILED';
      }

      if (resolvedStatus !== 'PENDING' && resolvedOrderId && db) {
        if (resolvedStatus === 'PAID') {
          await markOrderPaid(resolvedOrderId, mpesaReceipt || queryRef, phAmount);
        } else {
          await markOrderFailed(resolvedOrderId, 'rejected_or_cancelled');
        }
      }

      paymentStore[queryRef] = { status: resolvedStatus, amount: phAmount, orderId: resolvedOrderId, createdAt: (payment && payment.createdAt) || Date.now() };

      return res.json({
        status: resolvedStatus === 'PAID' ? 'paid' : resolvedStatus === 'FAILED' ? 'payment_failed' : 'pending_payment',
        amount: phAmount,
      });

    } catch (phErr) {
      console.warn('[Status] PayHero query failed:', phErr.message, phErr.response ? '| HTTP ' + phErr.response.status : '');
    }
  }

  // ── 5. Nothing resolved — still pending ──────────────────────────────────
  return res.json({ status: 'pending_payment', amount: 0 });
});

// ── Shared: mark an order PAID in Firestore ──────────────────────────────────
async function markOrderPaid(orderId, mpesaReceipt, amount) {
  if (!db) { console.warn('[Firebase] markOrderPaid skipped — db not initialized'); return; }
  if (!orderId) { console.warn('[Firebase] markOrderPaid skipped — no orderId'); return; }

  try {
    const orderRef = db.collection('orders').doc(orderId);
    await orderRef.update({
      status:       'paid',
      mpesaReceipt: mpesaReceipt || null,
      paidAmount:   amount || null,
      paidAt:       admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log('[Firebase] Order', orderId, 'marked PAID (mpesa:', mpesaReceipt, ')');
  } catch (e) {
    console.error('[Firebase] markOrderPaid FAILED for', orderId, ':', e.message);
    throw e;
  }
}

// ── Shared: mark an order payment_failed in Firestore ────────────────────────
async function markOrderFailed(orderId, reason) {
  if (!db) { console.warn('[Firebase] markOrderFailed skipped — db not initialized'); return; }
  if (!orderId) { console.warn('[Firebase] markOrderFailed skipped — no orderId'); return; }

  try {
    await db.collection('orders').doc(orderId).update({
      status:     'payment_failed',
      failReason: reason || 'unknown',
      failedAt:   admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log('[Firebase] Order', orderId, 'marked payment_failed (reason:', reason, ')');
  } catch (e) {
    console.error('[Firebase] markOrderFailed FAILED for', orderId, ':', e.message);
    throw e;
  }
}

// ── POST /api/callback — PayHero webhook ─────────────────────────────────────
// SUCCESS: { "status": true,  "response": { "ResultCode": 0,    "MpesaReceiptNumber": "SAE3Y...", "Amount": 10, "ExternalReference": "ORD_...", ... } }
// FAILED:  { "status": false, "response": { "ResultCode": 1032, "ResultDesc": "Cancelled by user",  "ExternalReference": "ORD_...", ... } }
app.post('/api/callback', async (req, res) => {
  console.log('[Callback] Received:', JSON.stringify(req.body));

  try {
    const body     = req.body;
    const response = body.response || body;

    const extRef     = response.ExternalReference || response.external_reference || response.User_Reference || '';
    const checkoutId  = response.CheckoutRequestID || response.checkout_request_id || '';
    const mpesaRef    = response.MpesaReceiptNumber || response.MPESA_Reference || response.mpesa_reference || '';

    // ResultCode is a NUMBER from PayHero/Safaricom — 0 = success.
    // MUST check with !== undefined because 0 is falsy and would be skipped by ||
    const resultCode = response.ResultCode !== undefined
      ? Number(response.ResultCode)
      : (body.ResultCode !== undefined ? Number(body.ResultCode) : null);

    const bodyStatusTrue = body.status === true;

    // Success: PayHero says status:true AND ResultCode is 0 (or absent — some callbacks omit it on success)
    const isSuccess   = bodyStatusTrue && (resultCode === null || resultCode === 0);
    const finalStatus = isSuccess ? 'PAID' : 'FAILED';

    const existingByRef      = paymentStore[extRef]    || {};
    const existingByCheckout = paymentStore[checkoutId] || {};

    // Amount: PayHero sometimes omits Amount in the callback body.
    let amount = Number(response.Amount || response.amount || 0);
    if (!amount || amount <= 0) {
      amount = existingByRef.amount || existingByCheckout.amount || 0;
      if (amount > 0) console.log('[Callback] Amount missing in callback — recovered from store:', amount);
    }

    // orderId: store → ORD_ pattern → Firestore pendingPayments
    let orderId = existingByRef.orderId || existingByCheckout.orderId || null;
    if (!orderId) {
      const match = extRef.match(/^ORD_(.+)_(\d{13,})$/);
      if (match) orderId = match[1];
    }
    // If Render restarted and paymentStore is empty, recover from Firestore
    if (!orderId && db && extRef) {
      try {
        const pendingDoc = await db.collection('pendingPayments').doc(extRef).get();
        if (pendingDoc.exists) {
          const pd = pendingDoc.data();
          orderId = pd.orderId;
          if ((!amount || amount <= 0) && pd.amount) {
            amount = pd.amount;
            console.log('[Callback] Amount recovered from pendingPayments:', amount);
          }
        }
      } catch (e) { /* ignore */ }
    }

    console.log('[Callback]',
      '| extRef:', extRef,
      '| checkoutId:', checkoutId,
      '| amount:', amount,
      '| ResultCode:', resultCode,
      '| body.status:', body.status,
      '| mpesa:', mpesaRef,
      '| orderId:', orderId,
      '| => finalStatus:', finalStatus
    );

    const now = Date.now();
    if (extRef) {
      paymentStore[extRef] = { status: finalStatus, amount, orderId, createdAt: existingByRef.createdAt || now, payheroRef: existingByRef.payheroRef || checkoutId || null };
    }
    if (checkoutId) {
      paymentStore[checkoutId] = { status: finalStatus, amount, orderId, createdAt: existingByCheckout.createdAt || now, payheroRef: checkoutId };
    }

    if (isSuccess && db && orderId) {
      markOrderPaid(orderId, mpesaRef, amount)
        .then(() => {
          if (extRef) db.collection('pendingPayments').doc(extRef).delete().catch(() => {});
        })
        .catch(e => console.error('[Firebase] Write failed:', e.message));
    } else if (isSuccess && !orderId) {
      // Payment succeeded but we can't find which order to credit — log for manual recovery.
      console.error('[Callback] SUCCESS but COULD NOT MATCH ORDER — extRef:', extRef, '| mpesa:', mpesaRef, '| amount:', amount);
    } else if (!isSuccess) {
      console.log('[Callback] FAILED — ResultCode:', resultCode, '| orderId:', orderId);
      if (db && orderId) {
        markOrderFailed(orderId, response.ResultDesc || 'mpesa_failed').catch(() => {});
      }
      if (db && extRef) db.collection('pendingPayments').doc(extRef).delete().catch(() => {});
    }

  } catch (e) {
    console.error('[Callback] Parse error:', e.message);
  }

  res.json({ received: true });
});

// Serve site
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => {
  console.log('[Server] Running on port', PORT);
  console.log('[Server] PayHero:', PAYHERO_AUTH_TOKEN ? 'Configured' : 'MISSING AUTH TOKEN');
  console.log('[Server] Firebase:', db ? 'Connected' : 'NOT connected');
});
