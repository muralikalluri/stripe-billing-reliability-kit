import type Stripe from "stripe";
import { eq, isNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { customers, entitlements, subscriptions, webhookEvents } from "@/db/schema";
import { bestEntitlement, deriveEntitlement, type Entitlement } from "@/lib/entitlements/derive";
import { planNameForPrice } from "@/lib/plans";

export type StripeApi = { subscriptions: { retrieve(id: string): Promise<Stripe.Subscription> } };

/** The fields we persist from a Stripe subscription. Shared by webhook sync and reconcile drift detection. */
export function subscriptionFields(sub: Stripe.Subscription) {
  const item = sub.items.data[0];
  if (!item) throw new Error(`subscription ${sub.id} has no items`);
  return {
    status: sub.status,
    priceId: item.price.id,
    quantity: item.quantity ?? 1,
    currentPeriodStart: item.current_period_start ? new Date(item.current_period_start * 1000) : null,
    currentPeriodEnd: item.current_period_end ? new Date(item.current_period_end * 1000) : null,
    // A scheduled cancel_at date also means "ends, not renewing".
    cancelAtPeriodEnd: sub.cancel_at_period_end || sub.cancel_at != null,
  };
}
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Events that carry (or point to) a subscription. Everything in SPEC §3.4 lands here. */
const SUBSCRIPTION_EVENTS = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.trial_will_end",
  "invoice.paid",
  "invoice.payment_failed",
]);

type Ref = string | { id: string } | null | undefined;
const idOf = (r: Ref) => (typeof r === "string" ? r : (r?.id ?? null));

export function subscriptionIdOf(event: Stripe.Event): string | null {
  const obj = event.data.object as Record<string, any>;
  switch (event.type) {
    case "checkout.session.completed":
      return idOf(obj.subscription);
    case "invoice.paid":
    case "invoice.payment_failed":
      // Newer API versions moved this to invoice.parent.subscription_details.subscription.
      return idOf(obj.parent?.subscription_details?.subscription) ?? idOf(obj.subscription);
    default:
      return obj.id ?? null;
  }
}

/**
 * Process one queued event. Idempotent: safe to run twice or after a crash.
 * Throws on failure so pg-boss retries; status/attempts/error are recorded first.
 * Never revokes access straight from an event type: subscription state decides (deriveEntitlement).
 */
export async function processEvent(db: Db, stripe: StripeApi, event: Stripe.Event): Promise<void> {
  const [claimed] = await db
    .update(webhookEvents)
    .set({ status: "processing", attempts: sql`${webhookEvents.attempts} + 1`, error: null })
    .where(sql`${webhookEvents.eventId} = ${event.id} AND ${webhookEvents.status} <> 'processed'`)
    .returning();
  if (!claimed) return; // already processed (or unknown row): nothing to do

  try {
    if (SUBSCRIPTION_EVENTS.has(event.type)) {
      const subId = subscriptionIdOf(event);
      if (subId) await syncSubscription(db, stripe, subId, event.created);
      // else: e.g. a one-off invoice with no subscription; acknowledged.
      if (event.type === "customer.subscription.trial_will_end") {
        console.log(`trial_will_end for ${subId} (notification hook point)`);
      }
    }
    await db
      .update(webhookEvents)
      .set({ status: "processed", processedAt: new Date(), error: null })
      .where(eq(webhookEvents.eventId, event.id));
  } catch (e) {
    await db
      .update(webhookEvents)
      .set({ status: "failed", error: e instanceof Error ? e.message : String(e) })
      .where(eq(webhookEvents.eventId, event.id));
    throw e;
  }
}

export interface SyncResult {
  applied: boolean;
}

/**
 * Fetch the latest subscription from Stripe (never trust event order), then in ONE transaction:
 * lock per subscription -> compare-and-set upsert (only if `version` is not older than what's stored)
 * -> recompute the user's entitlement from ALL their subscriptions.
 * `version` is the event's `created` (unix seconds). The advisory lock serialises concurrent workers;
 * the compare-and-set is the backstop that stops an older event overwriting a newer one.
 * Note: the Stripe call happens while the transaction and lock are held, so size the pool for worker concurrency.
 */
export async function syncSubscription(
  db: Db,
  stripe: StripeApi,
  stripeSubscriptionId: string,
  version: number | null,
): Promise<SyncResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${stripeSubscriptionId}))`);

    const sub = await stripe.subscriptions.retrieve(stripeSubscriptionId);
    const stripeCustomerId = idOf(sub.customer)!;
    const [cust] = await tx.select().from(customers).where(eq(customers.stripeCustomerId, stripeCustomerId));
    const userId = cust?.userId ?? sub.metadata?.user_id;
    if (!userId) throw new Error(`no user for stripe customer ${stripeCustomerId}`); // throw, never guess

    const [existing] = await tx.select().from(subscriptions).where(eq(subscriptions.stripeSubscriptionId, sub.id));
    if (existing && existing.userId !== userId) {
      throw new Error(`subscription ${sub.id} belongs to another user; refusing to reassign`);
    }

    const fields = subscriptionFields(sub);
    const plan = planNameForPrice(fields.priceId);
    // Throw rather than silently granting "free": a misconfigured STRIPE_PRICE_* env would otherwise look processed.
    if (!plan) throw new Error(`unknown price ${fields.priceId}: check STRIPE_PRICE_* env vars`);

    // user_id is deliberately NOT in `set`: a subscription can never move between users.
    const base = { ...fields, updatedAt: new Date() };
    const q = tx.insert(subscriptions).values({
      id: `sub_${sub.id}`,
      userId,
      stripeSubscriptionId: sub.id,
      ...base,
      updatedFromEventCreated: version,
    });
    const applied =
      version === null
        ? // Reconcile: the fetch above happened under the lock, so it is at least as fresh as anything stored.
          // Apply unconditionally and do NOT move the event clock, so later events (even with skewed
          // timestamps) still apply.
          await q.onConflictDoUpdate({ target: subscriptions.stripeSubscriptionId, set: base }).returning({ id: subscriptions.id })
        : await q
            .onConflictDoUpdate({
              target: subscriptions.stripeSubscriptionId,
              set: { ...base, updatedFromEventCreated: version },
              setWhere: or(isNull(subscriptions.updatedFromEventCreated), lte(subscriptions.updatedFromEventCreated, version)),
            })
            .returning({ id: subscriptions.id });
    if (applied.length === 0) return { applied: false }; // stale event: newer state already stored

    await recomputeEntitlement(tx, userId);
    return { applied: true };
  });
}

/** Rebuild entitlements(user) from every subscription row the user has. Used by webhooks and reconcile. */
export async function recomputeEntitlement(tx: Tx, userId: string): Promise<void> {
  // Per-user lock (always taken AFTER the per-subscription lock, so no deadlock): two subscriptions of the
  // same user syncing concurrently must not each recompute from a snapshot missing the other's change.
  // Under READ COMMITTED the SELECT below runs after the lock and sees the other transaction's commit.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"user:" + userId}))`);
  const ent = await computeEntitlement(tx, userId);
  await tx
    .insert(entitlements)
    .values({ userId, plan: ent.plan, seats: ent.seats, validUntil: ent.validUntil })
    .onConflictDoUpdate({ target: entitlements.userId, set: { plan: ent.plan, seats: ent.seats, validUntil: ent.validUntil } });
}

/** What the user's entitlement SHOULD be, from every subscription row they have. */
export async function computeEntitlement(tx: Tx | Db, userId: string): Promise<Entitlement> {
  const rows = await tx.select().from(subscriptions).where(eq(subscriptions.userId, userId));
  return bestEntitlement(
    rows.map((r) =>
      deriveEntitlement({
        status: r.status,
        plan: planNameForPrice(r.priceId),
        quantity: r.quantity,
        currentPeriodStart: r.currentPeriodStart,
        currentPeriodEnd: r.currentPeriodEnd,
        cancelAtPeriodEnd: r.cancelAtPeriodEnd,
      }),
    ),
  );
}
