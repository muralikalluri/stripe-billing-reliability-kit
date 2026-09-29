package com.pagemint.billing;

import java.time.Duration;
import java.time.Instant;
import java.util.List;

/**
 * THE single source of truth for what a subscription entitles a user to (mirror of derive.ts).
 * Pure: returns an absolute validUntil; access checks compare it with the clock. Fails closed: unknown status,
 * missing dates or an unknown plan yield free. A paid plan ALWAYS has a non-null validUntil.
 */
public final class DeriveEntitlement {

    /** Extra access after period end so a late renewal webhook does not lock out a paying user. */
    public static final Duration RENEWAL_BUFFER = Duration.ofDays(3);
    /** past_due keeps access this long after the FAILED period started. Keep shorter than Stripe's retry window. */
    public static final Duration PAST_DUE_GRACE = Duration.ofDays(3);

    public record SubscriptionState(
            String status, String plan, int quantity, Instant currentPeriodStart, Instant currentPeriodEnd,
            boolean cancelAtPeriodEnd) {}

    public record Entitlement(String plan, int seats, Instant validUntil) {}

    public static final Entitlement FREE = new Entitlement("free", 1, null);

    private DeriveEntitlement() {}

    public static Entitlement derive(SubscriptionState sub) {
        if (sub == null || sub.plan() == null) return FREE;
        int seats = Math.max(1, sub.quantity());
        switch (sub.status()) {
            case "trialing", "active" -> {
                if (sub.currentPeriodEnd() == null) return FREE;
                Instant until = sub.cancelAtPeriodEnd()
                        ? sub.currentPeriodEnd()
                        : sub.currentPeriodEnd().plus(RENEWAL_BUFFER);
                return new Entitlement(sub.plan(), seats, until);
            }
            case "past_due" -> {
                // Anchor on the start of the failed period: Stripe has already advanced period_end at renewal.
                if (sub.currentPeriodStart() == null) return FREE;
                return new Entitlement(sub.plan(), seats, sub.currentPeriodStart().plus(PAST_DUE_GRACE));
            }
            default -> {
                return FREE; // incomplete, incomplete_expired, unpaid, canceled, paused, and anything unknown
            }
        }
    }

    private static int rank(String plan) {
        return switch (plan) {
            case "team" -> 2;
            case "pro" -> 1;
            default -> 0;
        };
    }

    /** A user may have several subscriptions: take the best (plan rank, then latest validUntil). */
    public static Entitlement best(List<Entitlement> list) {
        Entitlement best = FREE;
        for (Entitlement e : list) {
            if (rank(e.plan()) != rank(best.plan())) {
                if (rank(e.plan()) > rank(best.plan())) best = e;
            } else if (millis(e.validUntil()) > millis(best.validUntil())) {
                best = e;
            }
        }
        return best;
    }

    private static long millis(Instant i) {
        return i == null ? 0 : i.toEpochMilli();
    }
}
