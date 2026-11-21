/**
 * Boxes - Cloud Functions.
 *
 *   createSubscription   start a paid subscription from a tokenized card
 *   cancelSubscription   stop renewal; access runs to the end of the period
 *   squareWebhook        Square tells us about renewals, failures and endings
 *   reportSubscriptionEvent   mirror those changes to Amplitude
 *
 * The logic lives in billing.js; this file only wires it to Firebase.
 */

import { onCall, onRequest, HttpsError } from 'firebase-functions/v2/https';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { defineString, defineSecret } from 'firebase-functions/params';
import { logger } from 'firebase-functions';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

import { createSquare } from './square.js';
import { createBilling, BillingError, isValidSignature } from './billing.js';
import { subscriptionEvent } from './events.js';

initializeApp();

const REGION = 'us-central1';

// "sandbox" until you deliberately switch to "production".
const SQUARE_ENVIRONMENT = defineString('SQUARE_ENVIRONMENT', { default: 'sandbox' });
const SQUARE_ACCESS_TOKEN = defineSecret('SQUARE_ACCESS_TOKEN');
const SQUARE_LOCATION_ID = defineString('SQUARE_LOCATION_ID', { default: '' });
const SQUARE_PLAN_MONTHLY = defineString('SQUARE_PLAN_MONTHLY', { default: '' });
const SQUARE_PLAN_YEARLY = defineString('SQUARE_PLAN_YEARLY', { default: '' });
const SQUARE_WEBHOOK_SIGNATURE_KEY = defineSecret('SQUARE_WEBHOOK_SIGNATURE_KEY');
// The exact URL registered in Square for the webhook; it is part of the signature.
const SQUARE_WEBHOOK_URL = defineString('SQUARE_WEBHOOK_URL', { default: '' });

// Amplitude project API key (a public identifier, not a secret).
const AMPLITUDE_API_KEY = defineString('AMPLITUDE_API_KEY', { default: '' });
const AMPLITUDE_ENDPOINT = defineString('AMPLITUDE_ENDPOINT', {
    default: 'https://api2.amplitude.com/2/httpapi'
});

function billing() {
    return createBilling({
        db: getFirestore(),
        square: createSquare({
            environment: SQUARE_ENVIRONMENT.value(),
            accessToken: SQUARE_ACCESS_TOKEN.value()
        }),
        config: {
            locationId: SQUARE_LOCATION_ID.value(),
            planVariationIds: {
                monthly: SQUARE_PLAN_MONTHLY.value(),
                yearly: SQUARE_PLAN_YEARLY.value()
            }
        },
        serverTimestamp: () => FieldValue.serverTimestamp()
    });
}

async function run(name, uid, work) {
    try {
        return await work();
    } catch (error) {
        if (error instanceof BillingError) {
            logger.info(`${name} refused`, { uid, code: error.code, message: error.message });
            throw new HttpsError(error.code, error.message);
        }
        logger.error(`${name} failed`, { uid, message: error?.message, errors: error?.errors });
        throw new HttpsError('internal', 'Something went wrong. You have not been charged twice; please try again.');
    }
}

export const createSubscription = onCall(
    { region: REGION, secrets: [SQUARE_ACCESS_TOKEN] },
    async (request) => {
        if (!request.auth) throw new HttpsError('unauthenticated', 'Please sign in first.');
        const uid = request.auth.uid;
        return run('createSubscription', uid, () => billing().subscribe({
            uid,
            email: request.auth.token.email || '',
            plan: request.data?.plan,
            token: request.data?.token,
            verificationToken: request.data?.verificationToken || undefined
        }));
    }
);

export const cancelSubscription = onCall(
    { region: REGION, secrets: [SQUARE_ACCESS_TOKEN] },
    async (request) => {
        if (!request.auth) throw new HttpsError('unauthenticated', 'Please sign in first.');
        const uid = request.auth.uid;
        return run('cancelSubscription', uid, () => billing().cancel({ uid }));
    }
);

export const squareWebhook = onRequest(
    { region: REGION, secrets: [SQUARE_ACCESS_TOKEN, SQUARE_WEBHOOK_SIGNATURE_KEY] },
    async (req, res) => {
        const valid = isValidSignature({
            body: req.rawBody?.toString('utf8') ?? '',
            signature: req.header('x-square-hmacsha256-signature') ?? '',
            signatureKey: SQUARE_WEBHOOK_SIGNATURE_KEY.value(),
            notificationUrl: SQUARE_WEBHOOK_URL.value()
        });
        if (!valid) {
            logger.warn('Rejected a webhook with an invalid signature');
            res.status(401).send('invalid signature');
            return;
        }
        try {
            const outcome = await billing().handleEvent(req.body);
            logger.info('Square webhook processed', outcome);
            res.status(200).send('ok');
        } catch (error) {
            // A 5xx makes Square retry, which is what we want for a
            // temporary failure on our side.
            logger.error('Square webhook failed', { message: error?.message });
            res.status(500).send('error');
        }
    }
);

/**
 * Reports subscription changes to Amplitude from the server, where Square has
 * confirmed them. Sent only for users who have usage analytics switched on.
 */
export const reportSubscriptionEvent = onDocumentWritten(
    { document: 'billing/{uid}', region: REGION },
    async (change) => {
        const apiKey = AMPLITUDE_API_KEY.value();
        if (!apiKey) return;

        const { uid } = change.params;
        const event = subscriptionEvent(change.data.before.data(), change.data.after.data(), uid);
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
