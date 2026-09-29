import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { customers } from "@/db/schema";
import { getOrCreateCustomer } from "./customers";
import { planKeyFromString, priceIds, TRIAL_DAYS_PRO } from "./plans";

type StripeLike = Pick<Stripe, "customers" | "checkout" | "billingPortal">;

export async function createCheckoutUrl(
  db: Db,
  stripe: StripeLike,
  user: { id: string; email: string },
  planInput: unknown,
  appUrl: string,
): Promise<string> {
  const plan = planKeyFromString(planInput);
  if (!plan) throw new BillingError("unknown plan", 400);
  const price = priceIds()[plan];
  if (!price) throw new BillingError("plan is not configured", 500);

  const customer = await getOrCreateCustomer(db, stripe, user);
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer,
    client_reference_id: user.id,
    line_items: [{ price, quantity: 1 }],
    subscription_data: {
      metadata: { user_id: user.id },
      ...(plan.startsWith("pro") ? { trial_period_days: TRIAL_DAYS_PRO } : {}),
    },
    // The redirect only shows state; access is granted by the webhook worker.
    success_url: `${appUrl}/checkout/success`,
    cancel_url: `${appUrl}/pricing`,
  });
  if (!session.url) throw new BillingError("no checkout url", 502);
  return session.url;
}

/** Portal uses ONLY the session user's own customer id; never one from the request. */
export async function createPortalUrl(db: Db, stripe: StripeLike, userId: string, appUrl: string): Promise<string> {
  const [row] = await db.select().from(customers).where(eq(customers.userId, userId));
  if (!row) throw new BillingError("no billing account yet", 404);
  const session = await stripe.billingPortal.sessions.create({
    customer: row.stripeCustomerId,
    return_url: `${appUrl}/account`,
  });
  return session.url;
}

export class BillingError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}
