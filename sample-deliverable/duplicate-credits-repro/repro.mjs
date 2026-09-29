// Reproduces the duplicate-credit bug and shows the fix. Writes results.json (the report's numbers come from it).
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import * as vulnerable from "./handler.vulnerable.mjs";
import * as fixed from "./handler.fixed.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const DELIVERIES = 5;

const event = (n) => ({
  id: "evt_repro_1", // the SAME event every time: a retry / replay
  type: "invoice.paid",
  data: { object: { id: "in_repro_1", customer: "cus_acme_1" } },
});

async function scenario(pool, schema, handler, mode) {
  await pool.query(`truncate ${schema}.credit_ledger, ${schema}.accounts cascade`);
  await pool.query(`insert into ${schema}.accounts (id, stripe_customer_id) values ('acct_1','cus_acme_1')`);
  if (mode === "sequential") for (let i = 0; i < DELIVERIES; i++) await handler.handleInvoicePaid(pool, schema, event(i));
  else await Promise.all(Array.from({ length: DELIVERIES }, (_, i) => handler.handleInvoicePaid(pool, schema, event(i))));
  const balance = (await pool.query(`select balance from ${schema}.accounts`)).rows[0].balance;
  const ledgerRows = Number((await pool.query(`select count(*) n from ${schema}.credit_ledger`)).rows[0].n);
  return { balance, ledgerRows };
}

export async function runRepro(connectionString) {
  const pool = new pg.Pool({ connectionString, max: 10 });
  const schema = `repro_${randomBytes(4).toString("hex")}`;
  try {
    await pool.query(`create schema ${schema}`);
    const ddl = readFileSync(resolve(here, "schema.sql"), "utf8");
    const client = await pool.connect();
    try {
      await client.query(`set search_path to ${schema}`);
      await client.query(ddl);
    } finally {
      client.release();
    }
    // The fix needs its guard (a unique index on the invoice); in the vulnerable variant it does not exist.
    const results = { deliveries: DELIVERIES, creditsPerInvoice: vulnerable.CREDITS_PER_INVOICE, vulnerable: {}, fixed: {} };
    for (const mode of ["sequential", "concurrent"]) results.vulnerable[mode] = await scenario(pool, schema, vulnerable, mode);
    // (Adding the guard fails while duplicate rows exist: a real rollout needs a data-repair step first; see the report.)
    await pool.query(`truncate ${schema}.credit_ledger`);
    await pool.query(`create unique index credit_ledger_invoice_uq on ${schema}.credit_ledger (stripe_invoice_id)`);
    for (const mode of ["sequential", "concurrent"]) results.fixed[mode] = await scenario(pool, schema, fixed, mode);
    return results;
  } finally {
    await pool.query(`drop schema if exists ${schema} cascade`).catch(() => {});
    await pool.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (see docs/stripe-cli.md)");
  const results = await runRepro(url);
  writeFileSync(resolve(here, "results.json"), JSON.stringify(results, null, 2) + "\n");
  console.log(JSON.stringify(results));
}
