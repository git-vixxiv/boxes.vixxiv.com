/**
 * Boxes - entitlement (trial, subscription, business allow-list).
 *
 * Reads three things for the signed-in user and reduces them to one answer:
 *   users/{uid}.trialStartedAt            set once, by the server clock
 *   customers/{uid}/subscriptions         written by the Stripe extension
 *   comp/{email}                          business users who skip the paywall
 */

import {
    doc,
    getDoc,
    setDoc,
    addDoc,
    collection,
    query,
    where,
    onSnapshot,
    serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';
import {
    getFunctions,
    httpsCallable
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js';

import { BILLING, isBillingConfigured } from './billing-config.js';
import { computeEntitlement, ACTIVE_SUBSCRIPTION_STATUSES } from './entitlement-core.js';

const LOADING = { state: 'loading', canWrite: true, trialDaysLeft: null, trialEndsAt: null };
const CHECKOUT_TIMEOUT_MS = 30000;

class Entitlement {
    constructor() {
        this.current = LOADING;
        this.trialJustStarted = false;
        this._reset();
    }

    _reset() {
        this.app = null;
        this.db = null;
        this.user = null;
        this.onChange = null;
        this.trialStartedAt = null;
        this.subscriptionStatus = null;
        this.comped = false;
        if (this._unsubscribe) this._unsubscribe();
        this._unsubscribe = null;
        clearInterval(this._timer);
        this._timer = null;
    }

    /**
     * Begin tracking entitlement for a signed-in user.
     * onChange(current, previous) fires whenever the answer changes.
     */
    async start({ app, db, user, onChange }) {
        this.stop();
        this.app = app;
        this.db = db;
        this.user = user;
        this.onChange = onChange;

        const session = user.uid;
        const stillCurrent = () => this.user && this.user.uid === session;

        this._watchSubscription();
        // The trial runs on a clock, so re-check while the app stays open.
        this._timer = setInterval(() => this._recompute(), 60000);

        const [trialStartedAt, comped] = await Promise.all([
            this._loadTrialStart().catch(err => {
                console.error('Could not load trial state:', err);
                return null;
            }),
            this._loadComped().catch(() => false)
        ]);
        if (!stillCurrent()) return;

        this.trialStartedAt = trialStartedAt;
        this.comped = comped;
        this._recompute();
    }

    stop() {
        this._reset();
        this.trialJustStarted = false;
        this.current = LOADING;
    }

    async _loadTrialStart() {
        const ref = doc(this.db, 'users', this.user.uid);
        let snap = await getDoc(ref);
        if (!snap.exists()) {
            // First sign-in: the server stamps the start time and the rules
            // refuse any later change, so the trial cannot be restarted.
            await setDoc(ref, { trialStartedAt: serverTimestamp() });
            this.trialJustStarted = true;
            snap = await getDoc(ref);
        }
        const started = snap.data()?.trialStartedAt;
        return started ? started.toMillis() : null;
    }

    async _loadComped() {
        const email = (this.user.email || '').toLowerCase();
        if (!email || !this.user.emailVerified) return false;
        const snap = await getDoc(doc(this.db, 'comp', email));
        return snap.exists();
    }

    _watchSubscription() {
        const subs = query(
            collection(this.db, 'customers', this.user.uid, 'subscriptions'),
            where('status', 'in', ACTIVE_SUBSCRIPTION_STATUSES)
        );
        this._unsubscribe = onSnapshot(subs, async (snap) => {
            const status = snap.empty ? null : snap.docs[0].data().status;
            if (status === this.subscriptionStatus) return;
            this.subscriptionStatus = status;
            // The server checks a claim on the sign-in token; refresh it so a
            // new subscriber can save straight away.
            try {
                await this.user.getIdToken(true);
            } catch (err) {
                console.warn('Token refresh failed:', err);
            }
            this._recompute();
        }, (err) => {
            // Billing not installed yet, or offline: treat as no subscription.
            console.warn('Subscription status unavailable:', err.code || err.message);
        });
    }

    _recompute() {
        if (!this.user) return;
        const previous = this.current;
        this.current = computeEntitlement({
            now: Date.now(),
            trialStartedAt: this.trialStartedAt,
            subscriptionStatus: this.subscriptionStatus,
            comped: this.comped,
            trialDays: BILLING.trialDays
        });
        const changed = previous.state !== this.current.state
            || previous.trialDaysLeft !== this.current.trialDaysLeft;
        if (changed && this.onChange) this.onChange(this.current, previous);
    }

    /**
     * Send the user to Stripe Checkout for a plan ("monthly" or "yearly").
     * Resolves once the browser has been pointed at Stripe.
     */
    async startCheckout(planKey) {
        if (!this.user) throw new Error('Please sign in first.');
        if (!isBillingConfigured()) {
            throw new Error('Subscriptions are not open yet. Please check back soon.');
        }
        const plan = BILLING.plans[planKey];
        if (!plan) throw new Error('Unknown plan.');

        const base = window.location.origin + window.location.pathname;
        const sessionRef = await addDoc(
            collection(this.db, 'customers', this.user.uid, 'checkout_sessions'),
            {
                price: plan.stripePriceId,
                success_url: `${base}?checkout=success`,
                cancel_url: `${base}?checkout=cancelled`,
                allow_promotion_codes: true
            }
        );

        return new Promise((resolve, reject) => {
            let unsubscribe = () => {};
            const timer = setTimeout(() => {
                unsubscribe();
                reject(new Error('Checkout is taking too long. Please try again.'));
            }, CHECKOUT_TIMEOUT_MS);

            unsubscribe = onSnapshot(sessionRef, (snap) => {
                const { error, url } = snap.data() || {};
                if (error) {
                    clearTimeout(timer);
                    unsubscribe();
                    reject(new Error(error.message || 'Checkout could not be started.'));
                } else if (url) {
                    clearTimeout(timer);
                    unsubscribe();
                    window.location.assign(url);
                    resolve();
                }
            }, (err) => {
                clearTimeout(timer);
                reject(err);
            });
        });
    }

    /**
     * Open Stripe's customer portal (update card, cancel, invoices).
     */
    async openPortal() {
        if (!this.user) throw new Error('Please sign in first.');
        const functions = getFunctions(this.app, BILLING.functionsRegion);
        const createPortalLink = httpsCallable(
            functions,
            'ext-firestore-stripe-payments-createPortalLink'
        );
        const { data } = await createPortalLink({ returnUrl: window.location.href });
        window.location.assign(data.url);
    }
}

export const entitlement = new Entitlement();
