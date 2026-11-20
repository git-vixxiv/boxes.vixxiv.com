import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subscriptionEvent } from '../functions/events.js';

const sub = (over = {}) => ({
    status: 'active',
    cancel_at_period_end: false,
    current_period_start: { seconds: 1000 },
    items: [{ price: { recurring: { interval: 'year' } } }],
    ...over
});
const type = (before, after) => subscriptionEvent(before, after, 'sub_1')?.event_type ?? null;

test('new active subscription', () => {
    const e = subscriptionEvent(undefined, sub(), 'sub_1');
    assert.equal(e.event_type, 'subscription_started');
    assert.equal(e.event_properties.plan_interval, 'year');
    assert.equal(e.insert_id, 'sub_1:subscription_started:1000');
});

test('incomplete then active counts as started, once', () => {
    assert.equal(type(sub({ status: 'incomplete' }), sub()), 'subscription_started');
    assert.equal(type(undefined, sub({ status: 'incomplete' })), null);
});

test('renewal is a later billing period', () => {
    assert.equal(type(sub(), sub({ current_period_start: { seconds: 2000 } })), 'subscription_renewed');
});

test('cancel requested and reversed', () => {
    assert.equal(type(sub(), sub({ cancel_at_period_end: true })), 'subscription_cancel_requested');
    assert.equal(type(sub({ cancel_at_period_end: true }), sub()), 'subscription_cancel_reversed');
});

test('ended, with the final status', () => {
    const e = subscriptionEvent(sub(), sub({ status: 'canceled' }), 'sub_1');
    assert.equal(e.event_type, 'subscription_ended');
    assert.equal(e.event_properties.final_status, 'canceled');
    assert.equal(type(sub(), sub({ status: 'past_due' })), 'subscription_ended');
});

test('unrelated edits and deletions produce nothing', () => {
    assert.equal(type(sub(), sub()), null);
    assert.equal(type(sub({ status: 'canceled' }), sub({ status: 'canceled' })), null);
    assert.equal(type(sub(), undefined), null);
});

test('events carry no personal or inventory data', () => {
    const e = subscriptionEvent(undefined, sub({ customer_email: 'a@b.c' }), 'sub_1');
    assert.deepEqual(Object.keys(e.event_properties), ['plan_interval']);
});
