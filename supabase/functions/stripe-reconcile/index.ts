// POST /functions/v1/stripe-reconcile  (service-role only). Nightly via pg_cron, or on demand.
// Returns the report as JSON and stores it in reconcile_runs.
import { reconcile } from "../_shared/reconcile.ts";
import { db, isServiceCaller, pricePlans, stripeClient } from "../_shared/runtime.ts";

const stripe = stripeClient();
const billing = db();

Deno.serve(async (req) => {
  if (!isServiceCaller(req)) return new Response("forbidden", { status: 403 });
  const trigger = new URL(req.url).searchParams.get("trigger") ?? "manual";
  if (!(await billing.acquireLease("reconcile", 600))) return Response.json({ error: "reconcile already running" }, { status: 409 });
  try {
    const report = await reconcile(billing, stripe, pricePlans(), { trigger });
    await billing.saveReconcileRun({ ...report, report });
    return Response.json(report);
  } finally {
    await billing.releaseLease("reconcile");
  }
});
