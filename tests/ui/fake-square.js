/**
 * Stand-in for Square's Web Payments SDK, used only by tests/ui.test.mjs.
 * window.__seed.cardToken picks the token the "card form" produces;
 * window.__seed.cardInvalid makes the form report bad card details.
 */
window.__square = { payments: [], verified: [] };
window.Square = {
    payments(applicationId, locationId) {
        window.__square.payments.push({ applicationId, locationId });
        return {
            async card() {
                let el = null;
                return {
                    async attach(selector) {
                        el = document.createElement('div');
                        el.className = 'fake-card-form';
                        el.textContent = 'Card number';
                        document.querySelector(selector).appendChild(el);
                    },
                    async tokenize() {
                        const seed = window.__seed || {};
                        if (seed.cardInvalid) {
                            return { status: 'Invalid', errors: [{ message: 'Card number is not valid.' }] };
                        }
                        return { status: 'OK', token: seed.cardToken || 'cnon:ok' };
                    },
                    destroy() { if (el) el.remove(); el = null; }
                };
            },
            async verifyBuyer(token, details) {
                window.__square.verified.push({ token, details });
                return { token: 'verf:ok' };
            }
        };
    }
};
