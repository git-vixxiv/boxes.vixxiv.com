/**
 * Turns a change to a user's billing record into at most one analytics event.
 * Pure: no Firebase, no network.
 */

export function subscriptionEvent(before, after, uid) {
    if (!after) return null;

    const wasActive = !!before?.active;
    const isActive = !!after.active;
    const subscription = after.squareSubscriptionId || 'none';
    const event = (type, key, extra = {}) => ({
        event_type: type,
        insert_id: `${uid}:${subscription}:${type}:${key}`,
        event_properties: { plan: after.plan || 'unknown', ...extra }
    });

    if (isActive && !wasActive) return event('subscription_started', after.chargedThrough);
    if (wasActive && !isActive) return event('subscription_ended', 'end');
    if (!isActive) return null;

    if (after.cancelRequested && !before.cancelRequested) {
        return event('subscription_cancel_requested', after.chargedThrough);
    }
    if (after.status === 'past_due' && before.status !== 'past_due') {
        return event('subscription_payment_failed', after.chargedThrough);
    }
    if (after.chargedThrough && before.chargedThrough
        && after.chargedThrough > before.chargedThrough) {
        return event('subscription_renewed', after.chargedThrough);
    }
    return null;
}
