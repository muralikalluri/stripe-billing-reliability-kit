# PageMint — Next.js reference implementation

Next.js App Router · Node runtime for webhooks · Drizzle + Postgres · Auth.js · pg-boss.

## Run
```bash
docker compose up -d postgres            # from repo root (set POSTGRES_PORT if 5432 is taken)
cp ../.env.example ../.env               # fill in TEST keys; export the vars, or use `set -a; . ../.env`
npm ci && npm run db:migrate
npm run dev                              # app on :3000
npm run worker                           # in a second terminal: processes queued events
stripe listen --forward-to localhost:3000/api/webhooks/stripe
```
Set `DEMO_AUTH=1` in `.env` (local only), then sign in at `/login` (demo auth: email only), subscribe at `/pricing` with test card `4242 4242 4242 4242`. Access is granted by the worker after the webhook, visible at `/account`.

## Test
```bash
npm run typecheck && npm test            # needs Docker (Testcontainers starts Postgres)
```

## Webhook flow
`POST /api/webhooks/stripe` → raw body → verify signature (400 if bad) → one transaction: `INSERT webhook_events ON CONFLICT DO NOTHING` + pg-boss `send` → 200. If the enqueue fails the transaction rolls back and the route returns 500 so Stripe retries. The worker recomputes state from the latest Stripe subscription and writes `entitlements`.

> **Deliberately insecure for demonstration. Do not deploy.** Demo auth (`DEMO_AUTH=1`, disabled in production builds) is email-only with no verification, so anyone can sign in as anyone, including an `ADMIN_EMAILS` address. Replace it with a real Auth.js provider before any real use; the admin gate is only as strong as your auth.

## Reconciliation and admin (M3)
- `npm run reconcile` runs one reconcile now and writes `reconcile-report.json` (also stored in `reconcile_runs`). The worker runs it nightly (03:00 UTC) and on demand from `/admin/events`.
- Detection uses Stripe's subscription listing (plus a per-customer listing, because Stripe hides test-clock subscriptions from the global list); repairs go through `syncSubscription` only (fresh fetch under the lock, `version=null` so the event clock is never moved). Drift kinds: `missing_in_db`, `field_mismatch`, `entitlement_stale`, `orphan` (reported, never auto-revoked). A circuit breaker stops repairs if most subscriptions drift (wrong account/mode guard).
- `/admin/events` (webhook events with status/attempts/error, retry for failed events, run-reconcile button, latest drift report) is visible only to emails in `ADMIN_EMAILS`; everyone else gets a 404, and every action re-checks.
- The Stripe subscription list has no `updated` filter (SPEC §3.5 assumed one), so reconcile scans everything. Fine for a kit; for large accounts diff `events.list` against `webhook_events` instead.

## Auth in production
The demo login is **disabled in production builds** (`next start`), by design: it lets anyone sign in as anyone. Use `npm run dev` for local demos with `DEMO_AUTH=1`.

For a real deployment, configure a real Auth.js provider (email magic link, OAuth, ...) in `src/auth.ts`, and set `AUTH_SECRET`. Auth.js also refuses hosts it does not trust in production: set `AUTH_URL` to your public URL (or `AUTH_TRUST_HOST=true` behind a proxy you control), otherwise every `/api/auth/*` call fails with `UntrustedHost`. The billing code only needs `session.user.id` and `session.user.email`.

## Live end-to-end test
`npm run e2e` drives a real browser through pricing, the hosted Checkout page (4242 test card), the webhook worker and the billing portal. It is opt-in and needs your Stripe test keys: see [e2e/README.md](e2e/README.md).
