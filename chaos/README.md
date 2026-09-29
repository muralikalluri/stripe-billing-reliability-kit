# Failure-injection scenarios

Five scenarios that break webhook delivery on purpose, then check the system ends up correct. Results are written to `chaos/results/<target>/<scenario>.json`; `docs/chaos.md` is rendered from those files (never hand-edited).

| Script | Scenario | How the failure is injected |
|---|---|---|
| `resend-twice.sh` | Duplicate delivery | one real Stripe event, harness-signed and POSTed 3 times |
| `out-of-order.sh` | Out-of-order | real `updated` delivered before real `created` (created 2s apart) |
| `drop-webhooks.sh` | Missed webhook | no listener running while a subscription is created, then reconcile |
| `tamper.sh` | Tampered payload | body altered / re-indented / wrong secret / unsigned after signing |
| `renewal-failure.sh` | Renewal failure | test clock + a card that attaches but fails to charge; `stripe listen` delivers |

## Run
```bash
cp .env.example .env            # fill in a Stripe TEST key; see docs/stripe-cli.md
npm --prefix chaos ci
chaos/targets/nextjs.sh up      # postgres + app (:3100) + worker
chaos/run-all.sh                # runs all five, then regenerates docs/chaos.md
chaos/targets/nextjs.sh down
```
Single scenario: `chaos/tamper.sh`. Scenarios use their own `chaos_<run>_*` users and Stripe customers and clean them up afterwards.

## Implementation-agnostic contract
The runner imports nothing from `nextjs/`. A target only needs: the webhook URL (`WEBHOOK_URL`), the shared Postgres tables (`users`, `customers`, `subscriptions`, `entitlements`, `webhook_events`), and a reconcile command (`RECONCILE_CMD`) that writes its report JSON to `$RECONCILE_REPORT_PATH`. Set `CHAOS_TARGET` to name the results folder.

## Safety
The harness refuses to run unless the key is a Stripe **test** key and `DATABASE_URL` is local, aborts on any `livemode` event, and scrubs key-shaped strings from results.

## Notes and limits
- Duplicate/out-of-order/tamper use **harness-signed replay** of real events, not `stripe events resend` (that needs a registered endpoint; only `stripe listen` is used here).
- The renewal-failure test-clock timestamps are simulated time, so access is checked against the clock (`valid_until > clock`), not the wall clock.
- Whether retries end in `unpaid` or `canceled` is a Stripe Dashboard setting. If it ends `canceled`, the verdict is `PASS*`: access is removed either way, but the `unpaid` path was not exercised.
