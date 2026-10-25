// POST /functions/v1/stripe-worker  (service-role only). Called every minute by pg_cron (see supabase/README.md)
// to retry failed events; normally the webhook function already processed them.
import { processPending } from "../_shared/worker.ts";
import { db, isServiceCaller, pricePlans, stripeClient } from "../_shared/runtime.ts";

const stripe = stripeClient();
const billing = db();

Deno.serve(async (req) => {
  if (!isServiceCaller(req)) return new Response("forbidden", { status: 403 });
  const result = await processPending(billing, stripe, pricePlans(), { budgetMs: 25_000 });
  return Response.json(result);
});
