import { SCENARIOS } from "./scenarios.js";
import { cleanup, loadCtx, Recorder, writeResult } from "./lib.js";

const wanted = process.argv[2] ?? "all";
const list = wanted === "all" ? SCENARIOS : SCENARIOS.filter((s) => s.name === wanted);
if (!list.length) {
  console.error(`unknown scenario "${wanted}". choose: all, ${SCENARIOS.map((s) => s.name).join(", ")}`);
  process.exit(2);
}

let failed = false;
for (const s of list) {
  console.log(`\n== ${s.title} (${s.name}) ==`);
  const ctx = loadCtx();
  const rec = new Recorder();
  const startedAt = new Date().toISOString();
  try {
    await s.run(ctx, rec);
  } catch (e) {
    rec.check("scenario_completed", "scenario ran to completion", e instanceof Error ? e.message : String(e), false);
  } finally {
    await cleanup(ctx).catch((e) => console.error("cleanup error:", e instanceof Error ? e.message : e));
  }
  const verdict = writeResult(ctx, s.name, rec, { startedAt, deliveryMode: s.deliveryMode, title: s.title });
  console.log(`-> ${s.name}: ${verdict}`);
  if (verdict === "fail") failed = true;
}
process.exit(failed ? 1 : 0);
