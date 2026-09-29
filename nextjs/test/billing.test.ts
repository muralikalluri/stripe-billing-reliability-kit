import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type Stripe from "stripe";
import { customers } from "@/db/schema";
import { BillingError, createCheckoutUrl, createPortalUrl } from "@/lib/billing";
import { getOrCreateCustomer } from "@/lib/customers";
import { seedUser, startDb } from "./helpers";

let ctx: Awaited<ReturnType<typeof startDb>>;

function fakeStripe() {
  const state = { customersCreated: 0, byKey: new Map<string, string>(), checkoutArgs: [] as any[], portalArgs: [] as any[] };
  const stripe = {
    customers: {
      create: async (_p: unknown, o: { idempotencyKey: string }) => {
        // Mimic Stripe: same idempotency key -> same object, created once.
        if (!state.byKey.has(o.idempotencyKey)) {
          state.customersCreated += 1;
          state.byKey.set(o.idempotencyKey, `cus_${state.byKey.size + 1}`);
        }
        await new Promise((r) => setTimeout(r, 20));
        return { id: state.byKey.get(o.idempotencyKey)! };
      },
    },
    checkout: { sessions: { create: async (a: any) => (state.checkoutArgs.push(a), { url: "https://checkout.example/test" }) } },
    billingPortal: { sessions: { create: async (a: any) => (state.portalArgs.push(a), { url: "https://portal.example/test" }) } },
  } as unknown as Pick<Stripe, "customers" | "checkout" | "billingPortal">;
  return { stripe, state };
}

beforeAll(async () => {
  process.env.STRIPE_PRICE_PRO_MONTHLY = "price_pro_m";
  process.env.STRIPE_PRICE_PRO_YEARLY = "price_pro_y";
  process.env.STRIPE_PRICE_TEAM_SEAT = "price_team";
  ctx = await startDb();
});
afterAll(() => ctx.stop());
beforeEach(async () => {
  await ctx.pool.query("truncate customers, users cascade");
  await seedUser(ctx.db, "u1");
  await seedUser(ctx.db, "u2", "cus_of_u2");
});

describe("customers and checkout", () => {
  it("concurrent getOrCreateCustomer calls yield one customer row", async () => {
    const { stripe, state } = fakeStripe();
    const ids = await Promise.all(Array.from({ length: 4 }, () => getOrCreateCustomer(ctx.db, stripe, { id: "u1", email: "u1@example.com" })));
    expect(new Set(ids).size).toBe(1);
    expect(state.customersCreated).toBe(1);
    expect(await ctx.db.select().from(customers)).toHaveLength(2); // u1 + seeded u2
  });

  it("checkout only accepts allowlisted plan keys, never a raw price id", async () => {
    const { stripe } = fakeStripe();
    const user = { id: "u1", email: "u1@example.com" };
    await expect(createCheckoutUrl(ctx.db, stripe, user, "price_pro_m", "http://app")).rejects.toMatchObject({ status: 400 });
    await expect(createCheckoutUrl(ctx.db, stripe, user, undefined, "http://app")).rejects.toBeInstanceOf(BillingError);
  });

  it("checkout sends the user's customer, a trial for Pro, and redirects that grant nothing", async () => {
    const { stripe, state } = fakeStripe();
    const url = await createCheckoutUrl(ctx.db, stripe, { id: "u1", email: "u1@example.com" }, "pro_monthly", "http://app");
    expect(url).toBe("https://checkout.example/test");
    const a = state.checkoutArgs[0];
    expect(a).toMatchObject({ mode: "subscription", client_reference_id: "u1", line_items: [{ price: "price_pro_m", quantity: 1 }] });
    expect(a.subscription_data).toMatchObject({ trial_period_days: 14, metadata: { user_id: "u1" } });
    expect(a.success_url).toBe("http://app/checkout/success");
  });

  it("Team plan has no trial", async () => {
    const { stripe, state } = fakeStripe();
    await createCheckoutUrl(ctx.db, stripe, { id: "u1", email: "u1@example.com" }, "team_seat", "http://app");
    expect(state.checkoutArgs[0].subscription_data.trial_period_days).toBeUndefined();
  });

  it("portal uses only the caller's own customer (user A cannot open B's)", async () => {
    const { stripe, state } = fakeStripe();
    await createPortalUrl(ctx.db, stripe, "u2", "http://app");
    expect(state.portalArgs[0].customer).toBe("cus_of_u2");
    await expect(createPortalUrl(ctx.db, stripe, "u1", "http://app")).rejects.toMatchObject({ status: 404 });
  });
});
