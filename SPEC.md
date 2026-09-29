# SPEC — stripe-billing-reliability-kit

> Stripe subscriptions that stay correct when webhooks arrive late, twice, out of order or not at all. Next.js and Spring Boot reference implementations, a failure-injection demo, and a reconciliation job that keeps your database in sync with Stripe.

## 1. Purpose and positioning

Public proof for the Upwork listing **"A working Stripe integration with secure webhooks and subscriptions"** ($150 / $350 / $750).

| Listing claim | Proof in this repo |
|---|---|
| Webhooks that never arrive | Reconciliation job repairs state from the Stripe API; demo: stop the webhook listener, pay, then run reconcile |
| Events processed twice | Idempotency table keyed by `event.id`; demo: `stripe events resend` twice → one effect |
| Users who paid but didn't get access | Entitlements derived from subscription state; success page polls server-side state, never trusts the redirect alone |
| Subscriptions out of sync with the database | State machine + "fetch latest object from API" on each event + nightly reconcile |
| Verified webhook signatures | Raw-body signature verification in both stacks; test proves a tampered payload is rejected |
| Works with Next.js, Node, Supabase, Firebase, Java/Spring Boot | Next.js (Node runtime) reference and Spring Boot reference; `docs/supabase.md` and `docs/firebase.md` show the same pattern in Edge Functions / Cloud Functions |
| Tested in test mode before live | Stripe CLI, test clocks for renewals/trial end/dunning, fixtures in repo |

## 2. Fictional product

**"PageMint"** — a small SaaS with plans: Free, Pro monthly/yearly, Team (per-seat). 14-day trial on Pro. Customer Portal for upgrades, downgrades, cancellation and payment method updates.

## 3. Core design (shared by both implementations)

### 3.1 Tables
- `customers(user_id, stripe_customer_id)`
- `subscriptions(id, user_id, stripe_subscription_id, status, price_id, quantity, current_period_end, cancel_at_period_end, updated_from_event_created, updated_at)`
- `entitlements(user_id, plan, seats, valid_until)` — the only table the app checks for access
- `webhook_events(event_id PK, type, received_at, processed_at, status, error, attempts)`

### 3.2 Webhook handling rules
1. Read the **raw body**; verify signature with the endpoint secret; reject otherwise (400).
2. Insert `event_id` into `webhook_events`; on conflict → already processed → return 200 (idempotency).
3. Return 200 quickly; process in a background job (outbox/queue). A failed job retries with backoff and is visible in an admin page.
4. **Don't trust event order.** For subscription events, fetch the latest subscription from the Stripe API (or compare `event.created` with `updated_from_event_created`) and apply only if newer.
5. Recompute `entitlements` from subscription state in one function (`deriveEntitlement`), used by webhooks, reconcile and the success page.

### 3.3 Subscription state machine
`incomplete → trialing → active → past_due → (active | unpaid | canceled)`, plus `incomplete_expired` and `paused`. Access policy per state is documented in a table (e.g., `past_due` keeps access for a grace period; `unpaid`/`canceled` removes it). Mermaid diagram in README.

### 3.4 Events handled
`checkout.session.completed`, `customer.subscription.created|updated|deleted`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.trial_will_end`.

### 3.5 Reconciliation job
Lists subscriptions from Stripe (paginated, `updated` filter where possible), compares with the DB, repairs differences, logs a drift report (`reconcile-report.json`). Runs nightly and on demand from the admin page.

## 4. Implementations

| Folder | Stack | Notes |
|---|---|---|
| `nextjs/` | Next.js App Router (Node runtime for the webhook route), TypeScript, Drizzle + Postgres, Auth.js, pg-boss for jobs | Checkout, Customer Portal, pricing page, account page, admin "webhook events" page |
| `spring-boot/` | Java 21, Spring Boot 3, stripe-java, Flyway, Spring Security, scheduled reconcile | Same API contract and tables; shows the Java side of the listing |

Both share `docs/`, the failure-injection scripts and the test scenarios.

## 5. Failure-injection demo (`chaos/`)

Scripts that make the README GIF and Loom compelling:

| Scenario | Script | Expected outcome |
|---|---|---|
| Duplicate delivery | `resend-twice.sh` | One entitlement grant, second delivery logged as duplicate |
| Out-of-order | `out-of-order.sh` (replays `updated` before `created`) | Final state matches Stripe |
| Missed webhook | `drop-webhooks.sh` (stop listener, complete checkout, start listener) | Reconcile restores access; drift report shows 1 repair |
| Tampered payload | `tamper.sh` | 400, nothing processed |
| Renewal failure | Test clock advance + failing card | `past_due` → grace → access removed on `unpaid` |

## 6. Tests
- Unit: `deriveEntitlement` for every state; signature verification; idempotency.
- Integration: Postgres via Testcontainers; Stripe API stubbed with stripe-mock for CI; opt-in live test-mode suite using Stripe CLI + test clocks.
- Playwright e2e (Next.js): pricing → checkout (test card) → access granted.

## 7. Sample deliverables (`sample-deliverable/`)

| Tier | File | Content |
|---|---|---|
| Starter — Fix One Issue ($150) | `FIX_REPORT_duplicate-credits.md` | Symptom, root cause, fix diff, test added, how it was verified in test mode |
| Standard | `WEBHOOK_HARDENING_REPORT.md` | Audit of an existing integration against the rules in §3.2 + fixes |
| Advanced | `SUBSCRIPTIONS_IMPLEMENTATION_HANDOVER.md` | Full implementation handover: architecture, state machine, runbook, reconcile ops |

## 8. Milestones

| M | Scope | Done when | MVP? |
|---|---|---|---|
| M0 | Repo, compose (Postgres), CI, Stripe CLI setup docs, product/price seed script | CI green | ✅ |
| M1 | Next.js: auth, pricing, checkout, portal, webhook route with signature verify + idempotency + job queue | Test-mode purchase grants access | ✅ |
| M2 | State machine, `deriveEntitlement`, out-of-order handling, success-page polling | Unit tests for all states pass | ✅ |
| M3 | Reconcile job + admin events page | Missed-webhook scenario recovers | ✅ |
| M4 | `chaos/` scripts + README GIF | All 5 scenarios demonstrated | ✅ |
| M5 | Spring Boot implementation (same contract) | Same scenarios pass against Spring Boot | ✅ |
| M6 | Sample deliverables + Supabase/Firebase docs | Portfolio checklist met | ✅ |
| M7 | Per-seat Team plan with quantity sync, proration preview | Later | — |
