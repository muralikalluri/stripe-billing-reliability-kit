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

# the SAME scenarios against the Spring Boot implementation (own database, app on :3200):
chaos/targets/spring-boot.sh up
CHAOS_TARGET=spring-boot chaos/run-all.sh
chaos/targets/spring-boot.sh down
```
`CHAOS_TARGET` picks `chaos/targets/<target>.env.sh`, which is applied AFTER `.env`, so `.env` cannot switch which implementation is tested. The Spring target file also overrides `DATABASE_URL`, `WEBHOOK_URL` and `RECONCILE_CMD`; the Next.js target only defaults `RECONCILE_CMD`, so a `WEBHOOK_URL`/`RECONCILE_CMD` set in `.env` would still apply there.
Single scenario: `chaos/tamper.sh`. Scenarios use their own `chaos_<run>_*` users and Stripe customers and clean them up afterwards.

## Implementation-agnostic contract
The runner imports nothing from `nextjs/`. A target only needs: the webhook URL (`WEBHOOK_URL`), the shared Postgres tables (`users`, `customers`, `subscriptions`, `entitlements`, `webhook_events`), and a reconcile command (`RECONCILE_CMD`) that writes its report JSON to `$RECONCILE_REPORT_PATH`. Set `CHAOS_TARGET` to name the results folder.

## Safety
The harness refuses to run unless the key is a Stripe **test** key and `DATABASE_URL` is local, aborts on any `livemode` event, and scrubs key-shaped strings from results.

## Notes and limits
- Every scenario's customer lives on a Stripe **test clock**; deleting the clock at cleanup deletes its subscriptions, so runs leave nothing behind in the account's subscription list (a leftover canceled subscription would show up in later reconcile runs).
- Correct ordering in the out-of-order scenario comes from the worker **re-fetching the latest subscription from Stripe**, not from re-sequencing payloads; `event_clock_not_regressed` is the check that the compare-and-set guard also held.
- Duplicate delivery is proven by database effects (one row, `attempts = 1`, nothing rewritten), not by a response flag, so the same check works on any implementation.
- "Missed webhook" creates the subscription through the API rather than the hosted Checkout page; the Checkout path is not exercised here.
- **The renewal scenario is the least reliable one.** Its recorded history has more failures on the Spring target, but a later full verification run (not recorded in the history file) timed out on BOTH targets, so the asymmetry may be chance. It waits for Stripe to process test-clock advances. While debugging failed Spring runs, the diagnostics the harness now captures (`evidence.diagnostics_on_failure` in a failing result file) showed Stripe's renewal invoice still in `draft` with zero payment attempts long after the clock passed its finalization time, while every webhook Stripe had sent was received and processed: the wait ended before Stripe produced the failure event. Those particular result files were overwritten by later runs and are not committed, so this is an observation, not retained evidence; any future failing run keeps its diagnostics in its result file until the next run overwrites it. It points at Stripe-side latency, but it is **not proven**: run order and time-of-day effects were not ruled out. The per-run pass/fail counts are generated into [docs/chaos.md](../docs/chaos.md) from `history.jsonl`; read them before trusting either verdict. Only the latest run's checks are kept in `renewal-failure.json`.
- The renewal scenario judges access by comparing the stored `valid_until` to the test clock (the app's own check uses the wall clock). The app's clock-based expiry is covered by `nextjs/test` unit/integration tests, not by this scenario.
- Duplicate/out-of-order/tamper use **harness-signed replay** of real events, not `stripe events resend` (that needs a registered endpoint; only `stripe listen` is used here).
- The renewal-failure test-clock timestamps are simulated time, so access is checked against the clock (`valid_until > clock`), not the wall clock.
- Whether retries end in `unpaid` or `canceled` is a Stripe Dashboard setting. If it ends `canceled`, the verdict is `PASS*`: access is removed either way, but the `unpaid` path was not exercised.
