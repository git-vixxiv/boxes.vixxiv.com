/**
 * Square, narrowed to the five calls Boxes makes. Plain REST over fetch, so
 * there is no SDK to keep in step and the billing logic can be tested with a
 * stand-in (anything with these same methods).
 */

const HOSTS = {
    sandbox: 'https://connect.squareupsandbox.com',
    production: 'https://connect.squareup.com'
};
const SQUARE_VERSION = '2025-01-23';

export class SquareError extends Error {
    constructor(status, errors) {
        const first = errors?.[0] || {};
        super(first.detail || first.code || `Square request failed (${status})`);
        this.name = 'SquareError';
        this.status = status;
        this.errors = errors || [];
        this.code = first.code || null;
    }
}

export function createSquare({ environment, accessToken, fetchImpl = fetch }) {
    const host = HOSTS[environment];
    if (!host) throw new Error(`SQUARE_ENVIRONMENT must be "sandbox" or "production", got "${environment}"`);

    async function call(method, path, body) {
        const response = await fetchImpl(host + path, {
            method,
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Square-Version': SQUARE_VERSION,
                'Content-Type': 'application/json'
            },
            body: body ? JSON.stringify(body) : undefined
        });
        const json = await response.json().catch(() => ({}));
        if (!response.ok) throw new SquareError(response.status, json.errors);
        return json;
    }

    return {
        async createCustomer({ idempotencyKey, emailAddress, referenceId }) {
            const { customer } = await call('POST', '/v2/customers', {
                idempotency_key: idempotencyKey,
                email_address: emailAddress || undefined,
                reference_id: referenceId
            });
            return { id: customer.id };
        },

        async createCard({ idempotencyKey, sourceId, verificationToken, customerId }) {
            const { card } = await call('POST', '/v2/cards', {
                idempotency_key: idempotencyKey,
                source_id: sourceId,
                verification_token: verificationToken || undefined,
                card: { customer_id: customerId }
            });
            return { id: card.id };
        },

        async createSubscription({ idempotencyKey, locationId, planVariationId, customerId, cardId }) {
            const { subscription } = await call('POST', '/v2/subscriptions', {
                idempotency_key: idempotencyKey,
                location_id: locationId,
                plan_variation_id: planVariationId,
                customer_id: customerId,
                card_id: cardId
            });
            return subscription;
        },

        /** Stops renewal. Square keeps the subscription live until canceled_date. */
        async cancelSubscription(subscriptionId) {
            const { subscription } = await call(
                'POST', `/v2/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`
            );
            return subscription;
        },

        async getSubscription(subscriptionId) {
            const { subscription } = await call(
                'GET', `/v2/subscriptions/${encodeURIComponent(subscriptionId)}`
            );
            return subscription;
        }
    };
}
