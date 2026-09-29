import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { entitlements, subscriptions, webhookEvents } from "@/db/schema";
import { getEntitlement } from "@/lib/entitlements/access";
import { PAST_DUE_GRACE_MS } from "@/lib/entitlements/derive";
import { processEvent, syncSubscription } from "@/worker/process-event";
import { fakeEvent, fakeSubscription, seedUser, startDb } from "./helpers";

let ctx: Awaited<ReturnType<typeof startDb>>;
const stripeReturning = (sub: ReturnType<typeof fakeSubscription>, delayMs = 0) => ({
  subscriptions: { retrieve: async () => (delayMs ? new Promise<typeof sub>((r) => setTimeout(() => r(sub), delayMs)) : sub) },
});

beforeAll(async () => {
  process.env.STRIPE_PRICE_PRO_MONTHLY = "price_pro_m";
  process.env.STRIPE_PRICE_TEAM_SEAT = "price_team";
  ctx = await startDb();
});
afterAll(() => ctx.stop());
beforeEach(async () => {
  await ctx.pool.query("truncate webhook_events, entitlements, subscriptions, customers, users cascade");
  await seedUser(ctx.db, "u1", "cus_test_1");
  await seedUser(ctx.db, "u2", "cus_test_2");
});

const ent = () => ctx.db.select().from(entitlements).where(eq(entitlements.userId, "u1")).then((r) => r[0]);

describe("out-of-order handling (compare-and-set on event.created)", () => {
  it("an older event cannot overwrite newer state", async () => {
    expect(await syncSubscription(ctx.db, stripeReturning(fakeSubscription({ status: "active" })), "sub_test_1", 200)).toEqual({ applied: true });
    const stale = await syncSubscription(ctx.db, stripeReturning(fakeSubscription({ status: "canceled" })), "sub_test_1", 100);
    expect(stale).toEqual({ applied: false });
    expect((await ent()).plan).toBe("pro");
    const [row] = await ctx.db.select().from(subscriptions);
    expect(row).toMatchObject({ status: "active", updatedFromEventCreated: 200 });
  });

  it("an equal or newer event is applied", async () => {
    await syncSubscription(ctx.db, stripeReturning(fakeSubscription({ status: "active" })), "sub_test_1", 200);
    expect((await syncSubscription(ctx.db, stripeReturning(fakeSubscription({ status: "active", quantity: 1 })), "sub_test_1", 200)).applied).toBe(true);
    expect((await syncSubscription(ctx.db, stripeReturning(fakeSubscription({ status: "canceled" })), "sub_test_1", 300)).applied).toBe(true);
    expect((await ent()).plan).toBe("free");
  });

  it("updated delivered before created still ends in the Stripe state", async () => {
    const updated = fakeEvent("evt_u", "customer.subscription.updated", { id: "sub_test_1" }, 200);
    const created = fakeEvent("evt_c", "customer.subscription.created", { id: "sub_test_1" }, 100);
    await ctx.db.insert(webhookEvents).values([{ eventId: "evt_u", type: updated.type }, { eventId: "evt_c", type: created.type }]);
    const latest = stripeReturning(fakeSubscription({ status: "active" }));
    await processEvent(ctx.db, latest, updated);
    await processEvent(ctx.db, latest, created);
    const [row] = await ctx.db.select().from(subscriptions);
    expect(row).toMatchObject({ status: "active", updatedFromEventCreated: 200 });
    expect((await ent()).plan).toBe("pro");
  });

  it("concurrent workers on the same subscription end with the newest state", async () => {
    // Slow worker holds an OLD snapshot (canceled, v100); fast worker has the NEW one (active, v200).
    await Promise.all([
      syncSubscription(ctx.db, stripeReturning(fakeSubscription({ status: "canceled" }), 80), "sub_test_1", 100),
      syncSubscription(ctx.db, stripeReturning(fakeSubscription({ status: "active" }), 0), "sub_test_1", 200),
    ]);
    const [row] = await ctx.db.select().from(subscriptions);
    expect(row).toMatchObject({ status: "active", updatedFromEventCreated: 200 });
    expect((await ent()).plan).toBe("pro");
  });
});

describe("tenant safety and multiple subscriptions", () => {
  it("a subscription can never be reassigned to another user", async () => {
    await syncSubscription(ctx.db, stripeReturning(fakeSubscription({ customer: "cus_test_1" })), "sub_test_1", 100);
    await expect(
      syncSubscription(ctx.db, stripeReturning(fakeSubscription({ customer: "cus_test_2" })), "sub_test_1", 200),
    ).rejects.toThrow(/another user/);
    const [row] = await ctx.db.select().from(subscriptions);
    expect(row.userId).toBe("u1");
  });

  it("an old subscription being canceled does not wipe access from a newer active one", async () => {
    await syncSubscription(ctx.db, stripeReturning(fakeSubscription({ id: "sub_a", status: "active" })), "sub_a", 100);
    await syncSubscription(ctx.db, stripeReturning(fakeSubscription({ id: "sub_b", status: "active", price: "price_team", quantity: 3 })), "sub_b", 110);
    await syncSubscription(ctx.db, stripeReturning(fakeSubscription({ id: "sub_a", status: "canceled" })), "sub_a", 200);
    expect(await ent()).toMatchObject({ plan: "team", seats: 3 });
    await syncSubscription(ctx.db, stripeReturning(fakeSubscription({ id: "sub_b", status: "canceled", price: "price_team" })), "sub_b", 210);
    expect((await ent()).plan).toBe("free");
  });
});

describe("per-user recompute race", () => {
  it("two different subscriptions of one user syncing concurrently never lose the active one", async () => {
    // Regression: without a per-user lock this ended in `free` in a few % of runs.
    for (let i = 0; i < 40; i++) {
      await ctx.pool.query("truncate entitlements, subscriptions");
      await syncSubscription(ctx.db, stripeReturning(fakeSubscription({ id: "sub_a", status: "active" })), "sub_a", 100);
      await Promise.all([
        syncSubscription(ctx.db, stripeReturning(fakeSubscription({ id: "sub_a", status: "canceled" })), "sub_a", 200),
        syncSubscription(ctx.db, stripeReturning(fakeSubscription({ id: "sub_b", status: "active", price: "price_team" })), "sub_b", 200),
      ]);
      expect((await ent()).plan, `iteration ${i}`).toBe("team");
    }
  });
});

describe("invoice and trial events", () => {
  const invoice = (type: string, id = "evt_i") =>
    fakeEvent(id, type, { id: "in_1", parent: { subscription_details: { subscription: "sub_test_1" } } }, 500);

  it("invoice.payment_failed -> past_due keeps access only within the grace window", async () => {
    const start = 1_800_000_000; // seconds
    const pastDue = stripeReturning(fakeSubscription({ status: "past_due", start, end: start + 2_592_000 }));
    await ctx.db.insert(webhookEvents).values({ eventId: "evt_i", type: "invoice.payment_failed" });
    await processEvent(ctx.db, pastDue, invoice("invoice.payment_failed"));

    const graceEnd = start * 1000 + PAST_DUE_GRACE_MS;
    expect(await getEntitlement(ctx.db, "u1", new Date(graceEnd - 1))).not.toBeNull();
    expect(await getEntitlement(ctx.db, "u1", new Date(graceEnd))).toBeNull();
  });

  it("unpaid after retries removes access; invoice.paid restores it", async () => {
    await ctx.db.insert(webhookEvents).values([
      { eventId: "e1", type: "customer.subscription.updated" },
      { eventId: "e2", type: "invoice.paid" },
    ]);
    await processEvent(ctx.db, stripeReturning(fakeSubscription({ status: "unpaid" })), fakeEvent("e1", "customer.subscription.updated", { id: "sub_test_1" }, 100));
    expect(await getEntitlement(ctx.db, "u1")).toBeNull();
    await processEvent(ctx.db, stripeReturning(fakeSubscription({ status: "active" })), fakeEvent("e2", "invoice.paid", { id: "in_2", subscription: "sub_test_1" }, 200));
    expect((await getEntitlement(ctx.db, "u1"))?.plan).toBe("pro");
  });

  it("a grace period already expired at processing time grants nothing", async () => {
    const longAgo = 1_000_000_000;
    await syncSubscription(ctx.db, stripeReturning(fakeSubscription({ status: "past_due", start: longAgo, end: longAgo + 2_592_000 })), "sub_test_1", 100);
    expect(await getEntitlement(ctx.db, "u1")).toBeNull();
  });

  it("an invoice with no subscription is acknowledged, not failed", async () => {
    await ctx.db.insert(webhookEvents).values({ eventId: "evt_o", type: "invoice.paid" });
    await processEvent(ctx.db, stripeReturning(fakeSubscription()), fakeEvent("evt_o", "invoice.paid", { id: "in_x", parent: null }));
    const [e] = await ctx.db.select().from(webhookEvents);
    expect(e.status).toBe("processed");
    expect(await ctx.db.select().from(entitlements)).toHaveLength(0);
  });

  it("trial_will_end syncs state and is processed", async () => {
    await ctx.db.insert(webhookEvents).values({ eventId: "evt_t", type: "customer.subscription.trial_will_end" });
    await processEvent(ctx.db, stripeReturning(fakeSubscription({ status: "trialing" })), fakeEvent("evt_t", "customer.subscription.trial_will_end", { id: "sub_test_1" }));
    expect((await ent()).plan).toBe("pro");
  });
});

describe("access expiry", () => {
  it("access ends at validUntil even if no webhook ever arrives", async () => {
    await syncSubscription(ctx.db, stripeReturning(fakeSubscription({ status: "active", start: 1_000_000_000, end: 1_000_002_000 })), "sub_test_1", 100);
    const row = await ent();
    expect(await getEntitlement(ctx.db, "u1", new Date(row.validUntil!.getTime() - 1))).not.toBeNull();
    expect(await getEntitlement(ctx.db, "u1", row.validUntil!)).toBeNull();
  });
});
