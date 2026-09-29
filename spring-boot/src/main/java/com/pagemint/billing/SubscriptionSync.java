package com.pagemint.billing;

import com.pagemint.billing.DeriveEntitlement.Entitlement;
import com.pagemint.billing.DeriveEntitlement.SubscriptionState;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Port of syncSubscription/recomputeEntitlement. Plain SQL on purpose (no JPA): the compare-and-set and the advisory
 * locks are the point, and an ORM's caching would hide them. hashtext() runs server-side, so lock keys are identical
 * to the Next.js implementation.
 */
@Component
public class SubscriptionSync {

    private final JdbcTemplate jdbc;
    private final TransactionTemplate tx;
    private final StripeGateway stripe;
    private final Settings settings;

    public SubscriptionSync(JdbcTemplate jdbc, TransactionTemplate tx, StripeGateway stripe, Settings settings) {
        this.jdbc = jdbc;
        this.tx = tx;
        this.stripe = stripe;
        this.settings = settings;
    }

    private static OffsetDateTime odt(Instant i) {
        return i == null ? null : OffsetDateTime.ofInstant(i, ZoneOffset.UTC);
    }

    private static Instant instant(java.sql.ResultSet rs, String col) throws java.sql.SQLException {
        Timestamp t = rs.getTimestamp(col);
        return t == null ? null : t.toInstant();
    }

    /**
     * Fetch the latest subscription from Stripe (never trust event order), then in ONE transaction: per-subscription
     * lock, compare-and-set upsert (only if {@code version} is not older than what is stored), then recompute the
     * user's entitlement from ALL their subscriptions. {@code version == null} means "reconcile": apply
     * unconditionally and do NOT move the event clock.
     *
     * @return false if the event was stale and ignored
     */
    public boolean sync(String stripeSubscriptionId, Long version) {
        Boolean applied = tx.execute(status -> {
            jdbc.queryForList("select pg_advisory_xact_lock(hashtext(?))", stripeSubscriptionId);

            StripeGateway.SubscriptionData sub = stripe.retrieveSubscription(stripeSubscriptionId);
            List<String> mapped = jdbc.queryForList(
                    "select user_id from customers where stripe_customer_id = ?", String.class, sub.customerId());
            String userId = mapped.isEmpty() ? sub.metadataUserId() : mapped.get(0);
            // "no user for stripe customer": reconcile keys off this exact text to report `skipped`, never guess.
            if (userId == null) throw new IllegalStateException("no user for stripe customer " + sub.customerId());
            Integer owners = jdbc.queryForObject("select count(*) from users where id = ?", Integer.class, userId);
            if (owners == null || owners == 0) {
                throw new IllegalStateException("no user for stripe customer " + sub.customerId());
            }

            List<String> existing = jdbc.queryForList(
                    "select user_id from subscriptions where stripe_subscription_id = ?", String.class, sub.id());
            if (!existing.isEmpty() && !existing.get(0).equals(userId)) {
                throw new IllegalStateException(
                        "subscription " + sub.id() + " belongs to another user; refusing to reassign");
            }
            if (settings.planForPrice(sub.priceId()) == null) {
                throw new IllegalStateException("unknown price " + sub.priceId() + ": check STRIPE_PRICE_* env vars");
            }

            // user_id is deliberately NOT in the SET list: a subscription can never move between users.
            String base = "insert into subscriptions (id, user_id, stripe_subscription_id, status, price_id, quantity,"
                    + " current_period_start, current_period_end, cancel_at_period_end, updated_from_event_created, updated_at)"
                    + " values (?,?,?,?,?,?,?::timestamptz,?::timestamptz,?,?,now())"
                    + " on conflict (stripe_subscription_id) do update set status=excluded.status,"
                    + " price_id=excluded.price_id, quantity=excluded.quantity,"
                    + " current_period_start=excluded.current_period_start, current_period_end=excluded.current_period_end,"
                    + " cancel_at_period_end=excluded.cancel_at_period_end, updated_at=excluded.updated_at";
            String sql = version == null
                    ? base + " returning id"
                    : base + ", updated_from_event_created=excluded.updated_from_event_created"
                            + " where subscriptions.updated_from_event_created is null"
                            + " or subscriptions.updated_from_event_created <= excluded.updated_from_event_created"
                            + " returning id";
            List<String> written = jdbc.queryForList(sql, String.class,
                    "sub_" + sub.id(), userId, sub.id(), sub.status(), sub.priceId(), sub.quantity(),
                    odt(sub.periodStart()), odt(sub.periodEnd()), sub.cancelAtPeriodEnd(), version);
            if (written.isEmpty()) return false; // stale event: newer state already stored

            recompute(userId);
            return true;
        });
        return Boolean.TRUE.equals(applied);
    }

    /** Rebuild entitlements(user) from every subscription row the user has. Must run inside a transaction. */
    public void recompute(String userId) {
        // Per-user lock (always taken AFTER the per-subscription lock, so no deadlock): two subscriptions of the
        // same user syncing concurrently must not each recompute from a snapshot missing the other's change.
        jdbc.queryForList("select pg_advisory_xact_lock(hashtext(?))", "user:" + userId);
        Entitlement ent = compute(userId);
        jdbc.update("insert into entitlements (user_id, plan, seats, valid_until) values (?,?,?,?::timestamptz)"
                        + " on conflict (user_id) do update set plan=excluded.plan, seats=excluded.seats,"
                        + " valid_until=excluded.valid_until",
                userId, ent.plan(), ent.seats(), odt(ent.validUntil()));
    }

    public void recomputeInTransaction(String userId) {
        tx.executeWithoutResult(s -> recompute(userId));
    }

    /** What the user's entitlement SHOULD be, from every subscription row they have. */
    public Entitlement compute(String userId) {
        List<Entitlement> list = jdbc.query(
                "select status, price_id, quantity, current_period_start, current_period_end, cancel_at_period_end"
                        + " from subscriptions where user_id = ?",
                (rs, i) -> DeriveEntitlement.derive(new SubscriptionState(
                        rs.getString("status"),
                        settings.planForPrice(rs.getString("price_id")),
                        rs.getInt("quantity"),
                        instant(rs, "current_period_start"),
                        instant(rs, "current_period_end"),
                        rs.getBoolean("cancel_at_period_end"))),
                userId);
        return DeriveEntitlement.best(list);
    }
}
