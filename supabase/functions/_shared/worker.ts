// Processes queued webhook events. Idempotent: safe to run concurrently, twice, or after a crash.
import type Stripe from "npm:stripe@18";
import { idOf, SUBSCRIPTION_EVENTS, subscriptionFields, subscriptionIdOf } from "./billing.ts";
import type { BillingDb } from "./db.ts";

export type StripeSubs = { subscriptions: { retrieve(id: string): Promise<Stripe.Subscription> } };

/**
 * Fetch the latest subscription from Stripe (never trust event order or payload), then apply it in ONE
 * database transaction (apply_subscription: per-subscription lock, compare-and-set on the event clock,
 * entitlement recompute under a per-user lock).
 */
export async function syncSubscription(
  db: BillingDb, stripe: StripeSubs, stripeSubscriptionId: string, version: number | null,
  pricePlans: Record<string, string>, fetchedAt: Date | null = null,
): Promise<"applied" | "stale"> {
  const sub = await stripe.subscriptions.retrieve(stripeSubscriptionId);
  return db.applySubscription({
    stripeSubscriptionId: sub.id,
    stripeCustomerId: idOf(sub.customer as string | { id: string })!,
    metadataUserId: sub.metadata?.user_id ?? null,
    fields: subscriptionFields(sub),
    version,
    fetchedAt,
    pricePlans,
  });
}

export interface DrainResult { processed: number; failed: number; errors: { eventId: string; error: string }[] }

/** Claim and process due jobs until the queue is empty or the time budget runs out. */
export async function processPending(
  db: BillingDb, stripe: StripeSubs, pricePlans: Record<string, string>,
  opts: { batch?: number; leaseSeconds?: number; budgetMs?: number } = {},
): Promise<DrainResult> {
  const { batch = 10, leaseSeconds = 60, budgetMs = 20_000 } = opts;
  const deadline = Date.now() + budgetMs;
  const result: DrainResult = { processed: 0, failed: 0, errors: [] };
  while (Date.now() < deadline) {
    const jobs = await db.claimJobs(batch, leaseSeconds);
    if (jobs.length === 0) break;
    for (const job of jobs) {
      const event = job.payload;
      try {
        if (SUBSCRIPTION_EVENTS.has(event.type)) {
          const subId = subscriptionIdOf(event);
          if (subId) await syncSubscription(db, stripe, subId, event.created, pricePlans);
          // else: e.g. a one-off invoice with no subscription; acknowledged.
        }
        await db.completeJob(job.event_id);
        result.processed++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await db.failJob(job.event_id, msg);   // retried with backoff; visible in webhook_events.error
        result.failed++;
        result.errors.push({ eventId: job.event_id, error: msg });
      }
    }
  }
  return result;
}
