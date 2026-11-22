/**
 * Deleting an account and everything Boxes holds for it.
 *
 * Order matters: the subscription is stopped first, and if Square cannot be
 * reached nothing is deleted, so nobody ends up billed for an account that no
 * longer exists.
 *
 * What is NOT removed: Square's own customer and payment records, which
 * Square keeps as the payment processor.
 */

import { BillingError } from './billing.js';

export function createAccountDeletion({ db, auth, square, now = () => Date.now() }) {
    async function deleteAccount({ uid }) {
        const billingRef = db.collection('billing').doc(uid);
        const billing = (await billingRef.get()).data() || {};

        const endsAt = billing.endsAt?.toMillis?.() ?? null;
        const live = !!billing.active && (endsAt === null || now() < endsAt);
        if (live && billing.squareSubscriptionId && !billing.cancelRequested) {
            try {
                await square.cancelSubscription(billing.squareSubscriptionId);
            } catch (error) {
                throw new BillingError('unavailable',
                    'Your subscription could not be cancelled just now, so nothing was deleted. Please try again in a few minutes.');
            }
        }

        // Inventory, photos, preferences and the trial record.
        await db.recursiveDelete(db.collection('users').doc(uid));
        await billingRef.delete();

        try {
            await auth.deleteUser(uid);
        } catch (error) {
            if (error?.code !== 'auth/user-not-found') throw error;
        }
        return { deleted: true, subscriptionCancelled: live && !!billing.squareSubscriptionId };
    }

    return { deleteAccount };
}
