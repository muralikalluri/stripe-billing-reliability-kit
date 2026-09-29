import { writeFileSync } from "node:fs";
import { getDb, getPool } from "@/db/client";
import { getStripe } from "@/lib/stripe";
import { reconcile, saveReport, withReconcileLock } from "./reconcile";

const db = getDb();
const report = await withReconcileLock(getPool(), async () => {
  const r = await reconcile(db, getStripe(), { trigger: "cli" });
  await saveReport(db, r);
  return r;
});
if (!report) {
  console.error("another reconcile run is in progress");
  process.exitCode = 1;
} else {
  writeFileSync("reconcile-report.json", JSON.stringify(report, null, 2));
  console.log(`reconcile: scanned=${report.scanned} repaired=${report.counts.repaired} failed=${report.counts.failed} -> reconcile-report.json`);
}
await getPool().end();
