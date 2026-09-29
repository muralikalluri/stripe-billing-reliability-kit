# stripe-billing-reliability-kit

**Stripe subscriptions that stay correct when webhooks arrive late, twice, out of order or not at all.** Two reference implementations (Next.js and Spring Boot) that share one database contract, a failure-injection harness that breaks delivery on purpose against real Stripe test mode, and a reconciliation job that repairs drift.

![CI](https://github.com/muralikalluri/stripe-billing-reliability-kit/actions/workflows/ci.yml/badge.svg)
![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Stripe: test mode only](https://img.shields.io/badge/stripe-test%20mode%20only-635bff.svg)

> All companies, people and data in this repository are fictional (the product is "PageMint").

## Demo

<!-- The GIF is recorded with VHS and is not committed yet: run `vhs docs/demo/failure-demo.tape`
     (script in docs/demo/), then replace this note with: ![Failure-injection demo](docs/demo/failure-demo.gif) -->
_Demo GIF not recorded yet._ Reproduce it with `vhs docs/demo/failure-demo.tape`, or run the scenarios yourself (see [Quickstart](#quickstart)).

## Results

Five failure scenarios, run against real Stripe test mode, per implementation. **Generated from `chaos/results/`; do not edit by hand.** Details, expected vs actual for every check, and run history: [docs/chaos.md](docs/chaos.md).

<!-- chaos:begin -->
<!-- chaos:end -->

`PASS*` = every check passed, but the account's Stripe retry setting ended the subscription as `canceled` instead of `unpaid`. Access is removed either way; the `unpaid` path itself was not exercised.

## Architecture

```mermaid
flowchart LR
  S[Stripe] -- signed webhook --> W["Webhook endpoint<br/>raw body + signature check"]
  W -- "one transaction" --> E[("webhook_events<br/>+ job")]
  E --> K[Worker]
  K -- "fetch latest object" --> S
  K -- "lock + compare-and-set" --> B[("subscriptions")]
  K --> N[("entitlements")]
  R["Reconcile<br/>nightly / on demand"] -- "list + repair" --> B
  R --> N
  A["App access checks"] --> N
```

Subscription states and the access policy for each: [docs/state-machine.md](docs/state-machine.md).

```mermaid
stateDiagram-v2
    [*] --> incomplete
    [*] --> trialing
    incomplete --> active
    incomplete --> incomplete_expired
    trialing --> active
    trialing --> past_due
    active --> past_due: renewal fails
    past_due --> active: retry succeeds
    past_due --> unpaid: retries exhausted
    past_due --> canceled: retries exhausted
    active --> canceled
    active --> paused
    paused --> active
    unpaid --> active: invoice paid
```

## Quickstart

Requirements: Node 20+, Docker, Java 21 + Maven (for Spring), the Stripe CLI, and a Stripe **test-mode** key.

```bash
cp .env.example .env                     # fill in a TEST key; set POSTGRES_PORT if 5432 is taken
docker compose up -d postgres
npm ci && npm run --silent seed:stripe   # creates test-mode products/prices; copy the printed STRIPE_PRICE_* into .env
```

**Next.js**
```bash
cd nextjs && npm ci && npm run db:migrate
npm run dev                              # :3000 (DEMO_AUTH=1 enables the insecure demo login, local only)
npm run worker                           # second terminal
stripe listen --events checkout.session.completed,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,customer.subscription.trial_will_end,invoice.paid,invoice.payment_failed --forward-to localhost:3000/api/webhooks/stripe
```
**Spring Boot**: see [spring-boot/README.md](spring-boot/README.md).

**Tests**
```bash
npm test                                 # seed script + sample repro (repro needs DATABASE_URL)
(cd nextjs && npm run typecheck && npm test)      # Docker: Testcontainers starts Postgres
(cd spring-boot && mvn test)                      # Docker: Testcontainers
```

**Failure scenarios** (live, test mode)
```bash
chaos/targets/nextjs.sh up && chaos/run-all.sh && chaos/targets/nextjs.sh down
chaos/targets/spring-boot.sh up && CHAOS_TARGET=spring-boot chaos/run-all.sh && chaos/targets/spring-boot.sh down
```
See [chaos/README.md](chaos/README.md).

## Features

- **Verified webhooks:** raw-body signature verification before any parsing (Node runtime, not Edge); tampered, re-indented and unsigned payloads are rejected.
- **Idempotent and atomic:** `webhook_events` insert keyed on `event.id` and the job enqueue commit in one transaction; an enqueue failure returns 500 and leaves nothing behind.
- **Order-proof state:** each event triggers a fetch of the latest subscription, then a compare-and-set under per-subscription and per-user locks.
- **One source of truth for access:** `deriveEntitlement`; access checks read only `entitlements`; the checkout success redirect never grants access (it polls server state).
- **Reconciliation:** finds and repairs missed or drifted subscriptions, reports orphans without revoking, and has a circuit breaker for wrong-account/mode situations.
- **Admin:** webhook events with status/attempts/error, retry of failed events, run-reconcile (Next.js page, Spring API), gated by an allowlist.
- **Two implementations, one contract:** same tables (a test compares the schemas) and the same failure scenarios pass on both. See [docs/api-contract.md](docs/api-contract.md).
- **Failure-injection harness:** five scenarios with expected vs actual, generated into the docs.
- **Portability notes:** [Supabase](docs/supabase.md) and [Firebase](docs/firebase.md) pattern guides.

## Design decisions

- **Fetch the latest object instead of trusting the event.** Ordering bugs disappear when state comes from the API; the compare-and-set on `event.created` is the backstop for concurrent workers, and the advisory locks make it race-free.
- **`past_due` grace is anchored on the failed period's start,** because Stripe has already advanced `current_period_end` at renewal. It is deterministic and does not depend on when a webhook was processed.
- **Reconcile never auto-revokes.** An orphan is reported for a human; repairs only go through the same sync path as webhooks.
- **Harness-signed replay for duplicate/out-of-order/tamper.** `stripe events resend` needs a registered endpoint; replaying real events signed with the listener's secret works with only `stripe listen`, and the scenarios check database effects, so they work on any implementation.
- **Every scenario's customer lives on a test clock,** so cleanup deletes its subscriptions and reconcile runs stay clean.
- **Spring uses plain SQL, not JPA,** so the locks and the compare-and-set are explicit; its queue is a transactional outbox with leases instead of pg-boss.

**Limits (what is not proven here):** the hosted Checkout purchase and the Customer Portal were not exercised against real Stripe (scenario subscriptions are created through the API); the `unpaid` retry outcome depends on a Dashboard setting and was not exercised; the renewal scenario waits on Stripe's test-clock processing and can time out (see [chaos/README.md](chaos/README.md)); demo authentication is deliberately insecure and local-only; per-seat Team quantity sync and proration are planned later.

## Sample deliverables

What a client receives, in [sample-deliverable/](sample-deliverable/) (fictional clients):

| Tier | File |
|---|---|
| Starter: fix one issue | [FIX_REPORT_duplicate-credits.md](sample-deliverable/FIX_REPORT_duplicate-credits.md) (with a runnable repro) |
| Standard | [WEBHOOK_HARDENING_REPORT.md](sample-deliverable/WEBHOOK_HARDENING_REPORT.md) |
| Advanced | [SUBSCRIPTIONS_IMPLEMENTATION_HANDOVER.md](sample-deliverable/SUBSCRIPTIONS_IMPLEMENTATION_HANDOVER.md) |

## Hire me

Need Stripe subscriptions and webhooks that hold up in production? [Hire me on Upwork](REPLACE_WITH_YOUR_UPWORK_PROFILE_URL).

## License

MIT. See [LICENSE](LICENSE).
