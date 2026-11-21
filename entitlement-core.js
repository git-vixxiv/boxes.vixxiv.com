/**
 * Boxes - entitlement rules (pure, no Firebase).
 *
 * The same rule is enforced server-side in firestore.rules; this copy only
 * drives the UI. Keep the two in step.
 *
 *   comped      -> on the business allow-list, full access
 *   subscribed  -> active Square subscription, full access
 *   trial       -> inside the free trial, full access
 *   expired     -> read-only: view, search, export and delete still work
 *   loading     -> not known yet; the UI stays open and the server decides
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export const ACTIVE_SUBSCRIPTION_STATUSES = ['active', 'trialing'];

export function computeEntitlement({ now, trialStartedAt, subscriptionStatus, comped, trialDays }) {
    if (comped) {
        return { state: 'comped', canWrite: true, trialDaysLeft: null, trialEndsAt: null };
    }
    if (ACTIVE_SUBSCRIPTION_STATUSES.includes(subscriptionStatus)) {
        return { state: 'subscribed', canWrite: true, trialDaysLeft: null, trialEndsAt: null };
    }
    if (trialStartedAt == null) {
        return { state: 'loading', canWrite: true, trialDaysLeft: null, trialEndsAt: null };
    }

    const trialEndsAt = trialStartedAt + trialDays * DAY_MS;
    if (now < trialEndsAt) {
        return {
            state: 'trial',
            canWrite: true,
            trialDaysLeft: Math.ceil((trialEndsAt - now) / DAY_MS),
            trialEndsAt
        };
    }
    return { state: 'expired', canWrite: false, trialDaysLeft: 0, trialEndsAt };
}
