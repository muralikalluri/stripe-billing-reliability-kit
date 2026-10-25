// Pure helpers shared by the webhook, worker and reconcile functions. No I/O.
import type Stripe from "npm:stripe@18";

/** Events that carry (or point to) a subscription. Same list as the Next.js and Spring Boot workers. */
export const SUBSCRIPTION_EVENTS = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.trial_will_end",
  "invoice.paid",
  "invoice.payment_failed",
]);

type Ref = string | { id: string } | null | undefined;
export const idOf = (r: Ref): string | null => (typeof r === "string" ? r : (r?.id ?? null));

export function subscriptionIdOf(event: { type: string; data: { object: unknown } }): string | null {
  // deno-lint-ignore no-explicit-any
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

export interface SubscriptionFields {
  status: string;
  priceId: string;
  quantity: number;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

/** The fields we persist from a Stripe subscription (period dates live on the item in current API versions). */
export function subscriptionFields(sub: Stripe.Subscription): SubscriptionFields {
  const item = sub.items.data[0];
  if (!item) throw new Error(`subscription ${sub.id} has no items`);
  // deno-lint-ignore no-explicit-any
  const it = item as any;
  // deno-lint-ignore no-explicit-any
  const s = sub as any;
  const start = it.current_period_start ?? s.current_period_start ?? null;
  const end = it.current_period_end ?? s.current_period_end ?? null;
  return {
    status: sub.status,
    priceId: item.price.id,
    quantity: item.quantity ?? 1,
    currentPeriodStart: start ? new Date(start * 1000) : null,
    currentPeriodEnd: end ? new Date(end * 1000) : null,
    // A scheduled cancel_at date also means "ends, not renewing".
    cancelAtPeriodEnd: sub.cancel_at_period_end || sub.cancel_at != null,
  };
}

/**
 * Server-side price allowlist -> plan name, passed to the SQL functions as JSON.
 * Same env vars as the other implementations; STRIPE_PRICE_PLANS (JSON) can add more prices.
 */
export function pricePlansFromEnv(get: (k: string) => string | undefined): Record<string, string> {
  const plans: Record<string, string> = {};
  const add = (id: string | undefined, plan: string) => { if (id) plans[id] = plan; };
  add(get("STRIPE_PRICE_PRO_MONTHLY"), "pro");
  add(get("STRIPE_PRICE_PRO_YEARLY"), "pro");
  add(get("STRIPE_PRICE_TEAM_SEAT"), "team");
  const extra = get("STRIPE_PRICE_PLANS");
  if (extra) Object.assign(plans, JSON.parse(extra));
  if (Object.keys(plans).length === 0) throw new Error("no Stripe prices configured: set STRIPE_PRICE_* env vars");
  return plans;
}
