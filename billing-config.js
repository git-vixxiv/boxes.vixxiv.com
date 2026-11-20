/**
 * Boxes - billing and analytics settings.
 *
 * Everything here is safe to ship in the browser: Stripe price ids and the
 * Amplitude API key are public identifiers, not secrets.
 * See docs/PAID-LAUNCH.md for where each value comes from.
 */

export const BILLING = {
    trialDays: 7,

    plans: {
        monthly: {
            label: 'Monthly',
            price: '$3.99',
            period: 'per month',
            // Stripe price id, e.g. "price_1AbC...". Leave as-is until Stripe is set up.
            stripePriceId: 'STRIPE_MONTHLY_PRICE_ID'
        },
        yearly: {
            label: 'Yearly',
            price: '$29.99',
            period: 'per year',
            note: 'Save 37%',
            stripePriceId: 'STRIPE_YEARLY_PRICE_ID'
        }
    },

    // Region the Stripe extension's functions were installed in.
    functionsRegion: 'us-central1'
};

export const ANALYTICS = {
    // Amplitude project API key for the Boxes project. Empty = analytics off.
    amplitudeApiKey: '',
    // "https://api.eu.amplitude.com/2/httpapi" for an EU-resident Amplitude project.
    endpoint: 'https://api2.amplitude.com/2/httpapi'
};

export function isBillingConfigured() {
    return Object.values(BILLING.plans).every(p => p.stripePriceId.startsWith('price_'));
}
