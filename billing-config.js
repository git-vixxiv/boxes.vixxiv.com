/**
 * Boxes - billing and analytics settings.
 *
 * Everything here is safe to ship in the browser: the Square application id,
 * location id and the Amplitude API key are public identifiers, not secrets.
 * The Square access token lives only in Cloud Functions.
 * See docs/PAID-LAUNCH.md for where each value comes from.
 */

export const BILLING = {
    trialDays: 7,

    plans: {
        monthly: {
            label: 'Monthly',
            price: '$3.99',
            period: 'per month'
        },
        yearly: {
            label: 'Yearly',
            price: '$29.99',
            period: 'per year',
            note: 'Save 37%'
        }
    },

    square: {
        // "sandbox" for testing, "production" for real cards. Must match the
        // SQUARE_ENVIRONMENT the functions are deployed with.
        environment: 'sandbox',
        // Square Developer Dashboard > your application > Credentials.
        // Sandbox ids start with "sandbox-sq0idb-", production with "sq0idp-".
        applicationId: '',
        // Square Developer Dashboard > Locations.
        locationId: 'LVSKN9DAW9PFA'
    },

    // Region the Cloud Functions are deployed in.
    functionsRegion: 'us-central1'
};

export const ANALYTICS = {
    // Amplitude project API key for the Boxes project. Empty = analytics off.
    amplitudeApiKey: '',
    // "https://api.eu.amplitude.com/2/httpapi" for an EU-resident Amplitude project.
    endpoint: 'https://api2.amplitude.com/2/httpapi'
};

export function isBillingConfigured() {
    return !!(BILLING.square.applicationId && BILLING.square.locationId);
}
