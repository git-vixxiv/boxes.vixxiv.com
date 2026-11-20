/**
 * Turns a change to a Stripe subscription record (as written by the
 * firestore-stripe-payments extension) into at most one analytics event.
 * Pure: no Firebase, no network.
 */

const ACTIVE = ['active', 'trialing'];

function seconds(value) {
    if (!value) return null;
    if (typeof value.seconds === 'number') return value.seconds;
    if (typeof value.toMillis === 'function') return Math.floor(value.toMillis() / 1000);
    return null;
}

function planInterval(sub) {
    const price = sub?.items?.[0]?.price;
    return price?.recurring?.interval || price?.interval || 'unknown';
}

export function subscriptionEvent(before, after, subscriptionId) {
    if (!after) return null;

    const wasActive = !!before && ACTIVE.includes(before.status);
    const isActive = ACTIVE.includes(after.status);
    const period = seconds(after.current_period_start);
    const base = { plan_interval: planInterval(after) };
    const event = (type, key, extra = {}) => ({
        event_type: type,
        insert_id: `${subscriptionId}:${type}:${key}`,
        event_properties: { ...base, ...extra }
    });

    if (isActive && !wasActive) return event('subscription_started', period);
    if (wasActive && !isActive) {
        return event('subscription_ended', after.status, { final_status: after.status });
    }
    if (isActive && wasActive) {
        if (after.cancel_at_period_end && !before.cancel_at_period_end) {
            return event('subscription_cancel_requested', period);
        }
        if (!after.cancel_at_period_end && before.cancel_at_period_end) {
            return event('subscription_cancel_reversed', period);
        }
        const previousPeriod = seconds(before.current_period_start);
        if (period && previousPeriod && period > previousPeriod) {
            return event('subscription_renewed', period);
        }
    }
    return null;
}
