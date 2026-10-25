import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanCode } from "../code-scan.mjs";
import { checkStripe, keyKind } from "../stripe-check.mjs";
import { renderReport } from "../report.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const examples = join(here, "..", "examples");
const repo = join(here, "..", "..");
const ids = (r) => r.findings.map((f) => `${f.id}:${f.severity}`).sort();

test("express example: re-serialised body, no idempotency, success-page grant, missing lifecycle events", () => {
  const r = scanCode(join(examples, "express-app"));
  assert.deepEqual(r.webhookFiles, ["server.js"]);
  assert.deepEqual(ids(r), ["H2:high", "H4:high", "H5:high", "H6:high", "H6:medium", "H6:medium", "H9:low"]);
  const h5 = r.findings.find((f) => f.id === "H5");
  assert.match(h5.snippet, /session\.customer_details\.email/); // points at the success route, not the webhook
});

test("next.js example: edge + sync verify, req.json(), trusts event order", () => {
  const r = scanCode(join(examples, "nextjs-app"));
  assert.deepEqual(ids(r), ["H2:high", "H3:high", "H4:high", "H6:medium", "H8:medium", "H9:low"]);
});

test("no-verification example is critical", () => {
  const r = scanCode(join(examples, "no-verification"));
  assert.equal(r.findings[0].id, "H1");
  assert.equal(r.findings[0].severity, "critical");
});

test("this kit's own implementations scan clean (no false positives)", () => {
  for (const dir of ["nextjs", "spring-boot", "supabase", "."]) {
    const r = scanCode(join(repo, dir));
    assert.ok(r.webhookFiles.length > 0, `${dir}: handler recognised`);
    assert.deepEqual(r.findings, [], `${dir}: ${JSON.stringify(r.findings, null, 1)}`);
  }
});

test("committed keys are found and redacted; test/example files are ignored", () => {
  const dir = mkdtempSync(join(tmpdir(), "hc-"));
  const live = "sk_" + "live_" + "4eC39HqLyjWDarjtT1zdp7dc"; // built at runtime so no key-shaped literal is committed
  const hook = "wh" + "sec_" + "abcdefghijklmnopqrstuvwx";
  writeFileSync(join(dir, "config.js"), `export const key = "${live}";\n`);
  mkdirSync(join(dir, "test"));
  writeFileSync(join(dir, "test", "helpers.js"), `export const secret = "${hook}";\n`);
  writeFileSync(join(dir, ".env"), `STRIPE_SECRET_KEY=${live}\n`); // local, untracked .env: expected, not a finding
  const r = scanCode(dir);
  const h7 = r.findings.filter((f) => f.id === "H7");
  assert.equal(h7.length, 1);
  assert.equal(h7[0].severity, "critical");
  assert.ok(!h7[0].snippet.includes("T1zdp7dc"), "key is redacted in the report");
});

// ---- Stripe account checks against a fake API ----
function fakeStripe(routes) {
  const calls = [];
  const impl = async (url, init) => {
    assert.equal(init.method, "GET", "only GET requests may be sent");
    const u = new URL(url);
    calls.push(u.pathname + u.search);
    const handler = routes[u.pathname];
    const body = handler ? handler(u.searchParams) : { data: [], has_more: false };
    return { ok: !body.error, status: body.error ? 400 : 200, json: async () => body };
  };
  return { impl, calls };
}
const NOW = new Date("2026-10-25T00:00:00Z");

test("stripe check: disabled endpoint, missing events, duplicates, undelivered events, version drift", async () => {
  const { impl, calls } = fakeStripe({
    "/v1/webhook_endpoints": () => ({
      has_more: false,
      data: [
        { id: "we_1", url: "https://app.example.com/api/stripe/webhook", status: "enabled", enabled_events: ["checkout.session.completed", "invoice.paid"], api_version: "2024-06-20" },
        { id: "we_2", url: "https://app.example.com/api/stripe/webhook", status: "enabled", enabled_events: ["*"], api_version: null },
        { id: "we_3", url: "https://old.example.com/hook", status: "disabled", enabled_events: ["*"], api_version: null },
      ],
    }),
    "/v1/events": (q) =>
      q.get("delivery_success") === "false"
        ? { has_more: false, data: Array.from({ length: 6 }, (_, i) => ({ id: `evt_${i}`, type: i < 4 ? "invoice.paid" : "customer.subscription.updated", created: 1792800000 + i, pending_webhooks: 1 })) }
        : { has_more: false, data: [{ id: "evt_latest", api_version: "2025-03-31.basil" }] },
    "/v1/subscriptions": () => ({ has_more: false, data: [{ status: "active" }, { status: "active" }, { status: "past_due" }] }),
  });
  const r = await checkStripe({ key: "rk_live_x", fetch: impl, now: NOW });
  assert.equal(r.mode, "live");
  assert.deepEqual(r.findings.map((f) => f.id).sort(), ["S2", "S3", "S5", "S6", "S7", "S8"]);
  assert.equal(r.findings.find((f) => f.id === "S3").severity, "high"); // subscription.deleted missing
  assert.equal(r.findings.find((f) => f.id === "S6").severity, "high"); // >= 5 undelivered billing events
  assert.equal(r.undelivered.total, 6);
  assert.deepEqual(r.subscriptions.byStatus, { active: 2, past_due: 1 });
  assert.ok(calls.some((c) => c.includes("delivery_success=false") && c.includes("created%5Bgte%5D=")));
});

test("stripe check: healthy account has no findings", async () => {
  const { impl } = fakeStripe({
    "/v1/webhook_endpoints": () => ({ has_more: false, data: [{ url: "https://app.example.com/hook", status: "enabled", enabled_events: ["*"], api_version: null }] }),
    "/v1/events": () => ({ has_more: false, data: [] }),
    "/v1/subscriptions": () => ({ has_more: false, data: [{ status: "active" }] }),
  });
  const r = await checkStripe({ key: "sk_test_x", fetch: impl, now: NOW });
  assert.deepEqual(r.findings, []);
  assert.match(renderReport({ stripe: r }), /No issues found/);
});

test("stripe check: no endpoint is high in live mode, medium in test mode, and lists the events to subscribe", async () => {
  const empty = fakeStripe({});
  const t = await checkStripe({ key: "sk_test_x", fetch: empty.impl, now: NOW });
  const l = await checkStripe({ key: "rk_live_x", fetch: fakeStripe({}).impl, now: NOW });
  const s1t = t.findings.find((f) => f.id === "S1");
  assert.equal(s1t.severity, "medium");
  assert.match(s1t.why, /stripe listen/);
  assert.match(s1t.fix, /customer\.subscription\.deleted/);
  assert.equal(l.findings.find((f) => f.id === "S1").severity, "high");
});

test("stripe check rejects unknown key types and paginates", async () => {
  await assert.rejects(checkStripe({ key: "pk_test_x", fetch: async () => ({}) }), /restricted/);
  assert.deepEqual(keyKind("rk_test_abc"), { mode: "test", restricted: true });
  let page = 0;
  const { impl } = fakeStripe({
    "/v1/webhook_endpoints": () => ({ has_more: false, data: [{ url: "https://a.example.com/h", status: "enabled", enabled_events: ["*"] }] }),
    "/v1/events": (q) => {
      if (q.get("delivery_success") !== "false") return { has_more: false, data: [] };
      page++;
      return { has_more: page < 3, data: [{ id: `evt_p${page}`, type: "invoice.paid", created: 1, pending_webhooks: 1 }] };
    },
  });
  const r = await checkStripe({ key: "sk_test_x", fetch: impl, now: NOW });
  assert.equal(r.undelivered.total, 3);
});

test("committed example reports match a fresh scan", () => {
  for (const name of ["express-app", "nextjs-app", "no-verification"]) {
    const fresh = renderReport({ code: scanCode(join(examples, name)), generatedAt: null });
    const committed = readFileSync(join(examples, `report-${name}.md`), "utf8");
    assert.equal(committed, fresh, `regenerate with: node health-check/render-examples.mjs`);
  }
});
