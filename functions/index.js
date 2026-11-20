/**
 * Boxes - Cloud Functions.
 *
 * Reports subscription lifecycle events to Amplitude from the server, where
 * Stripe has confirmed them. Browser-side tracking misses some of these.
 * Sent only for users who have usage analytics switched on.
 */

import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { defineString } from 'firebase-functions/params';
import { logger } from 'firebase-functions';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

import { subscriptionEvent } from './events.js';

initializeApp();

// Amplitude project API key (a public identifier, not a secret).
const AMPLITUDE_API_KEY = defineString('AMPLITUDE_API_KEY', { default: '' });
const AMPLITUDE_ENDPOINT = defineString('AMPLITUDE_ENDPOINT', {
    default: 'https://api2.amplitude.com/2/httpapi'
});

export const reportSubscriptionEvent = onDocumentWritten(
    'customers/{uid}/subscriptions/{subscriptionId}',
    async (change) => {
        const apiKey = AMPLITUDE_API_KEY.value();
        if (!apiKey) return;

        const { uid, subscriptionId } = change.params;
        const event = subscriptionEvent(
            change.data.before.data(),
            change.data.after.data(),
            subscriptionId
        );
        if (!event) return;

        const pref = await getFirestore().doc(`users/${uid}/prefs/analytics`).get();
        if (pref.data()?.enabled !== true) return;

        const response = await fetch(AMPLITUDE_ENDPOINT.value(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                api_key: apiKey,
                events: [{ ...event, user_id: uid, time: Date.now(), platform: 'Server' }]
            })
        });
        if (!response.ok) {
            logger.warn('Amplitude rejected a subscription event', {
                status: response.status,
                event: event.event_type
            });
        }
    }
);
