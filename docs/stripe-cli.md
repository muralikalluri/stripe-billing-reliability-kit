# Stripe CLI setup (test mode only)

Everything in this kit runs against Stripe **test mode**. Never use live keys.

## 1. Install and log in
```bash
brew install stripe/stripe-cli/stripe   # or see https://docs.stripe.com/stripe-cli
stripe login                            # pick a sandbox / test account
```

## 2. Configure env
```bash
cp .env.example .env
```
Set `STRIPE_SECRET_KEY` to your **test** secret key (Dashboard → Developers → API keys, with "Test mode" on). The seed script refuses anything that is not `sk_test_` / `rk_test_`.

## 3. Start Postgres
```bash
docker compose up -d postgres
```

## 4. Seed products and prices (idempotent)
```bash
npm ci
set -a; . ./.env; set +a
npm run seed:stripe
```
Copy the printed `STRIPE_PRICE_*` lines into `.env`. Re-running is safe: prices are found by `lookup_key` (`pro_monthly`, `pro_yearly`, `team_seat_monthly`).

## 5. Forward webhooks to your local app
```bash
stripe listen --forward-to localhost:3000/api/webhooks/stripe
```
The CLI prints a `whsec_...` signing secret; put it in `.env` as `STRIPE_WEBHOOK_SECRET`.

## 6. Useful commands
```bash
stripe trigger checkout.session.completed
stripe events resend evt_XXXX --webhook-endpoint=we_XXXX
stripe test_helpers test_clocks create --frozen-time=$(date +%s)   # renewals / dunning
```
Test cards: `4242 4242 4242 4242` (success), `4000 0000 0000 0341` (attaches, then charge fails — used for the renewal-failure scenario).
