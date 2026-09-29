import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { entitlements, reconcileRuns, subscriptions, webhookEvents } from "@/db/schema";
import { getEntitlement } from "@/lib/entitlements/access";
import { reconcile, saveReport, withReconcileLock, type ReconcileStripe } from "@/reconcile/reconcile";
import { processEvent, syncSubscription } from "@/worker/process-event";
import { fakeEvent, fakeSubscription, seedUser, startDb } from "./helpers";

let ctx: Awaited<ReturnType<typeof startDb>>;

type Sub = ReturnType<typeof fakeSubscription> & { testClock?: boolean };

/** In-memory Stripe: pagination + Stripe's rule that test-clock subs are hidden from the global list. */
function fakeStripe(initial: Sub[] = []) {
  const subs = new Map<string, Sub>(initial.map((s) => [s.id, s]));
  const state = { failListOnCall: null as number | null, listCalls: 0, listParams: [] as any[] };
  const api: ReconcileStripe = {
    subscriptions: {
      retrieve: async (id) => {
        const s = subs.get(id);
        if (!s) throw Object.assign(new Error("No such subscription"), { code: "resource_missing" });
        return s;
      },
      list: async (p) => {
        state.listCalls++;
        state.listParams.push(p);
        if (state.failListOnCall === state.listCalls) throw Object.assign(new Error("boom"), { statusCode: 400 });
        let all = [...subs.values()].filter((s) => (p.customer ? s.customer === p.customer : !s.testClock));
        all.sort((a, b) => a.id.localeCompare(b.id));
        const from = p.starting_after ? all.findIndex((s) => s.id === p.starting_after) + 1 : 0;
        const data = all.slice(from, from + p.limit) as Stripe.Subscription[];
        return { data, has_more: from + p.limit < all.length };
      },
    },
  };
  return { api, subs, state };
}
const opts = { retryDelayMs: 0, pageSize: 2 };

beforeAll(async () => {
  process.env.STRIPE_PRICE_PRO_MONTHLY = "price_pro_m";
  ctx = await startDb();
});
afterAll(() => ctx.stop());
beforeEach(async () => {
  await ctx.pool.query("truncate webhook_events, entitlements, subscriptions, customers, users, reconcile_runs cascade");
  await seedUser(ctx.db, "u1", "cus_1");
});

describe("missed webhook scenario", () => {
  it("recovers: no webhook ever arrived, reconcile grants access; report shows exactly 1 repair; 2nd run is clean", async () => {
    const stripe = fakeStripe([fakeSubscription({ id: "sub_1", customer: "cus_1" })]);
    // No events were received or enqueued. The user paid, but has no access:
    expect(await getEntitlement(ctx.db, "u1")).toBeNull();

    const r1 = await reconcile(ctx.db, stripe.api, opts);
    expect((await getEntitlement(ctx.db, "u1"))?.plan).toBe("pro");
    expect(r1.counts.repaired).toBe(1);
    expect(r1.drift).toHaveLength(1);
    expect(r1.drift.filter((d) => d.action === "repaired")).toEqual([
      expect.objectContaining({ kind: "missing_in_db", stripeSubscriptionId: "sub_1", userId: "u1" }),
    ]);
    expect(r1.complete).toBe(true);

    const r2 = await reconcile(ctx.db, stripe.api, opts);
    expect(r2.drift).toEqual([]);
    expect(r2.counts).toMatchObject({ repaired: 0, failed: 0, inSync: 1 });
  });

  it("a missed status change (canceled in Stripe, active in DB) is repaired as field_mismatch", async () => {
    const stripe = fakeStripe([fakeSubscription({ id: "sub_1", customer: "cus_1", status: "active" })]);
    await reconcile(ctx.db, stripe.api, opts);
    stripe.subs.set("sub_1", fakeSubscription({ id: "sub_1", customer: "cus_1", status: "canceled" }));
    const r = await reconcile(ctx.db, stripe.api, opts);
    expect(r.drift).toEqual([expect.objectContaining({ kind: "field_mismatch", fields: ["status"], action: "repaired" })]);
    expect(await getEntitlement(ctx.db, "u1")).toBeNull();
  });

  it("finds test-clock subscriptions that the global listing hides, via the per-customer listing", async () => {
    const stripe = fakeStripe([{ ...fakeSubscription({ id: "sub_tc", customer: "cus_1" }), testClock: true }]);
    const r = await reconcile(ctx.db, stripe.api, opts);
    expect(r.counts.repaired).toBe(1);
    expect((await getEntitlement(ctx.db, "u1"))?.plan).toBe("pro");
  });

  it("paginates across pages", async () => {
    const list = ["a", "b", "c", "d", "e"].map((x) => fakeSubscription({ id: `sub_${x}`, customer: "cus_1" }));
    const stripe = fakeStripe(list);
    const r = await reconcile(ctx.db, stripe.api, opts);
    expect(r.scanned).toBe(5);
    expect(await ctx.db.select().from(subscriptions)).toHaveLength(5);
  });
});

describe("version clock", () => {
  it("a reconcile repair does not move the event clock: an OLDER event still applies afterwards", async () => {
    const stripe = fakeStripe([fakeSubscription({ id: "sub_1", customer: "cus_1", status: "active" })]);
    await reconcile(ctx.db, stripe.api, opts);
    const [row] = await ctx.db.select().from(subscriptions);
    expect(row.updatedFromEventCreated).toBeNull();

    stripe.subs.set("sub_1", fakeSubscription({ id: "sub_1", customer: "cus_1", status: "canceled" }));
    await ctx.db.insert(webhookEvents).values({ eventId: "evt_old", type: "customer.subscription.updated" });
    await processEvent(ctx.db, stripe.api, fakeEvent("evt_old", "customer.subscription.updated", { id: "sub_1" }, 1));
    expect((await ctx.db.select().from(subscriptions))[0].status).toBe("canceled");
  });

  it("reconcile overwrites a row whose event clock is far in the future (skew)", async () => {
    await syncSubscription(ctx.db, fakeStripe([fakeSubscription({ id: "sub_1", customer: "cus_1", status: "active" })]).api, "sub_1", 9_999_999_999);
    const stripe = fakeStripe([fakeSubscription({ id: "sub_1", customer: "cus_1", status: "canceled" })]);
    const r = await reconcile(ctx.db, stripe.api, opts);
    expect(r.counts.repaired).toBe(1);
    expect(await getEntitlement(ctx.db, "u1")).toBeNull();
  });
});

describe("partial failure", () => {
  it("an unknown price does not abort the run; the valid subscription is still repaired", async () => {
    await seedUser(ctx.db, "u2", "cus_2");
    const stripe = fakeStripe([
      fakeSubscription({ id: "sub_bad", customer: "cus_2", price: "price_unmapped" }),
      fakeSubscription({ id: "sub_ok", customer: "cus_1" }),
    ]);
    const r = await reconcile(ctx.db, stripe.api, opts);
    expect(r.counts).toMatchObject({ repaired: 1, failed: 1 });
    expect(r.drift.find((d) => d.stripeSubscriptionId === "sub_bad")?.error).toMatch(/unknown price/);
    expect((await getEntitlement(ctx.db, "u1"))?.plan).toBe("pro");
  });

  it("a customer we have no user for is skipped (never guessed)", async () => {
    const stripe = fakeStripe([fakeSubscription({ id: "sub_x", customer: "cus_stranger" })]);
    const r = await reconcile(ctx.db, stripe.api, opts);
    expect(r.drift).toEqual([expect.objectContaining({ action: "skipped", error: "unmapped_customer" })]);
    expect(await ctx.db.select().from(subscriptions)).toHaveLength(0);
  });

  it("a listing failure mid-pagination marks the run incomplete, keeps repairs, and skips orphan detection", async () => {
    const list = ["a", "b", "c", "d"].map((x) => fakeSubscription({ id: `sub_${x}`, customer: "cus_1" }));
    const stripe = fakeStripe(list);
    await reconcile(ctx.db, stripe.api, opts); // baseline: all four stored
    stripe.subs.delete("sub_a"); // would look like an orphan...
    stripe.state.listCalls = 0;
    stripe.state.failListOnCall = 2; // ...but page 2 of the global listing fails
    const r = await reconcile(ctx.db, stripe.api, opts);
    expect(r.complete).toBe(false);
    expect(r.drift.filter((d) => d.kind === "orphan")).toEqual([]);
  });

  it("retries rate limits (429) with backoff and then succeeds", async () => {
    const stripe = fakeStripe([fakeSubscription({ id: "sub_1", customer: "cus_1" })]);
    let n = 0;
    const real = stripe.api.subscriptions.list;
    stripe.api.subscriptions.list = async (p) => {
      if (n++ < 2) throw Object.assign(new Error("rate limited"), { statusCode: 429 });
      return real(p);
    };
    const r = await reconcile(ctx.db, stripe.api, opts);
    expect(r.complete).toBe(true);
    expect(r.counts.repaired).toBe(1);
  });

  it("circuit breaker: when most subscriptions drift, report only and change nothing", async () => {
    const stripe = fakeStripe(["a", "b", "c", "d"].map((x) => fakeSubscription({ id: `sub_${x}`, customer: "cus_1" })));
    const r = await reconcile(ctx.db, stripe.api, { ...opts, breaker: { ratio: 0.5, min: 3 } });
    expect(r.circuitBreakerTripped).toBe(true);
    expect(r.counts.repaired).toBe(0);
    expect(r.drift.every((d) => d.action === "reported")).toBe(true);
    expect(await ctx.db.select().from(subscriptions)).toHaveLength(0);
  });
});

describe("other drift", () => {
  it("field_mismatch includes a changed period start (it anchors the past_due grace window)", async () => {
    const stripe = fakeStripe([fakeSubscription({ id: "sub_1", customer: "cus_1", status: "past_due", start: 1_800_000_000, end: 1_802_592_000 })]);
    await reconcile(ctx.db, stripe.api, opts);
    stripe.subs.set("sub_1", fakeSubscription({ id: "sub_1", customer: "cus_1", status: "past_due", start: 1_800_500_000, end: 1_802_592_000 }));
    const r = await reconcile(ctx.db, stripe.api, opts);
    expect(r.drift[0]).toMatchObject({ kind: "field_mismatch", fields: ["currentPeriodStart"], action: "repaired" });
  });

  it("orphan: DB row Stripe no longer has is reported, NOT auto-revoked", async () => {
    const stripe = fakeStripe([fakeSubscription({ id: "sub_1", customer: "cus_1" })]);
    await reconcile(ctx.db, stripe.api, opts);
    stripe.subs.delete("sub_1");
    const r = await reconcile(ctx.db, stripe.api, opts);
    expect(r.drift).toEqual([expect.objectContaining({ kind: "orphan", action: "reported" })]);
    expect((await getEntitlement(ctx.db, "u1"))?.plan).toBe("pro");
  });

  it("entitlement_stale: a wrong entitlements row is recomputed from the subscription rows", async () => {
    const stripe = fakeStripe([fakeSubscription({ id: "sub_1", customer: "cus_1" })]);
    await reconcile(ctx.db, stripe.api, opts);
    await ctx.db.update(entitlements).set({ plan: "free", validUntil: null }).where(eq(entitlements.userId, "u1"));
    const r = await reconcile(ctx.db, stripe.api, opts);
    expect(r.drift).toEqual([expect.objectContaining({ kind: "entitlement_stale", userId: "u1", action: "repaired" })]);
    expect((await getEntitlement(ctx.db, "u1"))?.plan).toBe("pro");
  });
});

describe("persistence and locking", () => {
  it("saves the report to reconcile_runs", async () => {
    const stripe = fakeStripe([fakeSubscription({ id: "sub_1", customer: "cus_1" })]);
    const r = await reconcile(ctx.db, stripe.api, { ...opts, trigger: "manual" });
    await saveReport(ctx.db, r);
    const [row] = await ctx.db.select().from(reconcileRuns);
    expect(row).toMatchObject({ id: r.runId, trigger: "manual", complete: true });
    expect((row.report as any).counts.repaired).toBe(1);
  });

  it("two overlapping runs cannot both proceed", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = withReconcileLock(ctx.pool, () => gate.then(() => "first"));
    await new Promise((r) => setTimeout(r, 100));
    expect(await withReconcileLock(ctx.pool, async () => "second")).toBeNull();
    release();
    expect(await first).toBe("first");
    expect(await withReconcileLock(ctx.pool, async () => "third")).toBe("third");
  });
});
