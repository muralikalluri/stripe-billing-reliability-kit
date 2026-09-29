# Shared contract (both implementations)

Both implementations expose the same webhook behaviour, the same Postgres tables and a reconcile command with the same report. The chaos harness depends only on what is written here.

## Webhook
`POST <base>/api/webhooks/stripe` (Next.js: `runtime = "nodejs"`; Spring: `@RequestBody byte[]`)

| Step | Behaviour |
|---|---|
| 1 | Verify `Stripe-Signature` over the **raw body** before any parsing (300s tolerance). Missing/invalid: `400`, nothing written. |
| 2 | In ONE transaction: `INSERT INTO webhook_events ... ON CONFLICT (event_id) DO NOTHING` and enqueue a job (only when the insert won). |
| 3 | `200 {"received":true,"duplicate":<bool>}`. If the enqueue fails, the transaction rolls back and the response is `500` so Stripe retries. |

A worker then processes the event: claim (`status <> 'processed'`, `attempts + 1`), fetch the **latest subscription from Stripe**, compare-and-set upsert under per-subscription and per-user advisory locks, recompute `entitlements` with `deriveEntitlement`, and mark `processed` (or `failed` with `error`, then retry with backoff).

## Tables
Same names and columns in both (the Spring `SchemaParityIT` test compares Flyway's schema with the drizzle migrations):
`users`, `customers`, `subscriptions`, `entitlements`, `webhook_events`, `reconcile_runs`.
Queue state is implementation-specific and excluded from the contract: pg-boss (`pgboss.*`) for Next.js, `event_jobs` for Spring.

`webhook_events.status`: `received` → `processing` → `processed` | `failed`. A row can read `failed` between retries; it is only dead once the queue stops retrying.

## Access policy
`deriveEntitlement` in both: see [state-machine.md](state-machine.md). Constants: 3 days renewal buffer, 3 days `past_due` grace (anchored on `current_period_start`). Access checks read `entitlements` only and compare `valid_until` with the clock.

## Reconcile
Same drift kinds (`missing_in_db`, `field_mismatch`, `entitlement_stale`, `orphan`), actions (`repaired`, `failed`, `skipped`, `reported`), circuit breaker (ratio 0.5, minimum 20) and per-customer listing (test-clock subscriptions).

| | Command | Report |
|---|---|---|
| Next.js | `npm --prefix nextjs run reconcile` | JSON at `$RECONCILE_REPORT_PATH` (default `reconcile-report.json`) |
| Spring | `java -jar spring-boot/target/pagemint-billing.jar --reconcile` | same |

Report shape (camelCase): `runId, trigger, startedAt, finishedAt, complete, scanned, counts{inSync,repaired,failed,skipped,reported}, circuitBreakerTripped, drift[{stripeSubscriptionId,userId,kind,fields?,action,error?}]`.

## HTTP API (Spring minimum scope)
Bearer JWT (HS256, `sub` = user id, `email` claim for admin); tokens come from your identity provider.

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/webhooks/stripe` | Stripe signature | webhook |
| `GET /api/me/entitlement` | JWT | `{"access":bool,"plan"?}`, `Cache-Control: no-store`, reads `entitlements` only |
| `GET /api/admin/events[?status=]` | admin | webhook events |
| `POST /api/admin/events/{id}/retry` | admin | requeue a `failed` event (409 otherwise) |
| `POST /api/admin/reconcile` | admin | run a reconcile now |

Admin = email in `ADMIN_EMAILS` (unset = nobody). The Next.js app additionally has pricing/checkout/portal/account UI; the Spring implementation stops at the API above (no checkout or portal) by design.
