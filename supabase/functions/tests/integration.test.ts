// Worker, reconcile and SQL functions against a real Postgres (TEST_DATABASE_URL), with a fake Stripe.
// Mirrors the five chaos scenarios at the database level, plus RLS and queue behaviour.
import { assert, assertEquals, assertRejects } from "./assert.ts";
import type Stripe from "npm:stripe@18";
import { processPending } from "../_shared/worker.ts";
import { reconcile } from "../_shared/reconcile.ts";
import { addUser, ADMIN_URL, DAY, event, fakeStripe, fakeSub, freshDb, pgDb, PLANS, PRICE_TEAM } from "./helpers.ts";

const T0 = 1_790_000_000; // a fixed "now" for period dates
const iso = (s: number) => new Date(s * 1000).toISOString();
const opts = { ignore: !ADMIN_URL, sanitizeResources: false, sanitizeOps: false };

async function setup() {
  const { pool, drop } = await freshDb();
  const db = pgDb(pool);
  const subs = new Map<string, Stripe.Subscription>();
  const stripe = fakeStripe(subs);
  const ent = async (u: string) => (await pool.query("select plan, seats, valid_until from entitlements where user_id = $1", [u])).rows[0];
  const sub = async (id: string) => (await pool.query("select * from subscriptions where stripe_subscription_id = $1", [id])).rows[0];
  const ev = async (id: string) => (await pool.query("select status, attempts, error from webhook_events where event_id = $1", [id])).rows[0];
  return { pool, db, subs, stripe, ent, sub, ev, drop };
}

Deno.test({ name: "checkout -> subscription row + entitlement (period end + 3 day buffer)", ...opts, fn: async () => {
  const c = await setup();
  try {
    await addUser(c.pool, "u1", "cus_1");
    c.subs.set("sub_1", fakeSub({ id: "sub_1", customer: "cus_1", status: "active", start: T0, end: T0 + 30 * DAY }));
    assert(await c.db.ingest("evt_1", "checkout.session.completed", event("evt_1", "checkout.session.completed", T0, { subscription: "sub_1" })));
    const r = await processPending(c.db, c.stripe, PLANS);
    assertEquals(r, { processed: 1, failed: 0, errors: [] });
    assertEquals((await c.sub("sub_1")).status, "active");
    const e = await c.ent("u1");
    assertEquals([e.plan, e.seats, e.valid_until.toISOString()], ["pro", 1, iso(T0 + 33 * DAY)]);
    assertEquals((await c.ev("evt_1")).status, "processed");
  } finally { await c.drop(); }
}});

Deno.test({ name: "duplicate delivery: one row, one job, one effect", ...opts, fn: async () => {
  const c = await setup();
  try {
    await addUser(c.pool, "u1", "cus_1");
    c.subs.set("sub_1", fakeSub({ id: "sub_1", customer: "cus_1", status: "active", start: T0, end: T0 + 30 * DAY }));
    const e = event("evt_1", "invoice.paid", T0, { subscription: "sub_1" });
    assertEquals([await c.db.ingest("evt_1", e.type, e), await c.db.ingest("evt_1", e.type, e), await c.db.ingest("evt_1", e.type, e)], [true, false, false]);
    const r = await processPending(c.db, c.stripe, PLANS);
    assertEquals(r.processed, 1);
    assertEquals(c.stripe.calls.retrieve, 1); // three deliveries, one Stripe fetch, one effect
    assertEquals((await c.pool.query("select count(*)::int as n from event_jobs")).rows[0].n, 0);
    assertEquals((await c.ev("evt_1")).attempts, 1);
  } finally { await c.drop(); }
}});

Deno.test({ name: "out-of-order: an older event never overwrites newer state", ...opts, fn: async () => {
  const c = await setup();
  try {
    await addUser(c.pool, "u1", "cus_1");
    // Newer event (created T0+200) processed first: Stripe says canceled.
    c.subs.set("sub_1", fakeSub({ id: "sub_1", customer: "cus_1", status: "canceled", start: T0, end: T0 + 30 * DAY }));
    await c.db.ingest("evt_new", "customer.subscription.deleted", event("evt_new", "customer.subscription.deleted", T0 + 200, { id: "sub_1" }));
    await processPending(c.db, c.stripe, PLANS);
    // Then a stale snapshot arrives with an OLDER event clock (e.g. a slow worker that fetched before the cancel).
    const stale = await c.db.applySubscription({
      stripeSubscriptionId: "sub_1", stripeCustomerId: "cus_1", metadataUserId: null,
      fields: { status: "active", priceId: "price_pro_monthly", quantity: 1, currentPeriodStart: new Date(T0 * 1000), currentPeriodEnd: new Date((T0 + 30 * DAY) * 1000), cancelAtPeriodEnd: false },
      version: T0 + 100, fetchedAt: null, pricePlans: PLANS,
    });
    assertEquals(stale, "stale");
    assertEquals((await c.sub("sub_1")).status, "canceled");
    assertEquals((await c.ent("u1")).plan, "free");
    // And an older event processed later re-fetches the latest state anyway: still canceled, still free.
    await c.db.ingest("evt_old", "customer.subscription.created", event("evt_old", "customer.subscription.created", T0 + 100, { id: "sub_1" }));
    const r = await processPending(c.db, c.stripe, PLANS);
    assertEquals(r.failed, 0);
    assertEquals((await c.sub("sub_1")).updated_from_event_created, String(T0 + 200));
    assertEquals((await c.ent("u1")).plan, "free");
  } finally { await c.drop(); }
}});

Deno.test({ name: "missed webhook: reconcile repairs a paying customer, exactly one repair", ...opts, fn: async () => {
  const c = await setup();
  try {
    await addUser(c.pool, "u1", "cus_1");
    c.subs.set("sub_1", fakeSub({ id: "sub_1", customer: "cus_1", status: "active", start: T0, end: T0 + 30 * DAY }));
    const r1 = await reconcile(c.db, c.stripe, PLANS, { retryDelayMs: 1 });
    assertEquals(r1.counts, { inSync: 0, repaired: 1, failed: 0, skipped: 0, reported: 0 });
    assertEquals(r1.drift[0].kind, "missing_in_db");
    assertEquals((await c.ent("u1")).plan, "pro");
    const r2 = await reconcile(c.db, c.stripe, PLANS, { retryDelayMs: 1 });
    assertEquals(r2.counts, { inSync: 1, repaired: 0, failed: 0, skipped: 0, reported: 0 });
    await c.db.saveReconcileRun({ ...r2, report: r2 });
    assertEquals((await c.pool.query("select count(*)::int as n from reconcile_runs")).rows[0].n, 1);
  } finally { await c.drop(); }
}});

Deno.test({ name: "renewal failure: past_due keeps access until the FAILED period's start + 3 days", ...opts, fn: async () => {
  const c = await setup();
  try {
    await addUser(c.pool, "u1", "cus_1");
    // At renewal Stripe advances the period, then the payment fails.
    c.subs.set("sub_1", fakeSub({ id: "sub_1", customer: "cus_1", status: "past_due", start: T0 + 30 * DAY, end: T0 + 60 * DAY }));
    await c.db.ingest("evt_f", "invoice.payment_failed", event("evt_f", "invoice.payment_failed", T0 + 30 * DAY, { parent: { subscription_details: { subscription: "sub_1" } } }));
    await processPending(c.db, c.stripe, PLANS);
    assertEquals((await c.ent("u1")).valid_until.toISOString(), iso(T0 + 33 * DAY));
  } finally { await c.drop(); }
}});

Deno.test({ name: "unknown price fails loudly, retries with backoff, and can be requeued", ...opts, fn: async () => {
  const c = await setup();
  try {
    await addUser(c.pool, "u1", "cus_1");
    c.subs.set("sub_1", fakeSub({ id: "sub_1", customer: "cus_1", status: "active", start: T0, end: T0 + 30 * DAY, price: "price_unknown" }));
    await c.db.ingest("evt_1", "customer.subscription.created", event("evt_1", "customer.subscription.created", T0, { id: "sub_1" }));
    const r = await processPending(c.db, c.stripe, PLANS);
    assertEquals(r.failed, 1);
    assert(/unknown price price_unknown/.test(r.errors[0].error));
    const e = await c.ev("evt_1");
    assertEquals([e.status, e.attempts], ["failed", 1]);
    const job = (await c.pool.query("select retries, run_after > now() as later from event_jobs")).rows[0];
    assertEquals([job.retries, job.later], [1, true]);
    assertEquals((await processPending(c.db, c.stripe, PLANS)).processed + (await processPending(c.db, c.stripe, PLANS)).failed, 0); // not due yet
    assertEquals(await c.ent("u1"), undefined); // nothing granted
    // Fix the config (add the price) and requeue: processed.
    await c.pool.query("select requeue_event('evt_1')");
    const r2 = await processPending(c.db, c.stripe, { ...PLANS, price_unknown: "pro" });
    assertEquals(r2.processed, 1);
    assertEquals((await c.ev("evt_1")).status, "processed");
  } finally { await c.drop(); }
}});

Deno.test({ name: "unmapped customer: worker fails, reconcile skips (never guesses a user)", ...opts, fn: async () => {
  const c = await setup();
  try {
    c.subs.set("sub_x", fakeSub({ id: "sub_x", customer: "cus_unknown", status: "active", start: T0, end: T0 + 30 * DAY }));
    await c.db.ingest("evt_1", "customer.subscription.created", event("evt_1", "customer.subscription.created", T0, { id: "sub_x" }));
    const r = await processPending(c.db, c.stripe, PLANS);
    assert(/no user for stripe customer cus_unknown/.test(r.errors[0].error));
    const rep = await reconcile(c.db, c.stripe, PLANS, { retryDelayMs: 1 });
    assertEquals(rep.drift.map((d) => [d.kind, d.action, d.error]), [["missing_in_db", "skipped", "unmapped_customer"]]);
  } finally { await c.drop(); }
}});

Deno.test({ name: "reconcile does not overwrite a row a webhook updated after its fetch", ...opts, fn: async () => {
  const c = await setup();
  try {
    await addUser(c.pool, "u1", "cus_1");
    const fields = { status: "active", priceId: "price_pro_monthly", quantity: 1, currentPeriodStart: new Date(T0 * 1000), currentPeriodEnd: new Date((T0 + 30 * DAY) * 1000), cancelAtPeriodEnd: false };
    const fetchedAt = await c.db.now();
    await new Promise((r) => setTimeout(r, 20));
    await c.db.applySubscription({ stripeSubscriptionId: "sub_1", stripeCustomerId: "cus_1", metadataUserId: null, fields: { ...fields, status: "canceled" }, version: T0, fetchedAt: null, pricePlans: PLANS });
    const r = await c.db.applySubscription({ stripeSubscriptionId: "sub_1", stripeCustomerId: "cus_1", metadataUserId: null, fields, version: null, fetchedAt, pricePlans: PLANS });
    assertEquals(r, "stale");
    assertEquals((await c.sub("sub_1")).status, "canceled");
  } finally { await c.drop(); }
}});

Deno.test({ name: "orphans are reported, never revoked; stale entitlements are repaired", ...opts, fn: async () => {
  const c = await setup();
  try {
    await addUser(c.pool, "u1", "cus_1");
    await addUser(c.pool, "u2", "cus_2");
    c.subs.set("sub_1", fakeSub({ id: "sub_1", customer: "cus_1", status: "active", start: T0, end: T0 + 30 * DAY, price: PRICE_TEAM, quantity: 5 }));
    c.subs.set("sub_2", fakeSub({ id: "sub_2", customer: "cus_2", status: "active", start: T0, end: T0 + 30 * DAY }));
    await reconcile(c.db, c.stripe, PLANS, { retryDelayMs: 1 });
    assertEquals([(await c.ent("u1")).plan, (await c.ent("u1")).seats], ["team", 5]);
    c.subs.delete("sub_2");                                                        // gone from Stripe
    await c.pool.query("update entitlements set plan = 'free' where user_id = 'u1'"); // corrupted by hand
    const r = await reconcile(c.db, c.stripe, PLANS, { retryDelayMs: 1 });
    assertEquals(r.drift.map((d) => [d.kind, d.userId, d.action]), [["entitlement_stale", "u1", "repaired"], ["orphan", "u2", "reported"]]);
    assertEquals((await c.ent("u1")).plan, "team");
    assertEquals((await c.ent("u2")).plan, "pro"); // not revoked automatically
  } finally { await c.drop(); }
}});

Deno.test({ name: "subscription can't move between users", ...opts, fn: async () => {
  const c = await setup();
  try {
    await addUser(c.pool, "u1", "cus_1");
    await addUser(c.pool, "u2", "cus_2");
    const f = { status: "active", priceId: "price_pro_monthly", quantity: 1, currentPeriodStart: new Date(T0 * 1000), currentPeriodEnd: new Date((T0 + DAY) * 1000), cancelAtPeriodEnd: false };
    await c.db.applySubscription({ stripeSubscriptionId: "sub_1", stripeCustomerId: "cus_1", metadataUserId: null, fields: f, version: 1, fetchedAt: null, pricePlans: PLANS });
    await assertRejects(() => c.db.applySubscription({ stripeSubscriptionId: "sub_1", stripeCustomerId: "cus_2", metadataUserId: null, fields: f, version: 2, fetchedAt: null, pricePlans: PLANS }), Error, "belongs to another user");
  } finally { await c.drop(); }
}});

Deno.test({ name: "queue: concurrent claimers never get the same job; leases are exclusive", ...opts, fn: async () => {
  const c = await setup();
  try {
    for (let i = 0; i < 30; i++) await c.db.ingest(`evt_${i}`, "invoice.paid", event(`evt_${i}`, "invoice.paid", T0, {}));
    const batches = await Promise.all([c.db.claimJobs(10, 60), c.db.claimJobs(10, 60), c.db.claimJobs(10, 60), c.db.claimJobs(10, 60)]);
    const ids = batches.flat().map((j) => j.event_id);
    assertEquals(ids.length, 30);
    assertEquals(new Set(ids).size, 30);
    assertEquals(await c.db.acquireLease("reconcile", 60), true);
    assertEquals(await c.db.acquireLease("reconcile", 60), false);
    await c.db.releaseLease("reconcile");
    assertEquals(await c.db.acquireLease("reconcile", 60), true);
  } finally { await c.drop(); }
}});

Deno.test({ name: "RLS: users read only their own entitlement; browsers can't call server functions", ...opts, fn: async () => {
  const c = await setup();
  try {
    const a = crypto.randomUUID(), b = crypto.randomUUID();
    await c.pool.query("insert into auth.users (id, email) values ($1, 'a@example.com'), ($2, 'b@example.com')", [a, b]); // trigger creates public.users
    await c.pool.query("insert into customers values ($1, 'cus_a'), ($2, 'cus_b')", [a, b]);
    const f = (end: number) => ({ status: "active", priceId: "price_pro_monthly", quantity: 1, currentPeriodStart: new Date(T0 * 1000), currentPeriodEnd: new Date(end * 1000), cancelAtPeriodEnd: false });
    const future = Math.floor(Date.now() / 1000) + 10 * DAY;
    await c.db.applySubscription({ stripeSubscriptionId: "sub_a", stripeCustomerId: "cus_a", metadataUserId: null, fields: f(future), version: 1, fetchedAt: null, pricePlans: PLANS });
    await c.db.applySubscription({ stripeSubscriptionId: "sub_b", stripeCustomerId: "cus_b", metadataUserId: null, fields: f(T0), version: 1, fetchedAt: null, pricePlans: PLANS }); // long expired

    const as = async (role: string, sub: string | null, sql: string) => {
      const client = await c.pool.connect();
      try {
        await client.query("begin");
        await client.query(`set local role ${role}`);
        if (sub) await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub, role })]);
        return (await client.query(sql)).rows;
      } finally { await client.query("rollback"); client.release(); }
    };
    assertEquals((await as("authenticated", a, "select user_id from entitlements")).map((r) => r.user_id), [a]);
    assertEquals((await as("authenticated", a, "select stripe_subscription_id from subscriptions")).map((r) => r.stripe_subscription_id), ["sub_a"]);
    assertEquals((await as("authenticated", a, "select plan from my_entitlement()"))[0].plan, "pro");
    assertEquals((await as("authenticated", b, "select plan from my_entitlement()"))[0].plan, "free"); // expired reads as free
    assertEquals(await as("anon", null, "select * from entitlements"), []);
    assertEquals(await as("authenticated", a, "select * from webhook_events"), []);
    assertEquals(await as("authenticated", a, "update entitlements set plan = 'team' returning user_id"), []); // no update policy: 0 rows
    assertEquals((await c.ent(a)).plan, "pro");
    await assertRejects(() => as("authenticated", a, `select apply_subscription('sub_a','cus_a',null,'active','price_pro_monthly',1,null,null,false,9,null,'{}')`), Error, "permission denied");
    await assertRejects(() => as("anon", null, "select ingest_stripe_event('evt','t','{}')"), Error, "permission denied");
  } finally { await c.drop(); }
}});
