import test from "node:test";
import assert from "node:assert/strict";
import { runRepro } from "./repro.mjs";

const url = process.env.DATABASE_URL;
const opts = url ? {} : { skip: "DATABASE_URL not set (needs local Postgres, see docs/stripe-cli.md)" };

test("duplicate deliveries: the vulnerable handler over-credits, the fixed handler credits exactly once", opts, async () => {
  const r = await runRepro(url);
  // Vulnerable (seeded flaw): every delivery is credited.
  assert.equal(r.vulnerable.sequential.ledgerRows, r.deliveries);
  assert.equal(r.vulnerable.sequential.balance, r.deliveries * r.creditsPerInvoice);
  assert.equal(r.vulnerable.concurrent.ledgerRows, r.deliveries);
  // Fixed: one credit, in both modes.
  for (const mode of ["sequential", "concurrent"]) {
    assert.equal(r.fixed[mode].ledgerRows, 1, `fixed ${mode} ledger rows`);
    assert.equal(r.fixed[mode].balance, r.creditsPerInvoice, `fixed ${mode} balance`);
  }
});
