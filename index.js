const express = require('express');
const cors = require('cors');
const axios = require('axios');
const admin = require('firebase-admin');
const dotenv = require('dotenv');
const fs = require('fs');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ─── Environment Variables Check ────────────────────────────────────
console.log('🔍 Checking environment variables...');
console.log('RAZORPAY_KEY_ID:', process.env.RAZORPAY_KEY_ID ? '✅ Set' : '❌ Missing');
console.log('RAZORPAY_KEY_SECRET:', process.env.RAZORPAY_KEY_SECRET ? '✅ Set' : '❌ Missing');
console.log('RAZORPAY_ACCOUNT_NUMBER:', process.env.RAZORPAY_ACCOUNT_NUMBER ? '✅ Set' : '❌ Missing');

if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET || !process.env.RAZORPAY_ACCOUNT_NUMBER) {
  console.error('❌ Missing Razorpay environment variables. Please check .env file.');
  process.exit(1);
}

// ─── Mock Payout Mode ────────────────────────────────────────────────
const MOCK_PAYOUTS = process.env.MOCK_PAYOUTS === 'true';
if (MOCK_PAYOUTS) {
  console.log('🧪 MOCK_PAYOUTS is ON — Razorpay calls will be simulated.');
}

// ─── Firebase Admin SDK ──────────────────────────────────────────────
let serviceAccount;
if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  try {
    const fileContent = fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8');
    serviceAccount = JSON.parse(fileContent);
    console.log('✅ Loaded service account from file.');
  } catch (e) {
    console.error('❌ Failed to read service account file:', e.message);
    process.exit(1);
  }
} else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    console.log('✅ Loaded service account from environment variable.');
  } catch (e) {
    console.error('❌ Failed to parse FIREBASE_SERVICE_ACCOUNT:', e.message);
    process.exit(1);
  }
} else {
  console.error('❌ No Firebase credentials provided.');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// ─── RazorpayX REST Client ──────────────────────────────────────────
const RAZORPAYX_BASE_URL = 'https://api.razorpay.com/v1';

const razorpayXClient = axios.create({
  baseURL: RAZORPAYX_BASE_URL,
  auth: {
    username: process.env.RAZORPAY_KEY_ID.trim(),
    password: process.env.RAZORPAY_KEY_SECRET.trim(),
  },
  timeout: 15000,
});

console.log('✅ RazorpayX REST client configured.');

const ACCOUNT_NUMBER = process.env.RAZORPAY_ACCOUNT_NUMBER.trim();

// ─── Helper: Verify Firebase ID Token ──────────────────────────────
async function verifyIdToken(idToken) {
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    return decoded;
  } catch (error) {
    throw new Error('Invalid or expired Firebase ID token');
  }
}

// ─── Helper: Refund coins after a payout that failed after being committed ──
async function refundCommittedCoins(userRef, coins, amount) {
  await userRef.update({
    totalCoins: admin.firestore.FieldValue.increment(coins),
    gameCoins: admin.firestore.FieldValue.increment(coins),
    totalWithdrawnCoins: admin.firestore.FieldValue.increment(-coins),
    totalWithdrawnAmount: admin.firestore.FieldValue.increment(-amount),
    // Note: we do not adjust the source-specific withdrawn fields here,
    // as refunds are exceptional; they can be handled manually if needed.
  });
}

// ─── Helper: Run the payout (real RazorpayX calls, or a mock) ───────
async function runPayout({ userData, phone, upiId, amount, coins, withdrawalId }) {
  if (MOCK_PAYOUTS) {
    console.log('🧪 [MOCK] Simulating payout...');
    console.log('   Amount:', amount * 100, 'paise (fake)');
    console.log('   UPI ID:', upiId);

    await new Promise((resolve) => setTimeout(resolve, 500));

    if (process.env.MOCK_FAIL_PAYOUTS === 'true') {
      const fakeError = new Error('Simulated payout failure');
      fakeError.response = {
        data: {
          error: {
            code: 'BAD_REQUEST_ERROR',
            description: 'Mock failure — MOCK_FAIL_PAYOUTS is enabled',
          },
        },
      };
      throw fakeError;
    }

    const mockId = `mock_payout_${Date.now()}`;
    console.log('   [MOCK] Payout "created":', mockId);
    return { id: mockId };
  }

  // ── Real RazorpayX calls ──
  console.log('💸 Initiating Razorpay payout...');
  console.log('   Account:', ACCOUNT_NUMBER);
  console.log('   Amount:', amount * 100, 'paise');
  console.log('   UPI ID:', upiId);

  const { data: contact } = await razorpayXClient.post('/contacts', {
    name: userData.displayName || 'User',
    email: userData.email || '',
    contact: phone || '9999999999',
    type: 'customer',
    reference_id: userData.uid,
  });
  console.log('   Contact created:', contact.id);

  const { data: fundAccount } = await razorpayXClient.post('/fund_accounts', {
    contact_id: contact.id,
    account_type: 'vpa',
    vpa: { address: upiId },
  });
  console.log('   Fund account created:', fundAccount.id);

  const { data: payout } = await razorpayXClient.post('/payouts', {
    account_number: ACCOUNT_NUMBER,
    fund_account_id: fundAccount.id,
    amount: amount * 100,
    currency: 'INR',
    mode: 'UPI',
    purpose: 'payout',
    queue_if_low_balance: true,
    reference_id: withdrawalId,
    narration: `Withdrawal ${coins} coins`,
  });
  console.log('   Payout created:', payout.id);

  return payout;
}

// ─── Health Check ─────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Withdrawal Endpoint ─────────────────────────────────────────────
app.post('/api/withdraw', async (req, res) => {
  try {
    const { idToken, coins, amount, upiId, phone, source } = req.body;

    if (!idToken || !coins || !amount || !upiId || !source) {
      return res.status(400).json({ error: 'Missing required fields (idToken, coins, amount, upiId, source)' });
    }

    if (source !== 'game' && source !== 'referral') {
      return res.status(400).json({ error: 'Invalid source. Must be "game" or "referral".' });
    }

    let decoded;
    try {
      decoded = await verifyIdToken(idToken);
    } catch (error) {
      return res.status(401).json({ error: 'Authentication failed: ' + error.message });
    }
    const uid = decoded.uid;

    const userRef = db.collection('users').doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      return res.status(404).json({ error: 'User not found' });
    }
    const userData = userSnap.data();

    const expectedAmount = coins / 100;
    if (Math.abs(expectedAmount - amount) > 0.01) {
      return res.status(400).json({ error: `Amount mismatch. Expected ₹${expectedAmount.toFixed(2)}` });
    }

    // 1. Reserve the coins (atomic hold)
    try {
      await db.runTransaction(async (transaction) => {
        const snap = await transaction.get(userRef);
        const data = snap.data();
        const currentGameCoins = data.gameCoins || 0;
        const currentlyReserved = data.pendingWithdrawalCoins || 0;
        const available = currentGameCoins - currentlyReserved;

        if (available < coins) {
          throw new Error(`Insufficient game coins. Available: ${available}`);
        }

        transaction.update(userRef, {
          pendingWithdrawalCoins: admin.firestore.FieldValue.increment(coins),
        });
      });
    } catch (reserveError) {
      return res.status(400).json({ error: reserveError.message });
    }

    // 2. Create withdrawal document (status: pending — includes source)
    const withdrawalRef = db.collection('withdrawals').doc();
    const withdrawalId = withdrawalRef.id;
    await withdrawalRef.set({
      id: withdrawalId,
      uid,
      displayName: userData.displayName || '',
      email: userData.email || '',
      upiId,
      phone: phone || '',
      coins,
      amount,
      source, // ← stores the source
      status: 'pending',
      paymentMode: 'UPI',
      transactionId: '',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      completedAt: null,
      error: null,
    });

    // 3. Initiate Razorpay Payout
    try {
      const payout = await runPayout({
        userData: { ...userData, uid },
        phone,
        upiId,
        amount,
        coins,
        withdrawalId,
      });

      // ─── Commit balance change ─────────────────────────────────────────
      // Determine which withdrawn field to increment based on source
      const withdrawnField = source === 'game' 
        ? 'totalWithdrawnGameCoins' 
        : 'totalWithdrawnReferralCoins';

      await db.runTransaction(async (transaction) => {
        transaction.update(userRef, {
          pendingWithdrawalCoins: admin.firestore.FieldValue.increment(-coins),
          totalCoins: admin.firestore.FieldValue.increment(-coins),
          gameCoins: admin.firestore.FieldValue.increment(-coins),
          totalWithdrawnCoins: admin.firestore.FieldValue.increment(coins),
          totalWithdrawnAmount: admin.firestore.FieldValue.increment(amount),
          // ✅ Increment the source-specific withdrawn field
          [withdrawnField]: admin.firestore.FieldValue.increment(coins),
          lastWithdrawalAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      });

      await withdrawalRef.update({
        transactionId: payout.id,
        status: 'processing',
      });

      res.json({
        success: true,
        withdrawalId,
        payoutId: payout.id,
        message: 'Withdrawal initiated successfully',
      });

    } catch (razorpayError) {
      const errMessage =
        razorpayError.response?.data?.error?.description ||
        razorpayError.message ||
        'Razorpay payout failed';

      console.error('❌ Razorpay error:', errMessage);
      if (razorpayError.response?.data) {
        console.error('   Details:', JSON.stringify(razorpayError.response.data));
      }

      // Release the reservation (no coins were deducted)
      try {
        await userRef.update({
          pendingWithdrawalCoins: admin.firestore.FieldValue.increment(-coins),
        });
      } catch (releaseError) {
        console.error('🚨 CRITICAL: Failed to release coin reservation!', releaseError.message);
      }

      await withdrawalRef.update({
        status: 'failed',
        error: errMessage,
      });

      return res.status(500).json({
        error: `Payout initiation failed: ${errMessage}. No coins were deducted.`,
      });
    }

  } catch (error) {
    console.error('❌ Withdrawal error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── Webhook ──────────────────────────────────────────────────────────
app.post('/webhook/razorpay', async (req, res) => {
  const event = req.body;
  if (event && event.entity === 'payout') {
    const payout = event.payload.payout.entity;
    const withdrawalId = payout.reference_id;
    const status = payout.status;

    try {
      const withdrawalRef = db.collection('withdrawals').doc(withdrawalId);
      const withdrawalSnap = await withdrawalRef.get();

      await withdrawalRef.update({
        status: status === 'processed' ? 'success' : 'failed',
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
        error: status !== 'processed' ? payout.failure_reason : null,
      });

      // Refund if the payout was later reversed/failed after we committed
      const terminalFailureStatuses = ['reversed', 'rejected', 'cancelled', 'failed'];
      if (terminalFailureStatuses.includes(status) && withdrawalSnap.exists) {
        const w = withdrawalSnap.data();
        if (!w.refunded) {
          const userRef = db.collection('users').doc(w.uid);
          await refundCommittedCoins(userRef, w.coins, w.amount);
          await withdrawalRef.update({ refunded: true });
          console.log(`   ↩️  Coins refunded via webhook for withdrawal ${withdrawalId}`);
        }
      }

      res.status(200).send('OK');
    } catch (error) {
      console.error('Webhook update error:', error);
      res.status(500).send('Internal error');
    }
  } else {
    res.status(200).send('Event ignored');
  }
});

// ─── Start Server ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Withdrawal server running on port ${PORT}`);
  console.log(`📡 Health check: http://localhost:${PORT}/health`);
});