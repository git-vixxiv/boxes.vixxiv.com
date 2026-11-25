/**
 * Browser tests for the paid flow. The real app runs in Chromium against an
 * in-browser stand-in for Firebase (tests/ui/fake-firebase.js); Square and
 * Amplitude are intercepted, so nothing leaves the machine.
 *
 *   npm run test:ui      (needs Playwright with Chromium installed)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)('playwright');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const DAY = 24 * 60 * 60 * 1000;

let server, browser, origin;

before(async () => {
    server = http.createServer((req, res) => {
        const path = new URL(req.url, 'http://x').pathname;
        const file = join(ROOT, path === '/' ? 'index.html' : path);
        if (!file.startsWith(ROOT) || !existsSync(file)) { res.writeHead(404).end(); return; }
        res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
        res.end(readFileSync(file));
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch();
});
after(async () => { await browser?.close(); server?.close(); });

const USER = { uid: 'u1', email: 'pat@example.com' };
const trial = (daysAgo) => ({ 'users/u1': { trialStartedAt: { __ts: -daysAgo * DAY } } });
const BIN = { 'users/u1/containers/c1': { id: 'c1', name: 'Garage Bin', type: 'bin', location: 'Garage', description: '' } };
const HAMMER = { 'users/u1/items/i1': { id: 'i1', name: 'Secret Hammer', description: 'heirloom', containerId: 'c1', status: 'stored', photo: 'data:image/png;base64,AAAA' } };

async function open({ seed = {}, timezone = 'America/Chicago', configured = true } = {}) {
    const context = await browser.newContext({
        viewport: { width: 390, height: 844 }, serviceWorkers: 'block', timezoneId: timezone
    });
    const page = await context.newPage();
    const sent = [];
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));

    await page.addInitScript(s => { window.__seed = s; }, seed);
    await context.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({
        contentType: 'text/javascript', body: readFileSync(join(ROOT, 'tests/ui/fake-firebase.js'), 'utf8')
    }));
    await context.route('**/billing-config.js', route => {
        let body = readFileSync(join(ROOT, 'billing-config.js'), 'utf8');
        if (configured) {
            body = body
                .replace("applicationId: ''", "applicationId: 'sandbox-sq0idb-test'")
                .replace(/locationId: '[^']*'/, "locationId: 'LOC_TEST'")
                .replace("amplitudeApiKey: ''", "amplitudeApiKey: 'test-key'");
        }
        route.fulfill({ contentType: 'text/javascript', body });
    });
    await context.route('https://api2.amplitude.com/**', route => {
        sent.push(...route.request().postDataJSON().events);
        route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    const squareLoads = [];
    await context.route('https://*.squarecdn.com/**', route => {
        squareLoads.push(route.request().url());
        route.fulfill({ contentType: 'text/javascript', body: readFileSync(join(ROOT, 'tests/ui/fake-square.js'), 'utf8') });
    });

    await page.goto(origin + '/');
    const flush = async () => { await page.waitForTimeout(1300); return sent; };
    const store = (path) => page.evaluate(p => window.__fake.store.get(p), path);
    return { page, context, sent, errors, flush, store, squareLoads };
}

async function addBox(page, name) {
    await page.click('#addNewBoxBtn');
    await page.fill('#containerName', name);
    await page.fill('#containerLocation', 'Attic');
    await page.click('#containerForm button[type=submit]');
    await page.waitForSelector('#containerModal', { state: 'hidden' });
}

test('new user: sign in starts a 7-day trial and everything works', async () => {
    const { page, context, errors, flush } = await open();
    await page.waitForSelector('#notSignedInView:not(.hidden)');
    assert.match(await page.textContent('.sign-in-note'), /Free for 7 days, no card needed/);

    await page.click('#signInPromptBtn');
    await page.waitForSelector('#planBanner:not(.hidden)');
    assert.equal(await page.textContent('#planBannerText'), 'Free trial: 7 days left');

    await addBox(page, 'Private Box Name');
    await page.click('#storeInBoxBtn');
    await page.fill('#itemName', 'Private Item Name');
    await page.selectOption('#itemContainer', { index: 1 });
    await page.click('#itemForm button[type=submit]');
    await page.waitForSelector('#itemModal', { state: 'hidden' });

    const events = await flush();
    const types = events.map(e => e.event_type);
    for (const expected of ['session_started', 'trial_started', 'box_created', 'item_created']) {
        assert.ok(types.includes(expected), `missing ${expected} in ${types}`);
    }
    assert.ok(events.every(e => e.user_id === 'new-user'));
    const payload = JSON.stringify(events);
    assert.ok(!payload.includes('Private'), 'analytics must not carry names');
    assert.ok(!payload.includes('example.com'), 'analytics must not carry the email');
    assert.deepEqual(errors, []);
    await context.close();
});

test('expired trial: inventory is visible, changes open the paywall, paying unlocks it', async () => {
    const { page, context, errors, flush, store, squareLoads } = await open({
        seed: { user: USER, store: { ...trial(8), ...BIN, ...HAMMER } }
    });
    await page.waitForSelector('#planBanner.expired');
    assert.match(await page.textContent('#planBannerText'), /Free trial ended.*read-only/);
    assert.equal(squareLoads.length, 0, 'Square is not loaded until someone goes to pay');

    // Still readable and searchable.
    await page.fill('#searchInput', 'hammer');
    await page.waitForSelector('#searchResults >> text=Secret Hammer');
    await page.fill('#searchInput', '');
    await page.click('#logoLink');

    for (const button of ['#storeInBoxBtn', '#addNewBoxBtn']) {
        await page.click(button);
        await page.waitForSelector('#paywallModal:not(.hidden)');
        assert.ok(await page.isHidden('#itemModal'));
        assert.ok(await page.isHidden('#containerModal'));
        await page.click('#paywallCloseBtn');
    }

    await page.click('#planBannerBtn');
    assert.equal(await page.textContent('#paywallTitle'), 'Your free trial has ended');
    assert.match(await page.textContent('.plan-option[data-plan=yearly]'), /\$29\.99 per year/);
    assert.match(await page.textContent('.plan-option[data-plan=monthly]'), /\$3\.99 per month/);
    assert.ok(await page.isHidden('#paywallUnavailable'));

    // Pick a plan, change your mind, pick the other.
    await page.click('.plan-option[data-plan=monthly]');
    await page.waitForSelector('#cardContainer .fake-card-form');
    assert.equal(await page.textContent('#paySummary'), 'Monthly: $3.99 per month');
    await page.click('#payBackBtn');
    assert.equal(await page.locator('#cardContainer .fake-card-form').count(), 0);
    await page.click('.plan-option[data-plan=yearly]');
    await page.waitForSelector('#cardContainer .fake-card-form');
    assert.equal(await page.textContent('#paySubmitBtn'), 'Subscribe for $29.99');
    assert.match(squareLoads[0], /^https:\/\/sandbox\.web\.squarecdn\.com\/v1\/square\.js$/);
    assert.deepEqual(await page.evaluate(() => window.__square.payments.at(-1)),
        { applicationId: 'sandbox-sq0idb-test', locationId: 'LOC_TEST' });

    await page.click('#paySubmitBtn');
    await page.waitForSelector('#paywallModal', { state: 'hidden' });
    await page.waitForSelector('#planBanner', { state: 'hidden' });
    const call = await page.evaluate(() => window.__fake.calls.at(-1));
    assert.equal(call.name, 'createSubscription');
    assert.equal(call.region, 'us-central1');
    assert.deepEqual(call.data, { plan: 'yearly', token: 'cnon:ok', verificationToken: 'verf:ok' });
    assert.equal((await store('billing/u1')).active, true);

    // Unlocked without a reload.
    await addBox(page, 'After Paying');

    const types = (await flush()).map(e => e.event_type);
    for (const expected of ['paywall_shown', 'checkout_started', 'checkout_completed']) {
        assert.ok(types.includes(expected), `missing ${expected} in ${types}`);
    }
    assert.deepEqual(errors, []);
    await context.close();
});

test('declined or invalid card: clear message, no access, can try again', async () => {
    const declined = await open({ seed: { user: USER, cardToken: 'cnon:declined', store: trial(9) } });
    await declined.page.waitForSelector('#planBanner.expired');
    await declined.page.click('#planBannerBtn');
    await declined.page.click('.plan-option[data-plan=monthly]');
    await declined.page.waitForSelector('#cardContainer .fake-card-form');
    await declined.page.click('#paySubmitBtn');
    await declined.page.waitForSelector('#payError:not(.hidden)');
    assert.equal(await declined.page.textContent('#payError'), 'Card declined.');
    assert.ok(await declined.page.isVisible('#paywallModal'));
    assert.ok(await declined.page.isEnabled('#paySubmitBtn'));
    assert.equal(await declined.page.textContent('#paySubmitBtn'), 'Subscribe for $3.99');
    assert.ok(await declined.page.isVisible('#planBanner.expired'));
    assert.ok((await declined.flush()).some(e => e.event_type === 'checkout_failed' && e.event_properties.stage === 'payment'));
    await declined.context.close();

    const invalid = await open({ seed: { user: USER, cardInvalid: true, store: trial(9) } });
    await invalid.page.waitForSelector('#planBanner.expired');
    await invalid.page.click('#planBannerBtn');
    await invalid.page.click('.plan-option[data-plan=monthly]');
    await invalid.page.waitForSelector('#cardContainer .fake-card-form');
    await invalid.page.click('#paySubmitBtn');
    await invalid.page.waitForSelector('#payError:not(.hidden)');
    assert.equal(await invalid.page.textContent('#payError'), 'Card number is not valid.');
    assert.equal(await invalid.page.evaluate(() => (window.__fake.calls || []).length), 0, 'server not called');
    await invalid.context.close();
});

const SUBSCRIBED = { 'billing/u1': { active: true, status: 'active', plan: 'yearly', cancelRequested: false, endsAt: null, chargedThrough: '2027-03-05', squareSubscriptionId: 'SUB_1' } };

test('subscriber: no banner, manage screen shows renewal, cancel keeps access to period end', async () => {
    const { page, context, errors, store } = await open({ seed: { user: USER, store: { ...trial(60), ...SUBSCRIBED } } });
    await page.waitForSelector('#authLoggedIn:not(.hidden)');
    await page.waitForTimeout(300);
    assert.ok(await page.isHidden('#planBanner'));
    await addBox(page, 'Paid Box');

    await page.click('#menuBtn');
    assert.ok(await page.isHidden('#subscribeMenuBtn'));
    await page.click('#manageSubscriptionBtn');
    await page.waitForSelector('#subscriptionModal:not(.hidden)');
    const details = () => page.textContent('#subscriptionDetails');
    assert.match(await details(), /Yearly plan: \$29\.99 per year/);
    assert.match(await details(), /Renews on March 5, 2027\./);

    page.once('dialog', d => d.accept());
    await page.click('#cancelSubscriptionBtn');
    await page.waitForSelector('#cancelSubscriptionBtn', { state: 'hidden' });
    assert.match(await details(), /Cancelled\. You keep full access until November 21, 2027\./);
    assert.equal((await store('billing/u1')).cancelRequested, true);
    assert.equal(await page.evaluate(() => window.__fake.calls.at(-1).name), 'cancelSubscription');

    // Still fully usable until the period ends.
    await page.click('#subscriptionModal .close-btn');
    assert.ok(await page.isHidden('#planBanner'));
    await addBox(page, 'Still Works');
    assert.deepEqual(errors, []);
    await context.close();
});

test('delete account: needs DELETE typed, erases everything and signs out', async () => {
    const { page, context, errors, flush } = await open({
        seed: { user: USER, store: { ...trial(60), ...SUBSCRIBED, ...BIN, ...HAMMER, 'users/other/items/x': { id: 'x', name: 'Not mine' } } }
    });
    await page.waitForSelector('#authLoggedIn:not(.hidden)');
    await page.waitForTimeout(300);
    await page.click('#menuBtn');
    await page.click('#deleteAccountMenuBtn');
    await page.waitForSelector('#deleteAccountModal:not(.hidden)');
    assert.ok(await page.isVisible('#deleteAccountSubscriptionNote'));
    assert.ok(await page.isDisabled('#deleteAccountBtn'));
    await page.fill('#deleteAccountConfirm', 'delete');
    assert.ok(await page.isDisabled('#deleteAccountBtn'), 'lower case is not enough');

    // A failure on the server deletes nothing and keeps the user signed in.
    await page.evaluate(() => { window.__fake.deleteFails = true; });
    await page.fill('#deleteAccountConfirm', 'DELETE');
    await page.click('#deleteAccountBtn');
    await page.waitForSelector('.toast.error');
    assert.match(await page.textContent('.toast'), /nothing was deleted/);
    assert.ok(await page.isVisible('#authLoggedIn'));
    assert.equal(await page.evaluate(() => window.__fake.store.has('users/u1/items/i1')), true);

    await page.evaluate(() => { window.__fake.deleteFails = false; });
    await page.click('#deleteAccountBtn');
    await page.waitForSelector('#notSignedInView:not(.hidden)');
    const left = await page.evaluate(() => [...window.__fake.store.keys()]);
    assert.deepEqual(left, ['users/other/items/x']);
    assert.ok(await page.isHidden('#planBanner'));
    assert.ok((await flush()).some(e => e.event_type === 'account_deleted'));
    assert.deepEqual(errors, []);
    await context.close();
});

test('cancelled subscription past its end date is read-only again', async () => {
    const ended = { 'billing/u1': { ...SUBSCRIBED['billing/u1'], cancelRequested: true, endsAt: { __ts: -DAY } } };
    const { page, context } = await open({ seed: { user: USER, store: { ...trial(60), ...ended } } });
    await page.waitForSelector('#planBanner.expired');
    assert.match(await page.textContent('#planBannerText'), /subscription has ended/);
    await page.click('#addNewBoxBtn');
    await page.waitForSelector('#paywallModal:not(.hidden)');
    await context.close();
});

test('failed renewal: banner explains, access continues while Square retries', async () => {
    const pastDue = { 'billing/u1': { ...SUBSCRIBED['billing/u1'], status: 'past_due' } };
    const { page, context } = await open({ seed: { user: USER, store: { ...trial(60), ...pastDue } } });
    await page.waitForSelector('#planBanner.expired');
    assert.equal(await page.textContent('#planBannerText'), 'Your last payment did not go through.');
    await page.click('#planBannerBtn');
    await page.waitForSelector('#subscriptionModal:not(.hidden)');
    assert.match(await page.textContent('#subscriptionDetails'), /Square will try the card again/);
    await page.click('#subscriptionModal .close-btn');
    await addBox(page, 'Past Due Box');
    await context.close();
});

test('allow-listed business user: no banner, no paywall, long after the trial', async () => {
    const { page, context, errors } = await open({
        seed: { user: USER, store: { ...trial(400), 'comp/pat@example.com': { note: 'client' } } }
    });
    await page.waitForSelector('#authLoggedIn:not(.hidden)');
    await page.waitForTimeout(300);
    assert.ok(await page.isHidden('#planBanner'));
    await addBox(page, 'Client Box');
    assert.ok(await page.isHidden('#paywallModal'));
    assert.deepEqual(errors, []);
    await context.close();
});

test('importing an export keeps stored photos and deletes nothing', async () => {
    const { page, context, store } = await open({
        seed: { user: USER, store: { ...trial(1), ...BIN, ...HAMMER,
            'users/u1/items/i2': { id: 'i2', name: 'Untouched', containerId: 'c1', status: 'stored' } } }
    });
    await page.waitForSelector('#planBanner:not(.hidden)');
    page.on('dialog', d => d.accept());
    const exported = {
        containers: [{ id: 'c1', name: 'Garage Bin', type: 'bin', location: 'Garage', hasPhoto: false }],
        items: [{ id: 'i1', name: 'Renamed Hammer', containerId: 'c1', status: 'stored', hasPhoto: true }]
    };
    await page.setInputFiles('#importFile', { name: 'export.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exported)) });
    await page.waitForSelector('.toast.success');
    const hammer = await store('users/u1/items/i1');
    assert.equal(hammer.name, 'Renamed Hammer');
    assert.equal(hammer.photo, 'data:image/png;base64,AAAA');
    assert.equal('hasPhoto' in hammer, false);
    assert.equal((await store('users/u1/items/i2')).name, 'Untouched');
    await context.close();
});

test('billing not set up yet: paywall says so and nothing is charged', async () => {
    const { page, context, sent } = await open({ configured: false, seed: { user: USER, store: trial(9) } });
    await page.waitForSelector('#planBanner.expired');
    await page.click('#planBannerBtn');
    assert.ok(await page.isVisible('#paywallUnavailable'));
    await page.click('.plan-option[data-plan=monthly]');
    await page.waitForSelector('.toast.error');
    assert.match(await page.textContent('.toast'), /not open yet/);
    assert.ok(await page.isVisible('#paywallPlans'));
    assert.ok(await page.isHidden('#paywallPay'));
    assert.equal(await page.evaluate(() => (window.__fake.calls || []).length), 0);
    await page.waitForTimeout(1300);
    assert.equal(sent.length, 0, 'no analytics without an API key');
    assert.ok(await page.isHidden('#analyticsToggleBtn'));
    await context.close();
});

test('Europe: nothing is tracked until the visitor says yes', async () => {
    const { page, context, sent, flush, store } = await open({
        timezone: 'Europe/Berlin', seed: { user: USER, store: trial(1) }
    });
    await page.waitForSelector('#consentBanner:not(.hidden)');
    await addBoxBehindBanner(page);
    assert.equal((await flush()).length, 0);
    assert.deepEqual(await store('users/u1/prefs/analytics'), { enabled: false });

    await page.click('#consentAllowBtn');
    await page.waitForSelector('#consentBanner', { state: 'hidden' });
    await page.fill('#searchInput', 'x');
    await page.waitForTimeout(1800);
    assert.ok((await flush()).some(e => e.event_type === 'search_used'));
    assert.deepEqual(await store('users/u1/prefs/analytics'), { enabled: true });
    await context.close();
});

test('outside Europe: on by default, and the menu switch turns it off', async () => {
    const { page, context, sent, flush, store } = await open({ seed: { user: USER, store: trial(1) } });
    await page.waitForSelector('#planBanner:not(.hidden)');
    assert.ok(await page.isHidden('#consentBanner'));
    assert.ok((await flush()).some(e => e.event_type === 'session_started'));
    await page.click('#menuBtn');
    assert.equal(await page.textContent('#analyticsToggleBtn'), 'Usage analytics: On');
    await page.click('#analyticsToggleBtn');
    assert.equal(await page.textContent('#analyticsToggleBtn'), 'Usage analytics: Off');
    const before = sent.length;
    await page.fill('#searchInput', 'x');
    await page.waitForTimeout(3000);
    assert.equal(sent.length, before);
    assert.deepEqual(await store('users/u1/prefs/analytics'), { enabled: false });
    await context.close();
});

async function addBoxBehindBanner(page) {
    await page.click('#addNewBoxBtn');
    await page.fill('#containerName', 'EU Box');
    await page.fill('#containerLocation', 'Keller');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#containerModal', { state: 'hidden' });
}
