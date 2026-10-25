// The webhook handler with REAL Stripe signature verification (stripe-node's own test header generator).
import { assertEquals } from "./assert.ts";
import Stripe from "npm:stripe@18";
import { handleWebhook } from "../_shared/webhook.ts";
import type { BillingDb } from "../_shared/db.ts";
import { pricePlansFromEnv, subscriptionFields, subscriptionIdOf } from "../_shared/billing.ts";
import { fakeSub } from "./helpers.ts";

const stripe = new Stripe("sk_test_unused", { httpClient: Stripe.createFetchHttpClient() });
const provider = Stripe.createSubtleCryptoProvider();
const SECRET = "whsec_test_secret_for_unit_tests";

function fakeDb(behaviour: "insert" | "duplicate" | "error") {
  const calls: string[] = [];
  return {
    calls,
    db: { ingest: async (id: string) => { calls.push(id); if (behaviour === "error") throw new Error("db down"); return behaviour === "insert"; } } as unknown as BillingDb,
  };
}
const verify = (raw: string, sig: string) => stripe.webhooks.constructEventAsync(raw, sig, SECRET, undefined, provider);
async function signed(payload: string, secret = SECRET) {
  const header = await stripe.webhooks.generateTestHeaderStringAsync({ payload, secret, cryptoProvider: provider });
  return new Request("http://x/stripe-webhook", { method: "POST", headers: { "stripe-signature": header, "content-type": "application/json" }, body: payload });
}
const PAYLOAD = JSON.stringify({ id: "evt_1", object: "event", type: "invoice.paid", created: 1, data: { object: { id: "in_1" } } }, null, 2);

Deno.test("valid signature: accepted, enqueued, worker kicked", async () => {
  const { db, calls } = fakeDb("insert");
  let kicked = 0;
  const res = await handleWebhook(await signed(PAYLOAD), { db, verify, afterAccept: () => kicked++ });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { received: true, duplicate: false });
  assertEquals(calls, ["evt_1"]);
  assertEquals(kicked, 1);
});

Deno.test("duplicate delivery: 200, no second worker kick", async () => {
  const { db } = fakeDb("duplicate");
  let kicked = 0;
  const res = await handleWebhook(await signed(PAYLOAD), { db, verify, afterAccept: () => kicked++ });
  assertEquals(await res.json(), { received: true, duplicate: true });
  assertEquals(kicked, 0);
});

Deno.test("tampered, re-indented, wrong-secret and unsigned payloads are rejected before any DB write", async () => {
  const cases: Request[] = [];
  const ok = await signed(PAYLOAD);
  const sig = ok.headers.get("stripe-signature")!;
  cases.push(new Request("http://x", { method: "POST", headers: { "stripe-signature": sig }, body: PAYLOAD.replace("in_1", "in_2") }));
  cases.push(new Request("http://x", { method: "POST", headers: { "stripe-signature": sig }, body: JSON.stringify(JSON.parse(PAYLOAD)) }));
  cases.push(await signed(PAYLOAD, "whsec_someone_else"));
  cases.push(new Request("http://x", { method: "POST", body: PAYLOAD }));
  for (const req of cases) {
    const { db, calls } = fakeDb("insert");
    const res = await handleWebhook(req, { db, verify });
    assertEquals(res.status, 400);
    assertEquals(calls.length, 0);
  }
});

Deno.test("enqueue failure returns 500 so Stripe retries", async () => {
  const { db } = fakeDb("error");
  const res = await handleWebhook(await signed(PAYLOAD), { db, verify });
  assertEquals(res.status, 500);
});

Deno.test("subscription id is found for every handled event shape, including new invoice.parent", () => {
  assertEquals(subscriptionIdOf({ type: "checkout.session.completed", data: { object: { subscription: "sub_1" } } }), "sub_1");
  assertEquals(subscriptionIdOf({ type: "invoice.paid", data: { object: { parent: { subscription_details: { subscription: "sub_2" } } } } }), "sub_2");
  assertEquals(subscriptionIdOf({ type: "invoice.payment_failed", data: { object: { subscription: { id: "sub_3" } } } }), "sub_3");
  assertEquals(subscriptionIdOf({ type: "customer.subscription.updated", data: { object: { id: "sub_4" } } }), "sub_4");
});

Deno.test("fields come from the subscription item; cancel_at counts as cancel-at-period-end", () => {
  const s = fakeSub({ id: "sub_1", customer: "cus_1", status: "active", start: 1000, end: 2000, quantity: 3 });
  (s as unknown as { cancel_at: number }).cancel_at = 2000;
  const f = subscriptionFields(s);
  assertEquals(f, { status: "active", priceId: "price_pro_monthly", quantity: 3, currentPeriodStart: new Date(1_000_000), currentPeriodEnd: new Date(2_000_000), cancelAtPeriodEnd: true });
});

Deno.test("price allowlist from env", () => {
  const env: Record<string, string> = { STRIPE_PRICE_PRO_MONTHLY: "price_a", STRIPE_PRICE_TEAM_SEAT: "price_b", STRIPE_PRICE_PLANS: '{"price_c":"pro"}' };
  assertEquals(pricePlansFromEnv((k) => env[k]), { price_a: "pro", price_b: "team", price_c: "pro" });
  let threw = false;
  try { pricePlansFromEnv(() => undefined); } catch { threw = true; }
  assertEquals(threw, true);
});
