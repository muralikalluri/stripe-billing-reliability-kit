# The same pattern on Supabase (Edge Functions + Postgres)

> **Pattern sketch, not executed in this repository.** The reference implementations here are Next.js and Spring Boot. Supabase gives you Postgres (the tables in [api-contract.md](api-contract.md) apply unchanged) and Deno-based Edge Functions, so the rules from SPEC §3.2 map directly. Test the function with the Stripe CLI and the chaos scenarios (point `WEBHOOK_URL` at it) before trusting it.

## Mapping the rules

| Rule | On Supabase |
|---|---|
| Raw body, verify before parsing | `await req.text()`, then `stripe.webhooks.constructEventAsync(body, sig, secret)` (async crypto in Deno) |
| Idempotent insert on `event_id` | `insert ... on conflict (event_id) do nothing returning` |
| Return 200 fast, process in a job | insert the event + a job row in one SQL function call; process with a second function invoked by a queue (`pgmq`) or `pg_cron` |
| Access reads `entitlements` only | RLS: users can `select` their own `entitlements` row and nothing else; only the service role writes |
| Repair missed events | a scheduled function (`pg_cron` + `pg_net`) that runs reconcile nightly |

## Database
Use the same schema (see `nextjs/drizzle/*.sql` or `spring-boot/src/main/resources/db/migration/V1__schema.sql`). Row level security:

```sql
alter table entitlements enable row level security;
create policy "own entitlement" on entitlements for select using (user_id = auth.uid()::text);
-- no insert/update/delete policies: only the service role (which bypasses RLS) writes.
alter table webhook_events enable row level security;      -- no policies: service role only
alter table subscriptions enable row level security;       -- no policies (or select-own if the app needs it)
```

Atomic "insert event and enqueue" as one call (so a failure leaves no orphan row):

```sql
create or replace function ingest_stripe_event(p_id text, p_type text, p_payload jsonb)
returns boolean language plpgsql security definer as $$
declare inserted boolean;
begin
  insert into webhook_events (event_id, type) values (p_id, p_type)
    on conflict (event_id) do nothing;
  get diagnostics inserted = row_count;            -- 1 when this delivery won
  if inserted then
    perform pgmq.send('stripe_events', p_payload); -- or insert into your own jobs table
  end if;
  return inserted;
end $$;
revoke all on function ingest_stripe_event from public, anon, authenticated;
```

## Edge Function (webhook)
```ts
// supabase/functions/stripe-webhook/index.ts
import Stripe from "npm:stripe";
import { createClient } from "npm:@supabase/supabase-js";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!);           // TEST key until sign-off
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

Deno.serve(async (req) => {
  const body = await req.text();                                          // raw body, unparsed
  const sig = req.headers.get("stripe-signature");
  if (!sig) return new Response("missing signature", { status: 400 });
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, sig, Deno.env.get("STRIPE_WEBHOOK_SECRET")!);
  } catch {
    return new Response("invalid signature", { status: 400 });
  }
  const { data, error } = await supabase.rpc("ingest_stripe_event", { p_id: event.id, p_type: event.type, p_payload: event });
  if (error) return new Response("enqueue failed", { status: 500 });      // Stripe retries; nothing was written
  return Response.json({ received: true, duplicate: data === false });
});
```
Deploy with `--no-verify-jwt` for this one function (Stripe does not send a Supabase JWT; the Stripe signature is the authentication).

## Worker and reconcile
- The worker function reads a message, then does exactly what `syncSubscription` does: `stripe.subscriptions.retrieve`, a compare-and-set upsert, `pg_advisory_xact_lock(hashtext(...))` per subscription and per user, then recomputes `entitlements` with **one** shared `deriveEntitlement` (keep it in a single module used by the worker, reconcile and any success-page endpoint). Port the policy constants from [state-machine.md](state-machine.md); do not re-invent them.
- Nightly reconcile: `select cron.schedule('reconcile', '0 3 * * *', $$select net.http_post(url := '.../functions/v1/reconcile', headers := ...)$$);`. List subscriptions from Stripe (and per known customer, because test-clock subscriptions are hidden from the global list), repair through the same sync, and store the report in `reconcile_runs`.
- Success page: poll a function that returns `select plan from entitlements where user_id = auth.uid()`; never read the checkout `session_id` from the URL to grant anything.

## Watch out for
- Edge Function time limits: keep the webhook to verify + enqueue and do the Stripe API calls in the worker.
- Use the **service role** key only server-side, never in the browser.
- `pg_cron` and `pgmq` must be enabled for the project.
