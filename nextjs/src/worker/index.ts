import type Stripe from "stripe";
import { getDb, getPool } from "@/db/client";
import { EVENT_QUEUE, getBoss, RECONCILE_QUEUE } from "@/lib/queue";
import { getStripe } from "@/lib/stripe";
import { reconcile, saveReport, withReconcileLock } from "@/reconcile/reconcile";
import { processEvent } from "./process-event";

const boss = await getBoss();
const db = getDb();
const stripe = getStripe();

await boss.work<{ event: Stripe.Event }>(EVENT_QUEUE, async (jobs) => {
  for (const job of jobs) await processEvent(db, stripe, job.data.event);
});

await boss.work<{ trigger?: "nightly" | "manual" }>(RECONCILE_QUEUE, async (jobs) => {
  for (const job of jobs) {
    const report = await withReconcileLock(getPool(), async () => {
      const r = await reconcile(db, stripe, { trigger: job.data?.trigger ?? "nightly" });
      await saveReport(db, r);
      return r;
    });
    console.log(report ? `reconcile done: repaired=${report.counts.repaired} failed=${report.counts.failed}` : "reconcile skipped: already running");
  }
});
// Nightly at 03:00 UTC. Idempotent: re-registering the same schedule is safe.
await boss.schedule(RECONCILE_QUEUE, "0 3 * * *", { trigger: "nightly" }, { tz: "UTC" });
console.log(`worker listening on "${EVENT_QUEUE}" and "${RECONCILE_QUEUE}"`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await boss.stop();
    process.exit(0);
  });
}
