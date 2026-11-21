#!/usr/bin/env node
/**
 * Creates the Boxes subscription plan in Square's catalog and prints the two
 * plan-variation ids the functions need. Run once per Square environment.
 *
 *   SQUARE_ENVIRONMENT=sandbox SQUARE_ACCESS_TOKEN=... node scripts/setup-plans.js
 *
 * Production needs CONFIRM_PRODUCTION=yes as well, because a catalog price is
 * customer-facing. Running it twice creates a second plan; do not.
 */
import { randomUUID } from 'node:crypto';

const environment = process.env.SQUARE_ENVIRONMENT || 'sandbox';
const accessToken = process.env.SQUARE_ACCESS_TOKEN;
const HOSTS = {
    sandbox: 'https://connect.squareupsandbox.com',
    production: 'https://connect.squareup.com'
};

export const PLAN_CATALOG = {
    type: 'SUBSCRIPTION_PLAN',
    id: '#boxes-plan',
    subscription_plan_data: {
        name: 'Boxes',
        subscription_plan_variations: [
            variation('#boxes-monthly', 'Boxes Monthly', 'MONTHLY', 399),
            variation('#boxes-yearly', 'Boxes Yearly', 'ANNUAL', 2999)
        ]
    }
};

function variation(id, name, cadence, cents) {
    return {
        type: 'SUBSCRIPTION_PLAN_VARIATION',
        id,
        subscription_plan_variation_data: {
            name,
            phases: [{
                cadence,
                ordinal: 0,
                pricing: { type: 'STATIC', price_money: { amount: cents, currency: 'USD' } }
            }]
        }
    };
}

async function main() {
    if (!HOSTS[environment]) throw new Error('SQUARE_ENVIRONMENT must be sandbox or production.');
    if (!accessToken) throw new Error('Set SQUARE_ACCESS_TOKEN.');
    if (environment === 'production' && process.env.CONFIRM_PRODUCTION !== 'yes') {
        throw new Error('Refusing to change the PRODUCTION catalog without CONFIRM_PRODUCTION=yes.');
    }

    const response = await fetch(`${HOSTS[environment]}/v2/catalog/object`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Square-Version': '2025-01-23',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ idempotency_key: randomUUID(), object: PLAN_CATALOG })
    });
    const json = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(json.errors || json));

    const idFor = (clientId) =>
        json.id_mappings?.find(m => m.client_object_id === clientId)?.object_id || '(not found)';
    console.log(`Boxes plan created in Square (${environment}). Set these for the functions:\n`);
    console.log(`SQUARE_PLAN_MONTHLY=${idFor('#boxes-monthly')}`);
    console.log(`SQUARE_PLAN_YEARLY=${idFor('#boxes-yearly')}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch((error) => {
        console.error('Failed:', error.message);
        process.exit(1);
    });
}
