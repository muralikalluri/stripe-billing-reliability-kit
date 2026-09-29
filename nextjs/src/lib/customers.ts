import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { customers } from "@/db/schema";

/** One Stripe customer per user; safe under concurrent calls (Stripe idempotency key + unique constraint). */
export async function getOrCreateCustomer(
  db: Db,
  stripe: Pick<Stripe, "customers">,
  user: { id: string; email: string },
): Promise<string> {
  const existing = await db.select().from(customers).where(eq(customers.userId, user.id));
  if (existing[0]) return existing[0].stripeCustomerId;

  const created = await stripe.customers.create(
    { email: user.email, metadata: { user_id: user.id } },
    { idempotencyKey: `cust-${user.id}` },
  );
  await db.insert(customers).values({ userId: user.id, stripeCustomerId: created.id }).onConflictDoNothing();
  const [row] = await db.select().from(customers).where(eq(customers.userId, user.id));
  return row.stripeCustomerId;
}
