/**
 * Boxes - entitlement (trial, subscription, business allow-list).
 *
 * Reads three things for the signed-in user and reduces them to one answer:
 *   users/{uid}.trialStartedAt   set once, by the server clock
 *   billing/{uid}                subscription state, written by Cloud Functions
 *   comp/{email}                 business users who skip the paywall
 *
 * Payments go through Square: the card form is Square's, the card number
 * never reaches this app, and the charge is made by a Cloud Function.
 */

import {
    doc,
    getDoc,
    setDoc,
    onSnapshot,
    serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';
import {
    getFunctions,
    httpsCallable
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js';

import { BILLING, isBillingConfigured } from './billing-config.js';
import { computeEntitlement } from './entitlement-core.js';

const LOADING = { state: 'loading', canWrite: true, trialDaysLeft: null, trialEndsAt: null };

const SQUARE_SDK = {
    sandbox: 'https://sandbox.web.squarecdn.com/v1/square.js',
    production: 'https://web.squarecdn.com/v1/square.js'
};

let squareSdkLoading = null;
function loadSquareSdk() {
    if (window.Square) return Promise.resolve(window.Square);
    if (!squareSdkLoading) {
        squareSdkLoading = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = SQUARE_SDK[BILLING.square.environment];
            script.onload = () => resolve(window.Square);
            script.onerror = () => {
                squareSdkLoading = null;
                reject(new Error('Could not load the payment form. Check your connection and try again.'));
            };
            document.head.appendChild(script);
        });
    }
    return squareSdkLoading;
}

class Entitlement {
    constructor() {
        this.current = LOADING;
        this.billing = null;
        this.trialJustStarted = false;
        this.card = null;
        this._reset();
    }

    _reset() {
        this.app = null;
        this.db = null;
        this.user = null;
        this.onChange = null;
        this.trialStartedAt = null;
        this.comped = false;
        this.billing = null;
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

        this._watchBilling();
        // The trial and a cancelled subscription both run on a clock, so
        // re-check while the app stays open.
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
        this.destroyCardForm();
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

    _watchBilling() {
        this._unsubscribe = onSnapshot(doc(this.db, 'billing', this.user.uid), (snap) => {
            this.billing = snap.exists() ? snap.data() : null;
            this._recompute(true);
        }, (err) => {
            // Offline, or rules not deployed yet: treat as no subscription.
            console.warn('Subscription status unavailable:', err.code || err.message);
        });
    }

    /** When access ends after a cancellation, in ms, or null. */
    endsAt() {
        return this.billing?.endsAt?.toMillis?.() ?? null;
    }

    _subscriptionLive() {
        if (!this.billing?.active) return false;
        const endsAt = this.endsAt();
        return endsAt === null || Date.now() < endsAt;
    }

    _recompute(billingChanged = false) {
        if (!this.user) return;
        const previous = this.current;
        this.current = computeEntitlement({
            now: Date.now(),
            trialStartedAt: this.trialStartedAt,
            subscriptionStatus: this._subscriptionLive() ? 'active' : null,
            comped: this.comped,
            trialDays: BILLING.trialDays
        });
        const changed = previous.state !== this.current.state
            || previous.trialDaysLeft !== this.current.trialDaysLeft;
        if ((changed || billingChanged) && this.onChange) this.onChange(this.current, previous);
    }

    _callable(name) {
        return httpsCallable(getFunctions(this.app, BILLING.functionsRegion), name);
    }

    /**
     * Put Square's card form into the page element matching `selector`.
     */
    async mountCardForm(selector) {
        if (!isBillingConfigured()) {
            throw new Error('Subscriptions are not open yet. Please check back soon.');
        }
        this.destroyCardForm();
        const Square = await loadSquareSdk();
        this.payments = Square.payments(BILLING.square.applicationId, BILLING.square.locationId);
        const card = await this.payments.card();
        await card.attach(selector);
        this.card = card;
    }

    destroyCardForm() {
        if (this.card) {
            try { this.card.destroy(); } catch (e) { /* already gone */ }
        }
        this.card = null;
    }

    /**
     * Charge the card in the mounted form and start the subscription.
     * Resolves once the server has confirmed it.
     */
    async subscribe(planKey) {
        if (!this.user) throw new Error('Please sign in first.');
        if (!this.card) throw new Error('The payment form is not ready yet.');
        if (!BILLING.plans[planKey]) throw new Error('Unknown plan.');

        const result = await this.card.tokenize();
        if (result.status !== 'OK') {
            const detail = result.errors?.map(e => e.message).join(' ');
            throw new Error(detail || 'Please check your card details.');
        }

        // Strong customer authentication (3-D Secure), where the card's bank
        // asks for it. Not every card needs it, so a failure here is not
        // fatal: Square rejects the charge itself if verification was required.
        let verificationToken;
        try {
            const verification = await this.payments.verifyBuyer(result.token, {
                intent: 'STORE',
                billingContact: { email: this.user.email || undefined }
            });
            verificationToken = verification?.token;
        } catch (err) {
            console.warn('Buyer verification skipped:', err?.message || err);
        }

        try {
            await this._callable('createSubscription')({
                plan: planKey,
                token: result.token,
                verificationToken
            });
        } catch (err) {
            throw new Error(err?.message || 'The payment could not be completed.');
        }
    }

    /** Stop renewal. Access continues until the returned date (ms). */
    async cancel() {
        if (!this.user) throw new Error('Please sign in first.');
        try {
            const { data } = await this._callable('cancelSubscription')({});
            return data.endsAt;
        } catch (err) {
            throw new Error(err?.message || 'Could not cancel the subscription.');
        }
    }
}

export const entitlement = new Entitlement();
