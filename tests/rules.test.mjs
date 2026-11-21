/**
 * Firestore rules tests. Run with `npm run test:rules` (starts the emulator).
 */
import { test, before, after, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import {
    initializeTestEnvironment,
    assertSucceeds,
    assertFails
} from '@firebase/rules-unit-testing';
import {
    doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc, getDocs,
    collection, serverTimestamp, Timestamp, writeBatch
} from 'firebase/firestore';

const DAY = 24 * 60 * 60 * 1000;
let env;

before(async () => {
    env = await initializeTestEnvironment({
        projectId: 'demo-boxes',
        firestore: { rules: readFileSync('firestore.rules', 'utf8') }
    });
});
after(async () => { await env.cleanup(); });
beforeEach(async () => { await env.clearFirestore(); });

const asUser = (uid, token = {}) => env.authenticatedContext(uid, token).firestore();

async function seed(fn) {
    await env.withSecurityRulesDisabled(ctx => fn(ctx.firestore()));
}

const trialStarted = (daysAgo) => (db) =>
    setDoc(doc(db, 'users/alice'), { trialStartedAt: Timestamp.fromMillis(Date.now() - daysAgo * DAY) });

const item = { id: 'i1', name: 'Hammer', status: 'stored' };

test('signed-out users can read and write nothing', async () => {
    const db = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, 'users/alice/items/i1')));
    await assertFails(setDoc(doc(db, 'users/alice/items/i1'), item));
});

test('a user cannot touch another user\'s inventory', async () => {
    await seed(trialStarted(1));
    await seed(db => setDoc(doc(db, 'users/alice/items/i1'), item));
    const bob = asUser('bob');
    await assertFails(getDoc(doc(bob, 'users/alice/items/i1')));
    await assertFails(getDocs(collection(bob, 'users/alice/items')));
    await assertFails(setDoc(doc(bob, 'users/alice/items/i2'), item));
    await assertFails(deleteDoc(doc(bob, 'users/alice/items/i1')));
});

test('trial start: server time only, once, and never editable', async () => {
    const db = asUser('alice');
    await assertFails(setDoc(doc(db, 'users/alice'), { trialStartedAt: Timestamp.fromMillis(Date.now() + 365 * DAY) }));
    await assertFails(setDoc(doc(db, 'users/alice'), { trialStartedAt: serverTimestamp(), extra: 1 }));
    await assertSucceeds(setDoc(doc(db, 'users/alice'), { trialStartedAt: serverTimestamp() }));
    await assertSucceeds(getDoc(doc(db, 'users/alice')));
    await assertFails(setDoc(doc(db, 'users/alice'), { trialStartedAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(db, 'users/alice'), { trialStartedAt: serverTimestamp() }));
    await assertFails(deleteDoc(doc(db, 'users/alice')));
    await assertFails(setDoc(doc(asUser('bob'), 'users/alice'), { trialStartedAt: serverTimestamp() }));
});

test('inside the trial: full access', async () => {
    await seed(trialStarted(6));
    const db = asUser('alice');
    await assertSucceeds(setDoc(doc(db, 'users/alice/items/i1'), item));
    await assertSucceeds(setDoc(doc(db, 'users/alice/containers/c1'), { id: 'c1', name: 'Bin' }));
    await assertSucceeds(updateDoc(doc(db, 'users/alice/items/i1'), { name: 'Mallet' }));
    await assertSucceeds(getDocs(collection(db, 'users/alice/items')));
});

test('no profile yet: writes are refused until the trial is started', async () => {
    await assertFails(setDoc(doc(asUser('alice'), 'users/alice/items/i1'), item));
});

test('trial expired: read-only, but export and delete still work', async () => {
    await seed(trialStarted(8));
    await seed(db => setDoc(doc(db, 'users/alice/items/i1'), item));
    const db = asUser('alice');
    await assertSucceeds(getDoc(doc(db, 'users/alice/items/i1')));
    await assertSucceeds(getDocs(collection(db, 'users/alice/items')));
    await assertFails(setDoc(doc(db, 'users/alice/items/i2'), item));
    await assertFails(updateDoc(doc(db, 'users/alice/items/i1'), { name: 'Mallet' }));
    await assertFails(setDoc(doc(db, 'users/alice/containers/c1'), { id: 'c1' }));
    const batch = writeBatch(db);
    batch.set(doc(db, 'users/alice/items/i3'), item);
    await assertFails(batch.commit());
    await assertSucceeds(deleteDoc(doc(db, 'users/alice/items/i1')));
});

const billing = (data) => (db) => setDoc(doc(db, 'billing/alice'), data);

test('subscriber: full access after the trial has ended', async () => {
    await seed(trialStarted(400));
    await seed(billing({ active: true, status: 'active', endsAt: null }));
    const db = asUser('alice');
    await assertSucceeds(setDoc(doc(db, 'users/alice/items/i1'), item));
    await assertSucceeds(updateDoc(doc(db, 'users/alice/items/i1'), { name: 'Mallet' }));
});

test('subscriber: past due keeps access while Square retries', async () => {
    await seed(trialStarted(400));
    await seed(billing({ active: true, status: 'past_due' }));
    await assertSucceeds(setDoc(doc(asUser('alice'), 'users/alice/items/i1'), item));
});

test('cancelled: access runs to the end of the paid period, then stops', async () => {
    await seed(trialStarted(400));
    await seed(billing({ active: true, cancelRequested: true, endsAt: Timestamp.fromMillis(Date.now() + DAY) }));
    await assertSucceeds(setDoc(doc(asUser('alice'), 'users/alice/items/i1'), item));

    await seed(billing({ active: true, cancelRequested: true, endsAt: Timestamp.fromMillis(Date.now() - 1000) }));
    await assertFails(setDoc(doc(asUser('alice'), 'users/alice/items/i2'), item));
    await assertSucceeds(getDoc(doc(asUser('alice'), 'users/alice/items/i1')));
});

test('ended or half-finished billing records grant nothing', async () => {
    await seed(trialStarted(400));
    for (const data of [{ active: false, status: 'canceled' }, { squareCustomerId: 'C', checkoutStartedAt: 1 }]) {
        await seed(billing(data));
        await assertFails(setDoc(doc(asUser('alice'), 'users/alice/items/i1'), item));
    }
});

test('billing record: owner can read it, nobody can write it from the app', async () => {
    await seed(billing({ active: false }));
    const db = asUser('alice');
    await assertSucceeds(getDoc(doc(db, 'billing/alice')));
    await assertFails(setDoc(doc(db, 'billing/alice'), { active: true }));
    await assertFails(updateDoc(doc(db, 'billing/alice'), { active: true }));
    await assertFails(deleteDoc(doc(db, 'billing/alice')));
    await assertFails(setDoc(doc(asUser('bob'), 'billing/bob'), { active: true }));
    await assertFails(getDoc(doc(asUser('bob'), 'billing/alice')));
    await assertFails(getDocs(collection(db, 'billing')));
});

test('business allow-list: full access, verified email only', async () => {
    await seed(trialStarted(400));
    await seed(db => setDoc(doc(db, 'comp/alice@example.com'), { note: 'client' }));
    const verified = asUser('alice', { email: 'Alice@Example.com', email_verified: true });
    await assertSucceeds(setDoc(doc(verified, 'users/alice/items/i1'), item));
    await assertSucceeds(getDoc(doc(verified, 'comp/alice@example.com')));

    const unverified = asUser('alice', { email: 'alice@example.com', email_verified: false });
    await assertFails(setDoc(doc(unverified, 'users/alice/items/i2'), item));

    const other = asUser('bob', { email: 'bob@example.com', email_verified: true });
    await assertFails(getDoc(doc(other, 'comp/alice@example.com')));
    await assertFails(getDocs(collection(other, 'comp')));
    await assertFails(setDoc(doc(other, 'comp/bob@example.com'), {}));
});

test('only items and containers exist under a user', async () => {
    await seed(trialStarted(1));
    await assertFails(setDoc(doc(asUser('alice'), 'users/alice/other/x'), { a: 1 }));
});

test('analytics preference: own, boolean only, writable even when read-only', async () => {
    await seed(trialStarted(400));
    const db = asUser('alice');
    await assertSucceeds(setDoc(doc(db, 'users/alice/prefs/analytics'), { enabled: false }));
    await assertSucceeds(setDoc(doc(db, 'users/alice/prefs/analytics'), { enabled: true }));
    await assertSucceeds(getDoc(doc(db, 'users/alice/prefs/analytics')));
    await assertFails(setDoc(doc(db, 'users/alice/prefs/analytics'), { enabled: 'yes' }));
    await assertFails(setDoc(doc(db, 'users/alice/prefs/analytics'), { enabled: true, x: 1 }));
    await assertFails(setDoc(doc(db, 'users/alice/prefs/other'), { enabled: true }));
    await assertFails(setDoc(doc(asUser('bob'), 'users/alice/prefs/analytics'), { enabled: true }));
    await assertFails(getDoc(doc(asUser('bob'), 'users/alice/prefs/analytics')));
});
