# Live end-to-end test (Playwright)

Pricing -> **hosted Stripe Checkout with the 4242 test card** -> webhook -> worker -> access -> Customer Portal, in a real browser against **Stripe test mode**.

What it proves, in order: sign in; no access before paying; subscribe to Pro monthly on the real Checkout page; the success page reports the plan only after the webhook worker granted it; the database has a `trialing` subscription (the 14-day Pro trial), a Pro entitlement and only `processed` webhook events; the account page and `/api/me/entitlement` (uncached) agree; the billing portal opens for that subscription. It creates one throwaway user and Stripe customer and deletes both.

## Run
Needs Docker Postgres up and migrated, a populated `.env` (TEST key, webhook secret from `stripe listen --print-secret`, seeded prices), the Stripe CLI, and `npx playwright install chromium` once.

```bash
set -a; . ../.env; set +a       # from nextjs/
npm run e2e
```
The run starts what it needs: the dev server (demo login only works in dev), the queue worker, and a `stripe listen` forwarder. It refuses to run without a Stripe test key or with a non-local database, and refuses if the listener's signing secret differs from `STRIPE_WEBHOOK_SECRET` (compared by hash).

It is **opt-in and live**, so it is not part of `npm test` or CI. Port 3100 is used because 3000 is often taken.

## Notes
- The hosted Checkout page is Stripe's markup. The selectors (`#cardNumber`, `#cardExpiry`, `#cardCvc`, `#billingName`, `hosted-payment-submit-button`) may need updating if Stripe changes it.
- If your shell shows a coding-agent tool as the parent, `next dev` may generate agent instruction files in `nextjs/`; delete them, they are not part of this project.

For a quicker check of the app's HTTP routes without paying (login, pricing, Checkout/Portal session creation, admin page), see `npm run flows:live` at the repository root (`scripts/live/app-flows.mjs`).
