# Boxes paid launch - setup and go-live

The `paid-launch` branch adds a 7-day free trial (no card), a $3.99/month or
$29.99/year subscription, a business allow-list, and usage analytics. Nothing
in it moves or rewrites stored inventory: items and boxes stay at
`users/{uid}/items` and `users/{uid}/containers` in the `boxes-ffa31` project,
under the same Google sign-in.

## How access is decided

| Who | What they can do |
|---|---|
| In the 7-day trial | Everything |
| Active subscriber | Everything |
| On the allow-list (`comp/{email}`) | Everything, no trial or payment |
| Trial or subscription ended | View, search, export and delete. No adding or editing |

The rule lives in two places that must agree: `firestore.rules` (the server,
which is what actually enforces it) and `entitlement-core.js` (the UI).

## How payment works

Payments run on Square. The card form in the app is Square's own, so card
numbers never touch Boxes. A Cloud Function creates the Square customer, saves
the card and starts the subscription; Square then tells the `squareWebhook`
function about renewals, failed payments and endings. Everything is recorded
on one server-owned document, `billing/{uid}`, which the app can read but not
write.

- **Cancelling** stops renewal. Access continues to the end of the period
  already paid for, then the inventory becomes read-only.
- **A failed renewal** shows a notice but keeps access while Square retries
  the card. If the retries run out, Square ends the subscription.
- There is no "update my card" screen yet. Someone whose card has expired
  subscribes again with the new card once the old subscription has ended.
- **Delete Account** (in the menu) stops the subscription at Square, then
  erases the user's items, boxes, photos, preferences, billing record and
  sign-in. If Square cannot be reached, nothing is deleted. Square keeps its
  own customer and payment records. Someone who deletes and signs up again
  gets a new trial.
- There is no trial in Square. The 7-day trial is tracked by the app, before
  any card exists.

## One-time setup

### 1. Firebase plan
Move `boxes-ffa31` to the Blaze (pay-as-you-go) plan. Cloud Functions need it.

### 2. Square application
In the Square Developer Dashboard, create an application for Boxes (or reuse
one). You need, for **sandbox first** and later for production:

- Application ID (public; goes in `billing-config.js`)
- Location ID (public; goes in `billing-config.js` and the functions)
- Access token (secret; functions only, never in the repo or in chat)

### 3. Create the subscription plan in Square
Run once per environment. It creates "Boxes" with a $3.99 monthly and a
$29.99 yearly variation and prints their ids:

    cd functions
    SQUARE_ENVIRONMENT=sandbox SQUARE_ACCESS_TOKEN=... node scripts/setup-plans.js

Production also needs `CONFIRM_PRODUCTION=yes`. Do not run it twice in the
same environment; that creates a duplicate plan.

### 4. Deploy the functions

Deploys are automatic from GitHub once `docs/DEPLOY-SETUP.md` has been
followed (a browser-only, one-time setup: the two Square secrets in Google
Secret Manager and a deploy key in the repository's secrets).

The remaining settings are not secret and live in `functions/.env`, which is
committed with the **sandbox** values already filled in:

| Setting | Value |
|---|---|
| `SQUARE_ENVIRONMENT` | `sandbox`, later `production` |
| `SQUARE_LOCATION_ID` | from step 2 |
| `SQUARE_PLAN_MONTHLY`, `SQUARE_PLAN_YEARLY` | printed by step 3 |
| `SQUARE_WEBHOOK_URL` | the `squareWebhook` function's URL, exactly as registered in Square |
| `AMPLITUDE_API_KEY` | the Boxes Amplitude project key (optional) |

### 5. Register the webhook in Square
Developer Dashboard > Webhooks > add a subscription pointing at the
`squareWebhook` URL, for these events:

- `subscription.created`, `subscription.updated`
- `invoice.payment_made`, `invoice.scheduled_charge_failed`

Its signature key is the `SQUARE_WEBHOOK_SIGNATURE_KEY` secret, and its URL
must match `SQUARE_WEBHOOK_URL` in `functions/.env` character for character.
If the webhook is registered before the first deploy, one deploy is enough.

### 6. Fill in `billing-config.js`
- `square.applicationId` and `square.locationId`
- `square.environment`: must match the functions' `SQUARE_ENVIRONMENT`
- `amplitudeApiKey` from a new Amplitude project for Boxes

Until the Square ids are filled in, the paywall says subscriptions are not
open and no card form loads. Until the Amplitude key is filled in, nothing is
tracked.

### 7. Allow-list
In the Firebase console, create a `comp` collection. Each document's id is a
lower-case email address (the fields do not matter). **Add your own address
before deploying the rules**, or your account becomes read-only when its trial
ends.

### 8. Test in sandbox before switching to production
With everything pointed at sandbox, subscribe using Square's test card
(4111 1111 1111 1111, any future date, any CVV), check the account unlocks,
then cancel and check the end date shows. Only then repeat steps 2 to 6 with
production values.

## Going live, in this order

1. Functions: already deployed by pushes to `paid-launch`.
2. Merge `paid-launch`. The app deploys, and the database rules deploy
   automatically straight after it.

The order matters. The new rules only allow saving for accounts with a trial,
a subscription or an allow-list entry, and only the new app starts the trial.
Deploying the rules first would leave the old app unable to save.

Existing accounts get a fresh 7-day trial the first time they open the new
version. Their inventory is untouched either way.

## Analytics

Events go straight to Amplitude's HTTP API (`analytics.js`), with no SDK.
They carry counts and yes/no flags only: never item names, box names,
descriptions, locations, notes, photos or email addresses. A test asserts this.

- Visitors in European time zones are asked first and nothing is sent until
  they agree. Everyone else is opted in, with an on/off switch in the menu.
- The choice is mirrored to `users/{uid}/prefs/analytics` so the server-side
  subscription events respect it too.

Events: `session_started`, `trial_started`, `trial_expired`, `box_created`,
`item_created`, `item_updated`, `item_checked_out`, `item_checked_in`,
`search_used`, `bulk_import_completed`, `backup_imported`, `data_exported`,
`voice_input_started`, `voice_input_transcribed`, `voice_input_failed`,
`paywall_shown`, `checkout_started`, `checkout_completed`, `checkout_failed`,
`subscription_cancel_clicked`, and from the server `subscription_started`,
`subscription_renewed`, `subscription_payment_failed`,
`subscription_cancel_requested`, `subscription_ended`.

## Tests

    npm install
    npm test

- `test:unit` - trial logic, event mapping, webhook signatures, Square request shapes
- `test:rules` - the database rules and the billing logic, against the
  Firestore emulator with a stand-in for Square (needs Java)
- `test:ui` - the real app in Chromium against a simulated backend (needs Playwright)

## Not done yet

- Photos still live inside the database records; moving them to Cloud Storage.
- Privacy policy and terms pages.
- An "update my card" screen, and undoing a cancellation before it takes effect.
- The deployed functions, the webhook delivery, the deployed rules, Square's
  real card form in a browser, and Amplitude have not been exercised. Step 8
  is where that gets proven.

## What has been proven against real Square (sandbox)

`npm run test:sandbox` drives the same billing code the functions run against
Square's sandbox. On 2026-11-21 it passed: plan creation, customer and card
creation, monthly and yearly subscriptions with the first payment taken,
refusing a second subscription, cancelling with access to the paid-through
date, and Square's own cancelled record replayed through the webhook handler.

Two things it showed that are worth knowing:

- Square takes the first payment a few seconds after the subscription is
  created, so the renewal date appears shortly after subscribing, not instantly.
- Square deactivates a subscription within seconds, before charging, if the
  customer's email is at a placeholder domain such as example.com. Real
  sign-in addresses are unaffected; the webhook ends access if it ever happens.
