import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { subscriptionEvent } from '../functions/events.js';
import { isValidSignature, endOfDay } from '../functions/billing.js';
import { createSquare, SquareError } from '../functions/square.js';
import { PLAN_CATALOG } from '../functions/scripts/setup-plans.js';

const bill = (over = {}) => ({
    active: true, status: 'active', plan: 'yearly', cancelRequested: false,
    chargedThrough: '2027-01-01', squareSubscriptionId: 'sub_1', ...over
});
const type = (before, after) => subscriptionEvent(before, after, 'u1')?.event_type ?? null;

test('events: started, renewed, cancel requested, payment failed, ended', () => {
    const started = subscriptionEvent(undefined, bill(), 'u1');
    assert.equal(started.event_type, 'subscription_started');
    assert.deepEqual(started.event_properties, { plan: 'yearly' });
    assert.equal(started.insert_id, 'u1:sub_1:subscription_started:2027-01-01');
    assert.equal(type({ squareCustomerId: 'c' }, bill()), 'subscription_started');
    assert.equal(type(bill(), bill({ chargedThrough: '2028-01-01' })), 'subscription_renewed');
    assert.equal(type(bill(), bill({ cancelRequested: true })), 'subscription_cancel_requested');
    assert.equal(type(bill(), bill({ status: 'past_due' })), 'subscription_payment_failed');
    assert.equal(type(bill(), bill({ active: false, status: 'canceled' })), 'subscription_ended');
});

test('events: nothing for unrelated edits, checkout bookkeeping or deletion', () => {
    assert.equal(type(bill(), bill()), null);
    assert.equal(type(undefined, { checkoutStartedAt: 1 }), null);
    assert.equal(type({ active: false }, { active: false, squareCustomerId: 'c' }), null);
    assert.equal(type(bill(), undefined), null);
});

test('webhook signature: accepts only the right key, url and body', () => {
    const body = '{"type":"subscription.updated"}';
    const notificationUrl = 'https://example.test/squareWebhook';
    const signatureKey = 'secret-key';
    const signature = createHmac('sha256', signatureKey).update(notificationUrl + body).digest('base64');
    const args = { body, signature, signatureKey, notificationUrl };
    assert.equal(isValidSignature(args), true);
    assert.equal(isValidSignature({ ...args, body: body + ' ' }), false);
    assert.equal(isValidSignature({ ...args, signatureKey: 'other' }), false);
    assert.equal(isValidSignature({ ...args, notificationUrl: 'https://evil.test/' }), false);
    assert.equal(isValidSignature({ ...args, signature: '' }), false);
    assert.equal(isValidSignature({ ...args, signature: 'not-base64!!' }), false);
    assert.equal(isValidSignature({ ...args, signatureKey: '' }), false);
});

test('endOfDay', () => {
    assert.equal(endOfDay('2026-12-31').toISOString(), '2026-12-31T23:59:59.999Z');
    assert.equal(endOfDay('nonsense'), null);
});

test('square client: request shape, environment host and error mapping', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
        calls.push({ url, init, body: init.body && JSON.parse(init.body) });
        if (url.endsWith('/v2/cards')) {
            return { ok: false, status: 402, json: async () => ({ errors: [{ code: 'CARD_DECLINED', detail: 'Card declined.' }] }) };
        }
        return { ok: true, status: 200, json: async () => ({ customer: { id: 'CUST' }, subscription: { id: 'SUB', status: 'ACTIVE' } }) };
    };
    const square = createSquare({ environment: 'sandbox', accessToken: 'tok', fetchImpl });

    assert.deepEqual(await square.createCustomer({ idempotencyKey: 'k', emailAddress: 'a@b.c', referenceId: 'u1' }), { id: 'CUST' });
    assert.equal(calls[0].url, 'https://connect.squareupsandbox.com/v2/customers');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer tok');
    assert.deepEqual(calls[0].body, { idempotency_key: 'k', email_address: 'a@b.c', reference_id: 'u1' });

    await square.createSubscription({ idempotencyKey: 'k', locationId: 'L', planVariationId: 'P', customerId: 'CUST', cardId: 'CARD' });
    assert.deepEqual(calls[1].body, { idempotency_key: 'k', location_id: 'L', plan_variation_id: 'P', customer_id: 'CUST', card_id: 'CARD' });

    await square.cancelSubscription('SUB/1');
    assert.equal(calls[2].url, 'https://connect.squareupsandbox.com/v2/subscriptions/SUB%2F1/cancel');

    await assert.rejects(
        square.createCard({ idempotencyKey: 'k', sourceId: 'cnon', customerId: 'CUST' }),
        (e) => e instanceof SquareError && e.message === 'Card declined.' && e.code === 'CARD_DECLINED'
    );
    assert.deepEqual(calls[3].body, { idempotency_key: 'k', source_id: 'cnon', card: { customer_id: 'CUST' } });

    assert.equal(createSquare({ environment: 'production', accessToken: 't', fetchImpl }) && true, true);
    assert.throws(() => createSquare({ environment: 'live', accessToken: 't' }));
});

test('plan catalog carries the agreed prices', () => {
    const [monthly, yearly] = PLAN_CATALOG.subscription_plan_data.subscription_plan_variations
        .map(v => v.subscription_plan_variation_data.phases[0]);
    assert.deepEqual([monthly.cadence, monthly.pricing.price_money.amount], ['MONTHLY', 399]);
    assert.deepEqual([yearly.cadence, yearly.pricing.price_money.amount], ['ANNUAL', 2999]);
});
