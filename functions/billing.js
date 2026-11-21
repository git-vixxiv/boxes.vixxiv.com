/**
 * Boxes billing: subscribe, cancel, and reconcile Square's webhook events.
 *
 * Everything is recorded on one server-owned document per user:
 *
 *   billing/{uid} = {
 *     active            true while the user should have full access
 *     status            "active" | "past_due" | "canceled"
 *     plan              "monthly" | "yearly"
 *     cancelRequested   true once the user has cancelled but the paid period runs on
 *     endsAt            when access stops after a cancellation (else null)
 *     chargedThrough    "YYYY-MM-DD" the current paid period runs to
 *     squareCustomerId, squareCardId, squareSubscriptionId
 *   }
 *
 * firestore.rules reads `active` and `endsAt`; the browser can read the
 * document but never write it.
 *
 * No Firebase Functions or network imports here: the database, the Square
 * client and the clock are passed in, so this is tested directly.
 */

import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';

export const PLANS = ['monthly', 'yearly'];
const PENDING_WINDOW_MS = 2 * 60 * 1000;

export class BillingError extends Error {
    /** code is a Firebase HttpsError code. */
    constructor(code, message) {
        super(message);
        this.name = 'BillingError';
        this.code = code;
    }
}

/** "2026-12-31" -> the last millisecond of that day, UTC. */
export function endOfDay(dateString) {
    const ms = Date.parse(`${dateString}T23:59:59.999Z`);
    return Number.isNaN(ms) ? null : new Date(ms);
}

/**
 * Square signs each webhook: base64(HMAC-SHA256(key, notificationUrl + body)).
 */
export function isValidSignature({ body, signature, signatureKey, notificationUrl }) {
    if (!signature || !signatureKey || !notificationUrl) return false;
    const expected = createHmac('sha256', signatureKey)
        .update(notificationUrl + body)
        .digest();
    let given;
    try {
        given = Buffer.from(signature, 'base64');
    } catch (e) {
        return false;
    }
    return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The part of a Square subscription that Boxes keeps. */
function fromSubscription(sub) {
    const status = String(sub.status || '').toUpperCase();
    const live = status === 'ACTIVE' || status === 'PENDING';
    const endsAt = sub.canceled_date ? endOfDay(sub.canceled_date) : null;
    return {
        active: live,
        status: live ? 'active' : 'canceled',
        cancelRequested: live && !!sub.canceled_date,
        endsAt: live ? endsAt : null,
        chargedThrough: sub.charged_through_date || null
    };
}

export function createBilling({ db, square, config, serverTimestamp, now = () => Date.now(), uuid = randomUUID }) {
    const ref = (uid) => db.collection('billing').doc(uid);
    const stamp = () => ({ updatedAt: serverTimestamp() });

    function isLive(billing) {
        if (!billing?.active) return false;
        const endsAt = billing.endsAt?.toMillis?.() ?? null;
        return endsAt === null || now() < endsAt;
    }

    /** One checkout at a time per user, so a double tap cannot double charge. */
    async function claimCheckout(uid) {
        await db.runTransaction(async (tx) => {
            const snap = await tx.get(ref(uid));
            const billing = snap.data() || {};
            if (isLive(billing)) {
                throw new BillingError('failed-precondition', billing.cancelRequested
                    ? 'Your subscription is still running. You can subscribe again once it ends.'
                    : 'You are already subscribed.');
            }
            if (billing.checkoutStartedAt && now() - billing.checkoutStartedAt < PENDING_WINDOW_MS) {
                throw new BillingError('aborted', 'A payment is already in progress. Please wait a moment.');
            }
            tx.set(ref(uid), { checkoutStartedAt: now() }, { merge: true });
        });
    }

    async function subscribe({ uid, email, plan, token, verificationToken }) {
        if (!PLANS.includes(plan)) {
            throw new BillingError('invalid-argument', 'Plan must be monthly or yearly.');
        }
        if (!token || typeof token !== 'string') {
            throw new BillingError('invalid-argument', 'Missing card details.');
        }
        const planVariationId = config.planVariationIds[plan];
        if (!planVariationId || !config.locationId) {
            throw new BillingError('failed-precondition', 'Subscriptions are not open yet.');
        }

        await claimCheckout(uid);

        try {
            const existing = (await ref(uid).get()).data() || {};
            let customerId = existing.squareCustomerId || null;
            if (!customerId) {
                const customer = await square.createCustomer({
                    idempotencyKey: uuid(),
                    emailAddress: email || undefined,
                    referenceId: uid
                });
                customerId = customer.id;
                // Saved straight away so a later failure does not orphan the customer.
                await ref(uid).set({ squareCustomerId: customerId }, { merge: true });
            }

            const card = await square.createCard({
                idempotencyKey: uuid(),
                sourceId: token,
                verificationToken,
                customerId
            });

            const subscription = await square.createSubscription({
                idempotencyKey: uuid(),
                locationId: config.locationId,
                planVariationId,
                customerId,
                cardId: card.id
            });

            await ref(uid).set({
                ...fromSubscription(subscription),
                plan,
                squareCustomerId: customerId,
                squareCardId: card.id,
                squareSubscriptionId: subscription.id,
                checkoutStartedAt: null,
                ...stamp()
            }, { merge: true });

            return { plan, subscriptionId: subscription.id };
        } catch (error) {
            await ref(uid).set({ checkoutStartedAt: null }, { merge: true });
            if (error instanceof BillingError) throw error;
            if (error?.name === 'SquareError') {
                // Square's own wording for declines ("Card declined.", etc).
                throw new BillingError('failed-precondition', error.message);
            }
            throw error;
        }
    }

    /** Stops renewal. Access continues to the end of the period already paid for. */
    async function cancel({ uid }) {
        const billing = (await ref(uid).get()).data() || {};
        if (!billing.squareSubscriptionId || !isLive(billing)) {
            throw new BillingError('failed-precondition', 'There is no active subscription to cancel.');
        }
        if (billing.cancelRequested) {
            return { endsAt: billing.endsAt?.toMillis?.() ?? null };
        }

        const subscription = await square.cancelSubscription(billing.squareSubscriptionId);
        const next = fromSubscription(subscription);
        // Square should always name the end date; if it does not, end now
        // rather than leave an unbilled subscription open-ended.
        const endsAt = next.endsAt || new Date(now());
        await ref(uid).set({
            active: next.active,
            status: next.status,
            cancelRequested: true,
            endsAt,
            chargedThrough: next.chargedThrough || billing.chargedThrough || null,
            ...stamp()
        }, { merge: true });
        return { endsAt: endsAt.getTime() };
    }

    async function findBySubscription(subscriptionId) {
        if (!subscriptionId) return null;
        const found = await db.collection('billing')
            .where('squareSubscriptionId', '==', subscriptionId).limit(1).get();
        return found.empty ? null : found.docs[0];
    }

    /**
     * Apply one Square webhook event. Events for a subscription that is not
     * the user's current one (an old, replaced subscription) are ignored, so
     * a late "canceled" for the old one cannot switch off the new one.
     */
    async function handleEvent(event) {
        const type = event?.type || '';
        const object = event?.data?.object || {};

        if (type === 'subscription.created' || type === 'subscription.updated') {
            const sub = object.subscription || {};
            const doc = await findBySubscription(sub.id);
            if (!doc) return { handled: false, type };
            const next = fromSubscription(sub);
            await doc.ref.set({ ...next, ...stamp() }, { merge: true });
            return { handled: true, type, uid: doc.id, effect: next.active ? 'active' : 'ended' };
        }

        if (type === 'invoice.payment_made') {
            const doc = await findBySubscription(object.invoice?.subscription_id);
            if (!doc) return { handled: false, type };
            const patch = { status: 'active' };
            // Pick up the new paid-through date for the renewal.
            try {
                const sub = await square.getSubscription(doc.data().squareSubscriptionId);
                Object.assign(patch, fromSubscription(sub));
            } catch (e) { /* the subscription.updated event will carry it */ }
            await doc.ref.set({ ...patch, ...stamp() }, { merge: true });
            return { handled: true, type, uid: doc.id, effect: 'paid' };
        }

        if (type === 'invoice.scheduled_charge_failed' || type === 'invoice.payment_failed') {
            const doc = await findBySubscription(object.invoice?.subscription_id);
            if (!doc) return { handled: false, type };
            // Access is kept while Square retries. If the retries run out,
            // Square deactivates the subscription and that event ends access.
            await doc.ref.set({ status: 'past_due', ...stamp() }, { merge: true });
            return { handled: true, type, uid: doc.id, effect: 'past_due' };
        }

        return { handled: false, type };
    }

    return { subscribe, cancel, handleEvent };
}
