/**
 * Billing logic against a real (emulated) Firestore and a stand-in Square.
 * Run with `npm run test:rules` (inside the Firestore emulator).
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { createBilling, BillingError } from '../functions/billing.js';

let db;
before(() => {
    initializeApp({ projectId: 'demo-boxes' });
    db = getFirestore();
});
beforeEach(async () => {
    const docs = await db.collection('billing').listDocuments();
    await Promise.all(docs.map(d => d.delete()));
});

function fakeSquare(over = {}) {
    const calls = [];
    let n = 0;
    const square = {
        calls,
        async createCustomer(input) { calls.push(['createCustomer', input]); return { id: `CUST_${++n}` }; },
        async createCard(input) { calls.push(['createCard', input]); return { id: `CARD_${++n}` }; },
        async createSubscription(input) {
            calls.push(['createSubscription', input]);
            return { id: `SUB_${++n}`, status: 'ACTIVE', charged_through_date: '2026-12-21' };
        },
        async cancelSubscription(id) {
            calls.push(['cancelSubscription', id]);
            return { id, status: 'ACTIVE', canceled_date: '2026-12-21', charged_through_date: '2026-12-21' };
        },
        async getSubscription(id) {
            calls.push(['getSubscription', id]);
            return { id, status: 'ACTIVE', charged_through_date: '2027-01-21' };
        },
        ...over
    };
    return square;
}

const NOW = Date.parse('2026-11-21T12:00:00Z');
function setup({ square = fakeSquare(), now = () => NOW, config } = {}) {
    const billing = createBilling({
        db, square, now,
        config: config || { locationId: 'LOC', planVariationIds: { monthly: 'PV_M', yearly: 'PV_Y' } },
        serverTimestamp: () => FieldValue.serverTimestamp()
    });
    return { billing, square };
}
const read = async (uid) => (await db.doc(`billing/${uid}`).get()).data();
const rejects = (promise, code, pattern) => assert.rejects(promise, (e) => {
    assert.ok(e instanceof BillingError, `expected BillingError, got ${e}`);
    assert.equal(e.code, code);
    if (pattern) assert.match(e.message, pattern);
    return true;
});
const card = { uid: 'u1', email: 'pat@example.com', plan: 'yearly', token: 'cnon:ok' };

test('subscribe: creates customer, card and subscription, and records them', async () => {
    const { billing, square } = setup();
    const result = await billing.subscribe({ ...card, verificationToken: 'verf' });
    assert.equal(result.plan, 'yearly');

    const [customer, cardCall, sub] = square.calls;
    assert.equal(customer[1].referenceId, 'u1');
    assert.equal(customer[1].emailAddress, 'pat@example.com');
    assert.equal(cardCall[1].sourceId, 'cnon:ok');
    assert.equal(cardCall[1].verificationToken, 'verf');
    assert.equal(sub[1].planVariationId, 'PV_Y');
    assert.equal(sub[1].locationId, 'LOC');

    const doc = await read('u1');
    assert.equal(doc.active, true);
    assert.equal(doc.status, 'active');
    assert.equal(doc.plan, 'yearly');
    assert.equal(doc.cancelRequested, false);
    assert.equal(doc.endsAt, null);
    assert.equal(doc.chargedThrough, '2026-12-21');
    assert.equal(doc.checkoutStartedAt, null);
    assert.ok(doc.squareCustomerId && doc.squareCardId && doc.squareSubscriptionId);
});

test('subscribe: validates input and refuses when billing is not configured', async () => {
    const { billing, square } = setup();
    await rejects(billing.subscribe({ ...card, plan: 'lifetime' }), 'invalid-argument');
    await rejects(billing.subscribe({ ...card, token: '' }), 'invalid-argument');
    const unconfigured = setup({ config: { locationId: '', planVariationIds: { monthly: '', yearly: '' } } });
    await rejects(unconfigured.billing.subscribe(card), 'failed-precondition', /not open yet/);
    assert.equal(square.calls.length, 0);
    assert.equal(await read('u1'), undefined);
});

test('subscribe: a second attempt while subscribed charges nothing', async () => {
    const { billing, square } = setup();
    await billing.subscribe(card);
    const before = square.calls.length;
    await rejects(billing.subscribe(card), 'failed-precondition', /already subscribed/);
    assert.equal(square.calls.length, before);
});

test('subscribe: two taps at once produce exactly one subscription', async () => {
    const { billing, square } = setup();
    const results = await Promise.allSettled([billing.subscribe(card), billing.subscribe(card)]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(square.calls.filter(c => c[0] === 'createSubscription').length, 1);
});

test('subscribe: a declined card leaves no access and can be retried with the same customer', async () => {
    let decline = true;
    const base = fakeSquare();
    const square = fakeSquare({
        async createCard(input) {
            if (decline) {
                const e = new Error('Card declined.'); e.name = 'SquareError'; throw e;
            }
            return base.createCard(input);
        }
    });
    const { billing } = setup({ square });
    await rejects(billing.subscribe(card), 'failed-precondition', /Card declined/);
    let doc = await read('u1');
    assert.ok(!doc.active);
    assert.equal(doc.checkoutStartedAt, null);
    const customerId = doc.squareCustomerId;
    assert.ok(customerId);

    decline = false;
    await billing.subscribe(card);
    doc = await read('u1');
    assert.equal(doc.active, true);
    assert.equal(doc.squareCustomerId, customerId);
    assert.equal(square.calls.filter(c => c[0] === 'createCustomer').length, 1);
});

test('subscribe: an unexpected failure is not reported as a card problem', async () => {
    const square = fakeSquare({ async createSubscription() { throw new Error('socket hang up'); } });
    const { billing } = setup({ square });
    await assert.rejects(billing.subscribe(card), (e) => !(e instanceof BillingError));
    assert.equal((await read('u1')).checkoutStartedAt, null);
});

test('cancel: stops renewal but keeps access to the end of the paid period', async () => {
    const { billing, square } = setup();
    await billing.subscribe(card);
    const result = await billing.cancel({ uid: 'u1' });
    assert.equal(new Date(result.endsAt).toISOString(), '2026-12-21T23:59:59.999Z');

    const doc = await read('u1');
    assert.equal(doc.active, true);
    assert.equal(doc.cancelRequested, true);
    assert.equal(doc.endsAt.toDate().toISOString(), '2026-12-21T23:59:59.999Z');

    // Cancelling twice is harmless and does not call Square again.
    await billing.cancel({ uid: 'u1' });
    assert.equal(square.calls.filter(c => c[0] === 'cancelSubscription').length, 1);

    // Cannot double-pay by resubscribing while the paid period still runs...
    await rejects(billing.subscribe(card), 'failed-precondition', /still running/);
    // ...but can once it has ended, even if Square's final event never arrived.
    const later = setup({ square, now: () => Date.parse('2026-12-22T00:00:01Z') });
    await later.billing.subscribe({ ...card, plan: 'monthly' });
    const renewed = await read('u1');
    assert.equal(renewed.plan, 'monthly');
    assert.equal(renewed.cancelRequested, false);
    assert.equal(renewed.endsAt, null);
});

test('cancel: nothing to cancel', async () => {
    const { billing } = setup();
    await rejects(billing.cancel({ uid: 'nobody' }), 'failed-precondition');
});

test('webhook: Square ending the subscription ends access', async () => {
    const { billing } = setup();
    await billing.subscribe(card);
    const { squareSubscriptionId: id } = await read('u1');

    const outcome = await billing.handleEvent({
        type: 'subscription.updated',
        data: { object: { subscription: { id, status: 'DEACTIVATED' } } }
    });
    assert.deepEqual([outcome.handled, outcome.uid, outcome.effect], [true, 'u1', 'ended']);
    const doc = await read('u1');
    assert.equal(doc.active, false);
    assert.equal(doc.status, 'canceled');
});

test('webhook: failed payment flags past due but keeps access; payment clears it', async () => {
    const { billing } = setup();
    await billing.subscribe(card);
    const { squareSubscriptionId: id } = await read('u1');
    const invoice = (type) => ({ type, data: { object: { invoice: { subscription_id: id } } } });

    await billing.handleEvent(invoice('invoice.scheduled_charge_failed'));
    let doc = await read('u1');
    assert.deepEqual([doc.active, doc.status], [true, 'past_due']);

    await billing.handleEvent(invoice('invoice.payment_made'));
    doc = await read('u1');
    assert.deepEqual([doc.active, doc.status, doc.chargedThrough], [true, 'active', '2027-01-21']);
});

test('webhook: a late event for a replaced subscription cannot switch off the new one', async () => {
    const { billing, square } = setup();
    await billing.subscribe(card);
    const old = (await read('u1')).squareSubscriptionId;
    await billing.cancel({ uid: 'u1' });
    const later = setup({ square, now: () => Date.parse('2026-12-23T00:00:00Z') });
    await later.billing.subscribe(card);

    const outcome = await later.billing.handleEvent({
        type: 'subscription.updated',
        data: { object: { subscription: { id: old, status: 'CANCELED' } } }
    });
    assert.equal(outcome.handled, false);
    assert.equal((await read('u1')).active, true);
});

test('webhook: unknown subscriptions and event types are ignored', async () => {
    const { billing } = setup();
    for (const event of [
        { type: 'subscription.updated', data: { object: { subscription: { id: 'nope', status: 'CANCELED' } } } },
        { type: 'payment.created', data: {} },
        {}
    ]) {
        assert.equal((await billing.handleEvent(event)).handled, false);
    }
});
