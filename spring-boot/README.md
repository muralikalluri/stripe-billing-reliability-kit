# PageMint: Spring Boot reference implementation

Java 21 · Spring Boot 3.5 · stripe-java · Flyway · Spring Security (JWT resource server) · plain JDBC.
Same tables and webhook behaviour as the Next.js implementation: see [../docs/api-contract.md](../docs/api-contract.md).

## Run
```bash
docker compose up -d postgres                       # from the repo root (set POSTGRES_PORT if 5432 is taken)
# create the app's own database once:
docker compose exec postgres psql -U pagemint -d postgres -c "create database pagemint_spring"
export SPRING_DATASOURCE_URL=jdbc:postgresql://localhost:5432/pagemint_spring   # use your POSTGRES_PORT
export STRIPE_SECRET_KEY=sk_test_...   STRIPE_WEBHOOK_SECRET=whsec_...   # TEST mode only
export STRIPE_PRICE_PRO_MONTHLY=price_... STRIPE_PRICE_PRO_YEARLY=price_... STRIPE_PRICE_TEAM_SEAT=price_...
export JWT_SECRET=<at least 32 random bytes>  ADMIN_EMAILS=you@example.com
mvn package && java -jar target/pagemint-billing.jar         # :3200
stripe listen --events customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,customer.subscription.trial_will_end,invoice.paid,invoice.payment_failed,checkout.session.completed --forward-to localhost:3200/api/webhooks/stripe
```
One-shot reconcile (no web server): `java -jar target/pagemint-billing.jar --reconcile` (report at `$RECONCILE_REPORT_PATH`, default `reconcile-report.json`).
Nightly reconcile runs at 03:00 UTC unless `DISABLE_SCHEDULE=1`.

## Test
```bash
mvn test        # needs Docker: Testcontainers starts Postgres 16
```
Covers: `deriveEntitlement` (case-for-case with the Next.js tests), signature verification (tampered, re-indented, wrong secret, missing header, expired timestamp), idempotent ingest incl. concurrent duplicates and enqueue-failure rollback, the compare-and-set and the per-user concurrency race, reconcile (missed webhook, test-clock listing, breaker, orphans, partial failure), security (401/403), and a schema-parity test against the drizzle migrations.

## Design notes
- **Queue:** transactional outbox (`event_jobs`), claimed with `FOR UPDATE SKIP LOCKED` and a 300s lease; retries back off 5s × 2^n, parked after 5 retries (kept visible). The Next.js side uses pg-boss; the guarantee is the same: the job row commits atomically with the `webhook_events` row.
- **Webhook body:** `byte[]`, verified with `Webhook.Signature.verifyHeader` before Jackson touches it; the event is parsed as plain JSON afterwards, so a stripe-java/API-version mismatch cannot silently drop fields. stripe-java 33.4.2 pins the same API version as the Node SDK used by the Next.js app.
- **Sync:** `JdbcTemplate`, no JPA, so the compare-and-set and advisory locks are explicit SQL; `hashtext()` runs in Postgres, so lock keys are identical to the Next.js implementation.
- **Auth:** bearer JWT (HS256), identity only from the verified `sub`. This app does not mint tokens.
- **Scope:** webhook, entitlement API, admin endpoints and the reconcile CLI. No checkout/portal (the Next.js app has those).
