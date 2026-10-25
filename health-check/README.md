# Stripe billing health check

A free, read-only check for the Stripe mistakes that cost SaaS teams money: paid customers without access, double credits, cancellations that never revoke access, and webhooks that silently stopped arriving. No dependencies; Node 20+.

```bash
# 1) Scan your code (nothing is uploaded; it only reads files)
node health-check/cli.mjs scan /path/to/your/app --out stripe-health.md

# 2) Check your Stripe account's webhook setup (GET requests only)
STRIPE_API_KEY=rk_live_... node health-check/cli.mjs stripe --out stripe-account.md

# both in one report
STRIPE_API_KEY=rk_live_... node health-check/cli.mjs all /path/to/your/app --out stripe-health.md
```

For the account check, create a **restricted key** in the Stripe Dashboard (Developers → API keys → Create restricted key) with **Read** access to *Webhook Endpoints*, *Events* and *Subscriptions*, and nothing else. A test-mode key (`sk_test_`) also works. The tool refuses publishable keys and only ever sends GET requests (a test enforces this).

Exit code: `0` no critical/high findings, `1` critical/high findings (usable in CI), `2` usage or API error.

## What it checks

**Code** (JavaScript/TypeScript, Java/Kotlin, Python, Ruby, PHP, Go):

| Rule | Finds | Severity |
|---|---|---|
| H1 | Webhooks processed without Stripe signature verification | Critical |
| H2 | Signature checked against a parsed body (`express.json()` first, `req.json()`, `JSON.stringify(req.body)`) | High |
| H3 | Edge runtime with the synchronous `constructEvent` | High |
| H4 | No duplicate-event protection (nothing records `event.id`) | High (likely) |
| H5 | Access granted from the checkout success redirect | High (likely) |
| H6 | Missing lifecycle events: `customer.subscription.deleted` / `.updated`, `invoice.payment_failed` | High / Medium |
| H7 | Stripe keys or webhook secrets committed to source, `.env` tracked in git | Critical / High |
| H8 | Subscription status taken from the event payload instead of fetching the latest object | Medium (likely) |
| H9 | No reconciliation job | Low (likely) |

**Stripe account**:

| Rule | Finds |
|---|---|
| S1 | No webhook endpoint registered |
| S2 | Endpoint disabled (Stripe disables endpoints after repeated failures) |
| S3 | Endpoint not subscribed to the subscription lifecycle events |
| S4 | Live endpoint on a tunnel / localhost / plain-HTTP URL |
| S5 | Several endpoints pointing at the same URL (every event arrives more than once) |
| S6 | Events in the last 30 days that were never delivered successfully, by type |
| S7 | Endpoint pinned to a different API version than recent events (payload shape drift) |
| S8 | past_due / unpaid subscriptions to check against your access rules |

"Likely" findings are heuristics and need a human look; "definite" ones are the bug itself. The scanner is tested against three deliberately broken example apps in [examples/](examples/) (see their generated reports) and against this repository's own Next.js and Spring Boot implementations, which scan clean.

## Limits

It reads source text; it cannot follow logic spread across many files or frameworks it doesn't recognise, and Stripe only keeps events for 30 days. It is a quick first check, not a full review. Each rule corresponds to a mechanism implemented and tested against real Stripe test mode in this repository.
