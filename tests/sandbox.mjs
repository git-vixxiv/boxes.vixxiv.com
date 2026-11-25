/**
 * Live check against Square SANDBOX: a real customer, card, subscription and
 * cancellation through the same code the functions run. Not part of
 * `npm test`; it needs a sandbox access token and creates sandbox records.
 *
 *   SQUARE_ACCESS_TOKEN=... SQUARE_LOCATION_ID=... \
 *   SQUARE_PLAN_MONTHLY=... SQUARE_PLAN_YEARLY=... \
 *   SANDBOX_TEST_EMAIL=someone@a-real-domain npm run test:sandbox
 *
 * The email must be at a real domain. Square deactivates a subscription
 * within seconds when the customer's address is at a placeholder domain such
 * as example.com, before taking any payment.
 */
import assert from 'node:assert/strict';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { createBilling, BillingError } from '../functions/billing.js';
import { createSquare } from '../functions/square.js';

const need = (name) => {
    if (!process.env[name]) throw new Error(`Set ${name}`);
    return process.env[name];
};

initializeApp({ projectId: 'demo-boxes' });
const db = getFirestore();
const square = createSquare({ environment: 'sandbox', accessToken: need('SQUARE_ACCESS_TOKEN') });
const billing = createBilling({
    db, square,
    config: {
        locationId: need('SQUARE_LOCATION_ID'),
        planVariationIds: { monthly: need('SQUARE_PLAN_MONTHLY'), yearly: need('SQUARE_PLAN_YEARLY') }
    },
    serverTimestamp: () => FieldValue.serverTimestamp()
});
const read = async (uid) => (await db.doc(`billing/${uid}`).get()).data();
const run = Date.now();
const email = need('SANDBOX_TEST_EMAIL');

// 1. A declined card: Square's own message comes back, no access granted.
const declinedUid = `sandbox-declined-${run}`;
await assert.rejects(
    billing.subscribe({ uid: declinedUid, email, plan: 'monthly', token: 'cnon:card-nonce-declined' }),
    (e) => { console.log('declined card ->', e.code, '|', e.message); return e instanceof BillingError; }
);
assert.ok(!(await read(declinedUid)).active);

// 2. A good card on each plan.
for (const plan of ['monthly', 'yearly']) {
    const uid = `sandbox-${plan}-${run}`;
    await billing.subscribe({ uid, email, plan, token: 'cnon:card-nonce-ok' });
    const doc = await read(uid);
    assert.equal(doc.active, true);
    assert.equal(doc.plan, plan);
    const live = await square.getSubscription(doc.squareSubscriptionId);
    console.log(`${plan} subscribed ->`, live.status, '| charged through', live.charged_through_date,
        '| price', live.price_override_money?.amount ?? '(plan price)', '| plan variation', live.plan_variation_id);
    assert.equal(live.plan_variation_id, process.env[`SQUARE_PLAN_${plan.toUpperCase()}`]);

    // 3. A second attempt charges nothing.
    await assert.rejects(
        billing.subscribe({ uid, email, plan, token: 'cnon:card-nonce-ok' }),
        (e) => e instanceof BillingError && /already subscribed/.test(e.message)
    );

    // Square takes the first payment a moment after the subscription is
    // created; the paid-through date appears once it has.
    let paid = live;
    for (let i = 0; i < 30 && !paid.charged_through_date; i++) {
        await new Promise(r => setTimeout(r, 4000));
        paid = await square.getSubscription(doc.squareSubscriptionId);
    }
    console.log(`${plan} first payment ->`, paid.charged_through_date
        ? `paid through ${paid.charged_through_date}` : 'NOT yet taken after 2 minutes');

    // 4. Cancel: renewal stops, access runs to the end of the paid period.
    const { endsAt } = await billing.cancel({ uid });
    const after = await read(uid);
    const cancelled = await square.getSubscription(doc.squareSubscriptionId);
    console.log(`${plan} cancelled  ->`, cancelled.status, '| canceled_date', cancelled.canceled_date,
        '| access ends', new Date(endsAt).toISOString());
    assert.equal(after.cancelRequested, true);
    assert.ok(cancelled.canceled_date, 'Square reports the end date');
    if (paid.charged_through_date) {
        assert.equal(cancelled.status, 'ACTIVE');
        assert.equal(cancelled.canceled_date, paid.charged_through_date);
        assert.equal(after.active, true);
        assert.ok(endsAt > Date.now(), 'access continues past now');
    }

    // 5. Square's own record, replayed as the webhook would deliver it.
    const outcome = await billing.handleEvent({ type: 'subscription.updated', data: { object: { subscription: cancelled } } });
    assert.equal(outcome.handled, true);
    assert.equal((await read(uid)).cancelRequested, true);
}

// 6. Cancelling before the first payment has been taken ends it at once.
{
    const uid = `sandbox-early-${run}`;
    await billing.subscribe({ uid, email, plan: 'monthly', token: 'cnon:card-nonce-ok' });
    await billing.cancel({ uid });
    const doc = await read(uid);
    const sub = await square.getSubscription(doc.squareSubscriptionId);
    console.log('cancel before first payment ->', sub.status, '| our record active:', doc.active);
    assert.equal(doc.active, sub.status === 'ACTIVE');
}
console.log('Sandbox check passed.');
