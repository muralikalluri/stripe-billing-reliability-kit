import type { PlanName } from "../plans";

const DAY = 24 * 60 * 60 * 1000;
/** Extra access after period end so a late renewal webhook doesn't lock out a paying user. */
export const RENEWAL_BUFFER_MS = 3 * DAY;
/** past_due keeps access for this long after the FAILED period started. Keep shorter than Stripe's retry window. */
export const PAST_DUE_GRACE_MS = 3 * DAY;

export interface SubscriptionState {
  status: string;
  plan: PlanName | null;
  quantity: number;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

export interface Entitlement {
  plan: PlanName | "free";
  seats: number;
  validUntil: Date | null;
}

export const FREE: Entitlement = { plan: "free", seats: 1, validUntil: null };

/** Access policy per Stripe subscription status (documented in docs/state-machine.md). */
export const ACCESS_POLICY: Record<string, string> = {
  incomplete: "none",
  incomplete_expired: "none",
  trialing: "plan until period end + renewal buffer",
  active: "plan until period end + renewal buffer (no buffer once cancel_at_period_end is set)",
  past_due: "plan until current_period_start + grace",
  unpaid: "none",
  canceled: "none",
  paused: "none",
};

/**
 * THE single source of truth for what a subscription entitles a user to.
 * Pure: returns an absolute validUntil; access checks compare it to the clock, so access expires
 * on time even if no webhook ever arrives. Fails closed: unknown status, missing dates or unknown
 * plan yield free. A paid plan ALWAYS has a non-null validUntil.
 */
export function deriveEntitlement(sub: SubscriptionState | null): Entitlement {
  if (!sub || !sub.plan) return FREE;
  const seats = Math.max(1, sub.quantity);
  switch (sub.status) {
    case "trialing":
    case "active": {
      if (!sub.currentPeriodEnd) return FREE;
      const end = sub.currentPeriodEnd.getTime();
      return { plan: sub.plan, seats, validUntil: new Date(sub.cancelAtPeriodEnd ? end : end + RENEWAL_BUFFER_MS) };
    }
    case "past_due": {
      // Anchor on the start of the failed period: Stripe has already advanced period_end at renewal.
      if (!sub.currentPeriodStart) return FREE;
      return { plan: sub.plan, seats, validUntil: new Date(sub.currentPeriodStart.getTime() + PAST_DUE_GRACE_MS) };
    }
    default:
      return FREE; // incomplete, incomplete_expired, unpaid, canceled, paused, and anything unknown
  }
}

const RANK: Record<Entitlement["plan"], number> = { free: 0, pro: 1, team: 2 };

/** A user may have several subscriptions: take the best (plan rank, then latest validUntil). */
export function bestEntitlement(list: Entitlement[]): Entitlement {
  return list.reduce<Entitlement>((best, e) => {
    if (RANK[e.plan] !== RANK[best.plan]) return RANK[e.plan] > RANK[best.plan] ? e : best;
    return (e.validUntil?.getTime() ?? 0) > (best.validUntil?.getTime() ?? 0) ? e : best;
  }, FREE);
}
