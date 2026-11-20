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

## One-time setup

### 1. Firebase plan
Move `boxes-ffa31` to the Blaze (pay-as-you-go) plan. The Stripe extension and
Cloud Functions need it.

### 2. Stripe
1. Create or pick the Stripe account and finish identity verification.
2. Create one product, "Boxes", and add metadata `firebaseRole` = `subscriber`.
   The database rules look for exactly that value.
3. Add two recurring prices to it: $3.99 monthly and $29.99 yearly.
4. Do **not** add a trial in Stripe. The trial is tracked by the app, before
   any card exists.

### 3. Stripe extension
Install "Run Payments with Stripe" (`invertase/firestore-stripe-payments`):

- Products collection: `products`
- Customer collection: `customers`
- Sync new users to Stripe: off (customers are created at first checkout)
- Region: `us-central1` (or change `functionsRegion` in `billing-config.js`)

Follow the extension's post-install steps to add its webhook in Stripe and
enable the customer portal (allow cancelling and updating the card).

### 4. Fill in `billing-config.js`
- `stripePriceId` for each plan (they start with `price_`)
- `amplitudeApiKey` from a new Amplitude project for Boxes

Until the price ids are filled in, the paywall says subscriptions are not open
and no checkout can start. Until the Amplitude key is filled in, nothing is
tracked.

### 5. Allow-list
In the Firebase console, create a `comp` collection. Each document's id is a
lower-case email address (the fields do not matter). **Add your own address
before deploying the rules**, or your account becomes read-only when its trial
ends.

### 6. Subscription events (optional, recommended)
`functions/` reports subscription started / renewed / cancelled / ended to
Amplitude from the server. Set `AMPLITUDE_API_KEY` when deploying:

    cd functions && npm install && cd ..
    firebase deploy --only functions

## Going live, in this order

1. Merge `paid-launch` and let the app deploy.
2. Then deploy the rules: `firebase deploy --only firestore:rules`.

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
`paywall_shown`, `checkout_started`, `checkout_failed`, `checkout_cancelled`,
and from the server `subscription_started`, `subscription_renewed`,
`subscription_cancel_requested`, `subscription_cancel_reversed`,
`subscription_ended`.

## Tests

    npm install
    npm test

- `test:unit` - trial/subscription logic and subscription-event mapping
- `test:rules` - the database rules, against the Firestore emulator (needs Java)
- `test:ui` - the real app in Chromium against a simulated backend (needs Playwright)

## Not done yet

- Photos still live inside the database records; moving them to Cloud Storage.
- Privacy policy and terms pages.
- In-app "delete my account and data".
- Stripe, the extension, the deployed rules and Amplitude have not been
  exercised end to end; that needs the accounts above.
