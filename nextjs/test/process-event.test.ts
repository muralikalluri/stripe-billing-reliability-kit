import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { entitlements, subscriptions, webhookEvents } from "@/db/schema";
import { getEntitlement } from "@/lib/entitlements/access";
import { processEvent } from "@/worker/process-event";
import { fakeEvent, fakeSubscription, seedUser, startDb } from "./helpers";

let ctx: Awaited<ReturnType<typeof startDb>>;

beforeAll(async () => {
  process.env.STRIPE_PRICE_PRO_MONTHLY = "price_pro_m";
  ctx = await startDb();
});
afterAll(() => ctx.stop());
beforeEach(async () => {
  await ctx.pool.query("truncate webhook_events, entitlements, subscriptions, customers, users cascade");
  await seedUser(ctx.db, "u1", "cus_test_1");
});

const received = (id: string, type: string) => ctx.db.insert(webhookEvents).values({ eventId: id, type });
const stripeReturning = (sub: ReturnType<typeof fakeSubscription>) => ({ subscriptions: { retrieve: async () => sub } });
const ev = (id = "evt_1") => fakeEvent(id, "checkout.session.completed", { id: "cs_1", subscription: "sub_test_1" });

describe("worker processEvent", () => {
  it("purchase via webhook grants access (and only then)", async () => {
    expect(await getEntitlement(ctx.db, "u1")).toBeNull(); // redirect alone grants nothing
    await received("evt_1", "checkout.session.completed");
    await processEvent(ctx.db, stripeReturning(fakeSubscription()), ev());
    expect((await getEntitlement(ctx.db, "u1"))?.plan).toBe("pro");
    const [e] = await ctx.db.select().from(webhookEvents);
    expect(e).toMatchObject({ status: "processed", attempts: 1 });
  });

  it("running the same job twice leaves one subscription and the same entitlement", async () => {
    await received("evt_1", "checkout.session.completed");
    const stripe = stripeReturning(fakeSubscription({ quantity: 1 }));
    await processEvent(ctx.db, stripe, ev());
    await processEvent(ctx.db, stripe, ev());
    expect(await ctx.db.select().from(subscriptions)).toHaveLength(1);
    expect(await ctx.db.select().from(entitlements)).toHaveLength(1);
    const [e] = await ctx.db.select().from(webhookEvents);
    expect(e.attempts).toBe(1); // second run skipped: already processed
  });

  it("a failing attempt is recorded, and the retry succeeds with attempts=2", async () => {
    await received("evt_1", "checkout.session.completed");
    const flaky = {
      subscriptions: {
        retrieve: async () => {
          throw new Error("stripe 503");
        },
      },
    };
    await expect(processEvent(ctx.db, flaky, ev())).rejects.toThrow("stripe 503");
    let [e] = await ctx.db.select().from(webhookEvents);
    expect(e).toMatchObject({ status: "failed", error: "stripe 503", attempts: 1 });

    await processEvent(ctx.db, stripeReturning(fakeSubscription()), ev());
    [e] = await ctx.db.select().from(webhookEvents).where(eq(webhookEvents.eventId, "evt_1"));
    expect(e).toMatchObject({ status: "processed", error: null, attempts: 2 });
  });

  it("unknown customer throws instead of guessing a user", async () => {
    await received("evt_1", "customer.subscription.created");
    const stranger = stripeReturning(fakeSubscription({ customer: "cus_unknown" }));
    await expect(processEvent(ctx.db, stranger, fakeEvent("evt_1", "customer.subscription.created", { id: "sub_test_1" }))).rejects.toThrow(/no user/);
    expect(await ctx.db.select().from(entitlements)).toHaveLength(0);
  });

  it("canceled subscription removes access", async () => {
    await received("evt_1", "checkout.session.completed");
    await processEvent(ctx.db, stripeReturning(fakeSubscription()), ev());
    await received("evt_2", "customer.subscription.deleted");
    await processEvent(ctx.db, stripeReturning(fakeSubscription({ status: "canceled" })), fakeEvent("evt_2", "customer.subscription.deleted", { id: "sub_test_1" }));
    expect(await getEntitlement(ctx.db, "u1")).toBeNull();
  });

  it("an unknown price fails loudly instead of granting free", async () => {
    await received("evt_1", "checkout.session.completed");
    await expect(processEvent(ctx.db, stripeReturning(fakeSubscription({ price: "price_unmapped" })), ev())).rejects.toThrow(/unknown price/);
    const [e] = await ctx.db.select().from(webhookEvents);
    expect(e.status).toBe("failed");
  });

  it("acknowledges event types M1 does not act on", async () => {
    await received("evt_9", "invoice.paid");
    await processEvent(ctx.db, stripeReturning(fakeSubscription()), fakeEvent("evt_9", "invoice.paid", { id: "in_1" }));
    const [e] = await ctx.db.select().from(webhookEvents).where(eq(webhookEvents.eventId, "evt_9"));
    expect(e.status).toBe("processed");
    expect(await ctx.db.select().from(entitlements)).toHaveLength(0);
  });
});
