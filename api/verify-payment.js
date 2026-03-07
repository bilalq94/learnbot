import Stripe from 'stripe';
import admin from 'firebase-admin';

// Initialize Firebase Admin
if (!admin.apps.length) {
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_KEY
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)
    : null;

  admin.initializeApp(
    serviceAccount
      ? { credential: admin.credential.cert(serviceAccount) }
      : { projectId: process.env.FIREBASE_PROJECT_ID || 'learnbot-93edf' }
  );
}

const db = admin.firestore();

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Verify Firebase auth token
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  let verifiedUid;
  try {
    const token = authHeader.split('Bearer ')[1];
    const decoded = await admin.auth().verifyIdToken(token);
    verifiedUid = decoded.uid;
  } catch (err) {
    console.error('Auth verification failed:', err.message);
    return res.status(401).json({ error: 'Invalid auth token' });
  }

  // Check if user is already Pro
  const userDoc = await db.collection('users').doc(verifiedUid).get();
  if (userDoc.exists && userDoc.data().isPro) {
    return res.status(200).json({ isPro: true, alreadyPro: true });
  }

  // Check Stripe for completed checkout sessions for this user
  if (!process.env.STRIPE_SECRET_KEY) {
    console.error('STRIPE_SECRET_KEY not configured');
    return res.status(500).json({ error: 'Payment verification not configured' });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  try {
    // Search for completed checkout sessions with this user's client_reference_id
    const sessions = await stripe.checkout.sessions.list({
      limit: 10,
    });

    const userSession = sessions.data.find(
      s => s.client_reference_id === verifiedUid
        && s.payment_status === 'paid'
    );

    if (!userSession) {
      return res.status(200).json({ isPro: false, message: 'No completed payment found' });
    }

    // Payment confirmed — check if it's a token purchase or Pro upgrade
    const metadata = userSession.metadata || {};

    if (metadata.type === 'tokens') {
      const tokenAmount = parseInt(metadata.tokens) || 50;
      const currentTokens = userDoc.exists ? (userDoc.data().learnTokens || 0) : 0;

      // Check if we already credited this session
      const paymentDoc = await db.collection('payments').doc(userSession.id).get();
      if (paymentDoc.exists) {
        return res.status(200).json({ isPro: false, tokensAdded: false, message: 'Already credited' });
      }

      await db.collection('users').doc(verifiedUid).update({
        learnTokens: currentTokens + tokenAmount,
        updatedAt: new Date().toISOString()
      });

      await db.collection('payments').doc(userSession.id).set({
        userId: verifiedUid,
        type: 'tokens',
        tokens: tokenAmount,
        amount: userSession.amount_total,
        currency: userSession.currency,
        status: 'completed',
        stripeSessionId: userSession.id,
        createdAt: new Date().toISOString()
      });

      return res.status(200).json({ isPro: false, tokensAdded: true, tokens: tokenAmount });
    }

    // Pro upgrade — check if already processed
    const paymentDoc = await db.collection('payments').doc(userSession.id).get();
    if (!paymentDoc.exists) {
      await db.collection('users').doc(verifiedUid).update({
        isPro: true,
        upgradeDate: new Date().toISOString(),
        stripeSessionId: userSession.id,
        updatedAt: new Date().toISOString()
      });

      await db.collection('payments').doc(userSession.id).set({
        userId: verifiedUid,
        type: 'pro',
        amount: userSession.amount_total,
        currency: userSession.currency,
        status: 'completed',
        stripeSessionId: userSession.id,
        createdAt: new Date().toISOString()
      });
    }

    return res.status(200).json({ isPro: true });

  } catch (err) {
    console.error('Stripe verification error:', err);
    return res.status(500).json({ error: 'Payment verification failed' });
  }
}
