// The SQL access policy must give exactly the same answer as the Next.js deriveEntitlement, for every case.
import { assertEquals } from "./assert.ts";
import { deriveEntitlement } from "../../../nextjs/src/lib/entitlements/derive.ts";
import { ADMIN_URL, freshDb } from "./helpers.ts";

const STATUSES = ["incomplete", "incomplete_expired", "trialing", "active", "past_due", "unpaid", "canceled", "paused", "something_new"];
const START = new Date("2026-10-01T00:00:00Z");
const END = new Date("2026-11-01T00:00:00Z");

Deno.test({ name: "SQL derive_entitlement == TypeScript deriveEntitlement", ignore: !ADMIN_URL, sanitizeResources: false, sanitizeOps: false, fn: async () => {
  const { pool, drop } = await freshDb();
  try {
    let n = 0;
    for (const status of STATUSES) for (const plan of ["pro", "team", null] as const) for (const quantity of [0, 1, 4])
      for (const start of [START, null]) for (const end of [END, null]) for (const cancel of [false, true]) {
        const ts = deriveEntitlement({ status, plan, quantity, currentPeriodStart: start, currentPeriodEnd: end, cancelAtPeriodEnd: cancel });
        const { rows: [sql] } = await pool.query("select * from public.derive_entitlement($1,$2,$3,$4,$5,$6)", [status, plan, quantity, start, end, cancel]);
        assertEquals({ plan: sql.plan, seats: sql.seats, validUntil: sql.valid_until?.getTime() ?? null }, { plan: ts.plan, seats: ts.seats, validUntil: ts.validUntil?.getTime() ?? null }, JSON.stringify({ status, plan, quantity, start, end, cancel }));
        n++;
      }
    assertEquals(n, 9 * 3 * 3 * 2 * 2 * 2);
  } finally { await drop(); }
}});

Deno.test({ name: "Supabase tables match the Next.js (drizzle) schema column for column", ignore: !ADMIN_URL, sanitizeResources: false, sanitizeOps: false, fn: async () => {
  const supa = await freshDb();
  const drizzle = await freshDb({ migrate: false });
  try {
    const dir = new URL("../../../nextjs/drizzle/", import.meta.url);
    const files = [...Deno.readDirSync(dir)].filter((f) => f.name.endsWith(".sql")).map((f) => f.name).sort();
    for (const f of files) await drizzle.pool.query(await Deno.readTextFile(new URL(f, dir)));
    const cols = `select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns
                  where table_schema = 'public' and table_name = any($1) order by table_name, column_name`;
    const contract = ["users", "customers", "entitlements", "subscriptions", "webhook_events", "reconcile_runs"];
    const a = (await supa.pool.query(cols, [contract])).rows;
    const b = (await drizzle.pool.query(cols, [contract])).rows;
    assertEquals(a.length > 30, true);
    assertEquals(a, b);
  } finally { await supa.drop(); await drizzle.drop(); }
}});
