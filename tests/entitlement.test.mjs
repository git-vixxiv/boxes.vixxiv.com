import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeEntitlement } from '../entitlement-core.js';

const DAY = 24 * 60 * 60 * 1000;
const now = Date.UTC(2026, 10, 20);
const base = { now, trialDays: 7, trialStartedAt: null, subscriptionStatus: null, comped: false };
const run = (over) => computeEntitlement({ ...base, ...over });

test('unknown trial start is "loading" and leaves the UI open', () => {
    assert.deepEqual(run({}), { state: 'loading', canWrite: true, trialDaysLeft: null, trialEndsAt: null });
});

test('trial counts down in whole days', () => {
    assert.equal(run({ trialStartedAt: now }).trialDaysLeft, 7);
    assert.equal(run({ trialStartedAt: now - 1 }).trialDaysLeft, 7);
    assert.equal(run({ trialStartedAt: now - DAY }).trialDaysLeft, 6);
    assert.equal(run({ trialStartedAt: now - 6.5 * DAY }).trialDaysLeft, 1);
    assert.equal(run({ trialStartedAt: now - 6.5 * DAY }).state, 'trial');
});

test('trial ends exactly at 7 days', () => {
    const justInside = run({ trialStartedAt: now - 7 * DAY + 1 });
    assert.equal(justInside.state, 'trial');
    assert.equal(justInside.canWrite, true);
    const atEnd = run({ trialStartedAt: now - 7 * DAY });
    assert.equal(atEnd.state, 'expired');
    assert.equal(atEnd.canWrite, false);
});

test('an active or trialing subscription outranks an expired trial', () => {
    for (const subscriptionStatus of ['active', 'trialing']) {
        const r = run({ trialStartedAt: now - 100 * DAY, subscriptionStatus });
        assert.equal(r.state, 'subscribed');
        assert.equal(r.canWrite, true);
    }
});

test('lapsed subscription statuses do not grant access', () => {
    for (const subscriptionStatus of ['past_due', 'canceled', 'unpaid', 'incomplete']) {
        assert.equal(run({ trialStartedAt: now - 100 * DAY, subscriptionStatus }).state, 'expired');
    }
});

test('allow-listed users always have access', () => {
    const r = run({ trialStartedAt: now - 100 * DAY, comped: true });
    assert.equal(r.state, 'comped');
    assert.equal(r.canWrite, true);
});
