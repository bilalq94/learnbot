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
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Vercel doesn't parse body for webhooks — we need the raw body
export const config = {
  api: {
    bodyParser: false,
  },
};

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const sig = req.headers['stripe-signature'];
  if (!sig) {
    return res.status(400).json({ error: 'Missing Stripe signature' });
  }

  let event;
  try {
    const rawBody = await getRawBody(req);
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  // Handle the event
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.client_reference_id;

    if (!userId) {
      console.error('Webhook: No client_reference_id on session', session.id);
      return res.status(200).json({ received: true });
    }

    console.log(`[Webhook] Payment completed for user=${userId}, session=${session.id}`);

    try {
      // Check if this is a token purchase or Pro upgrade based on metadata
      const metadata = session.metadata || {};

      if (metadata.type === 'tokens') {
        // Token pack purchase — credit tokens
        const tokenAmount = parseInt(metadata.tokens) || 50;
        const userRef = db.collection('users').doc(userId);
        const userDoc = await userRef.get();

        if (userDoc.exists) {
          const currentTokens = userDoc.data().learnTokens || 0;
          await userRef.update({
            learnTokens: currentTokens + tokenAmount,
            updatedAt: new Date().toISOString()
          });
          console.log(`[Webhook] Credited ${tokenAmount} tokens to user=${userId}`);
        }
      } else {
        // Pro upgrade (default)
        await db.collection('users').doc(userId).update({
          isPro: true,
          upgradeDate: new Date().toISOString(),
          stripeSessionId: session.id,
          updatedAt: new Date().toISOString()
        });
        console.log(`[Webhook] Upgraded user=${userId} to Pro`);
      }

      // Log the payment for audit trail
      await db.collection('payments').doc(session.id).set({
        userId,
        type: metadata.type || 'pro',
        amount: session.amount_total,
        currency: session.currency,
        status: 'completed',
        stripeSessionId: session.id,
        customerEmail: session.customer_details?.email || '',
        createdAt: new Date().toISOString()
      });

    } catch (err) {
      console.error('Webhook: Error processing payment:', err);
      // Return 500 so Stripe retries
      return res.status(500).json({ error: 'Error processing payment' });
    }
  }

  return res.status(200).json({ received: true });
}
