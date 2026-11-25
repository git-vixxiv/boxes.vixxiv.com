# One-time setup for automatic deploys

After this, nobody runs deploy commands. Pushing code deploys it:

| What | When it deploys |
|---|---|
| Cloud Functions (Square billing, webhook, account deletion) | On every push that changes `functions/`. Safe at any time; the live app does not use them until the paid version is released. |
| Database rules | Only when the paid version is merged to the live branch, straight after the app itself has deployed. |
| The app | As before, when the live branch changes. |
| A test build of the paid version | On every push to `paid-launch`, to a separate preview address that does not affect the live site. The address is shown in the run summary of "Publish test build" under the repository's Actions tab. |

Everything below is done in a browser, signed in as the Google account that
owns the Boxes Firebase project. Do the steps in order.

## 1. Put the project on the Blaze plan

<https://console.firebase.google.com/project/boxes-ffa31/usage/details>
> Modify plan > Blaze. Cloud Functions cannot be deployed without it.

## 2. Store the two Square secrets

<https://console.cloud.google.com/security/secret-manager?project=boxes-ffa31>

If asked, click **Enable** for the Secret Manager API. Then **Create secret**,
twice. The names must be exactly these, in capitals:

| Name | Secret value |
|---|---|
| `SQUARE_ACCESS_TOKEN` | Your Square **sandbox** access token (Developer Dashboard > the Boxes application > Credentials, Sandbox). |
| `SQUARE_WEBHOOK_SIGNATURE_KEY` | The **Signature key** on the webhook's page (Developer Dashboard > Webhooks > Subscriptions > your webhook). |

Leave every other setting as it is and click **Create secret**.

## 3. Create the deploy key

<https://console.cloud.google.com/iam-admin/serviceaccounts?project=boxes-ffa31>

1. **Create service account**. Name it `github-deploy`. Click **Create and continue**.
2. Under "Grant this service account access", choose the role **Owner**
   (type "Owner" in the role box; it is under Basic). Click **Done**.
3. In the list, click the new `github-deploy@...` account, open the **Keys**
   tab, then **Add key > Create new key > JSON > Create**. A `.json` file
   downloads.

Why Owner: the first deploy of this kind has to switch on several Google
services and grant them permissions, which only an Owner can do. The key only
works on the Boxes project, nothing else in your Google account. It can be
narrowed after the first successful deploy.

If Google says key creation is disabled by an organization policy, stop and
say so; there is another way to connect GitHub that needs no key.

## 4. Give the key to GitHub

<https://github.com/git-vixxiv/boxes.vixxiv.com/settings/secrets/actions>

1. **New repository secret**.
2. Name: `FIREBASE_SERVICE_ACCOUNT`
3. Secret: open the downloaded `.json` file in a text editor, select all, copy,
   paste. It starts with `{` and ends with `}`.
4. **Add secret**.

Then delete the downloaded file from your computer. GitHub hides the value
after saving; nobody, including Claude, can read it back.

## 5. Run the first deploy

<https://github.com/git-vixxiv/boxes.vixxiv.com/actions/workflows/deploy-functions.yml>

Open the most recent run and click **Re-run all jobs** (or tell Claude the
secrets are in, and the next push deploys). It takes about five minutes the
first time.

When it finishes, the log of the "Deploy functions" step lists a **Function
URL** for `squareWebhook`. It must be exactly the URL saved in Square:

    https://us-central1-boxes-ffa31.cloudfunctions.net/squareWebhook

If it is different, change `SQUARE_WEBHOOK_URL` in `functions/.env` and the
webhook in Square so that all three match.

## 6. Check the webhook

In the Square Developer Dashboard, open the webhook and use **Send test
event**. Square should report a `200` response.

## Going to production later

Replace the value of `SQUARE_ACCESS_TOKEN` and `SQUARE_WEBHOOK_SIGNATURE_KEY`
in Secret Manager (add a new version of each) with the production ones, and
update `functions/.env` and `billing-config.js` as described in
`docs/PAID-LAUNCH.md`.
