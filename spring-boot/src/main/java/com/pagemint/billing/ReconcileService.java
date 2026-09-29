package com.pagemint.billing;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pagemint.billing.DeriveEntitlement.Entitlement;
import com.pagemint.billing.ReconcileReport.Counts;
import com.pagemint.billing.ReconcileReport.DriftItem;
import com.pagemint.billing.StripeGateway.GatewayException;
import com.pagemint.billing.StripeGateway.Page;
import com.pagemint.billing.StripeGateway.SubscriptionData;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.function.Supplier;
import javax.sql.DataSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * Port of reconcile.ts. Detects drift from Stripe's listing and repairs ONLY via {@link SubscriptionSync#sync} with
 * version = null (fresh fetch under the lock; the event clock is never moved). One failing subscription never aborts
 * the run.
 */
@Component
public class ReconcileService {

    public record Options(int pageSize, double breakerRatio, int breakerMin, int retries, long retryDelayMs) {
        public static Options defaults() {
            return new Options(100, 0.5, 20, 3, 500);
        }
    }

    private record DbSub(String stripeId, String userId, String status, String priceId, int quantity,
                         Instant start, Instant end, boolean cancelAtPeriodEnd) {}

    private final JdbcTemplate jdbc;
    private final DataSource dataSource;
    private final StripeGateway stripe;
    private final SubscriptionSync sync;
    private final ObjectMapper mapper;

    public ReconcileService(JdbcTemplate jdbc, DataSource dataSource, StripeGateway stripe, SubscriptionSync sync,
                            ObjectMapper mapper) {
        this.jdbc = jdbc;
        this.dataSource = dataSource;
        this.stripe = stripe;
        this.sync = sync;
        this.mapper = mapper;
    }

    private static Instant instant(ResultSet rs, String col) throws java.sql.SQLException {
        Timestamp t = rs.getTimestamp(col);
        return t == null ? null : t.toInstant();
    }

    private <T> T withRetry(Options o, Supplier<T> fn) {
        for (int attempt = 0; ; attempt++) {
            try {
                return fn.get();
            } catch (GatewayException e) {
                Integer status = e.statusCode();
                boolean retryable = (status != null && (status == 429 || status >= 500)) || "ECONNRESET".equals(e.code());
                if (!retryable || attempt >= o.retries()) throw e;
                try {
                    Thread.sleep(o.retryDelayMs() * (1L << attempt));
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    throw e;
                }
            }
        }
    }

    private static List<String> diff(DbSub row, SubscriptionData sub) {
        List<String> f = new ArrayList<>();
        if (!row.status().equals(sub.status())) f.add("status");
        if (!row.priceId().equals(sub.priceId())) f.add("priceId");
        if (row.quantity() != sub.quantity()) f.add("quantity");
        if (!java.util.Objects.equals(row.start(), sub.periodStart())) f.add("currentPeriodStart");
        if (!java.util.Objects.equals(row.end(), sub.periodEnd())) f.add("currentPeriodEnd");
        if (row.cancelAtPeriodEnd() != sub.cancelAtPeriodEnd()) f.add("cancelAtPeriodEnd");
        return f;
    }

    private DriftItem repair(DriftItem item, boolean tripped) {
        if (tripped) return item; // report only
        try {
            sync.sync(item.stripeSubscriptionId(), null);
            return item.withAction("repaired", null);
        } catch (RuntimeException e) {
            String msg = String.valueOf(e.getMessage());
            boolean unmapped = msg.contains("no user for stripe customer");
            return item.withAction(unmapped ? "skipped" : "failed", unmapped ? "unmapped_customer" : msg);
        }
    }

    public ReconcileReport reconcile(String trigger, Options o) {
        Instant startedAt = Instant.now();
        List<DriftItem> drift = new ArrayList<>();
        boolean[] complete = {true};

        List<DbSub> dbRows = jdbc.query(
                "select stripe_subscription_id, user_id, status, price_id, quantity, current_period_start,"
                        + " current_period_end, cancel_at_period_end from subscriptions",
                (rs, i) -> new DbSub(rs.getString("stripe_subscription_id"), rs.getString("user_id"),
                        rs.getString("status"), rs.getString("price_id"), rs.getInt("quantity"),
                        instant(rs, "current_period_start"), instant(rs, "current_period_end"),
                        rs.getBoolean("cancel_at_period_end")));
        Map<String, DbSub> byStripeId = new LinkedHashMap<>();
        dbRows.forEach(r -> byStripeId.put(r.stripeId(), r));
        Map<String, String> userByCustomer = new LinkedHashMap<>();
        jdbc.query("select user_id, stripe_customer_id from customers",
                rs -> { userByCustomer.put(rs.getString("stripe_customer_id"), rs.getString("user_id")); });

        // 1. What Stripe has: the global listing, plus a per-customer listing for every customer we know
        //    (Stripe omits test-clock subscriptions from the global listing unless filtered by customer).
        Map<String, SubscriptionData> seen = new LinkedHashMap<>();
        collect(null, o, seen, complete);
        for (String customerId : userByCustomer.keySet()) collect(customerId, o, seen, complete);

        // 2. Classify.
        List<DriftItem> work = new ArrayList<>();
        int inSync = 0;
        for (SubscriptionData sub : seen.values()) {
            DbSub row = byStripeId.get(sub.id());
            String user = userByCustomer.getOrDefault(sub.customerId(), sub.metadataUserId());
            if (row == null) {
                work.add(new DriftItem(sub.id(), user, "missing_in_db", null, "reported", null));
            } else {
                List<String> fields = diff(row, sub);
                if (fields.isEmpty()) inSync++;
                else work.add(new DriftItem(sub.id(), user, "field_mismatch", fields, "reported", null));
            }
        }

        // 3. Repair (unless the circuit breaker trips: most subscriptions drifting = wrong account/mode).
        boolean tripped = work.size() >= o.breakerMin() && !seen.isEmpty()
                && (double) work.size() / seen.size() > o.breakerRatio();
        for (DriftItem w : work) drift.add(repair(w, tripped));

        // 4. Orphans: DB rows the listing never returned. Only meaningful after a COMPLETE listing; confirm by retrieve.
        if (complete[0]) {
            for (DbSub row : dbRows) {
                if (seen.containsKey(row.stripeId())) continue;
                try {
                    SubscriptionData sub = withRetry(o, () -> stripe.retrieveSubscription(row.stripeId()));
                    List<String> fields = diff(row, sub);
                    if (fields.isEmpty()) { inSync++; continue; }
                    drift.add(repair(new DriftItem(sub.id(), row.userId(), "field_mismatch", fields, "reported", null), tripped));
                } catch (RuntimeException e) {
                    // One bad row never aborts the run. A missing subscription is reported, never auto-revoked:
                    // a human decides. Anything else is recorded as failed.
                    DriftItem orphan = new DriftItem(row.stripeId(), row.userId(), "orphan", null, "reported", null);
                    boolean missing = e instanceof GatewayException g && "resource_missing".equals(g.code());
                    drift.add(missing ? orphan : orphan.withAction("failed", e.getMessage()));
                }
            }
        }

        // 5. Entitlement drift: stored entitlements vs what the subscription rows imply (after repairs).
        Set<String> userIds = new LinkedHashSet<>(jdbc.queryForList("select distinct user_id from subscriptions", String.class));
        for (String userId : userIds) {
            Entitlement want = sync.compute(userId);
            var stored = jdbc.query("select plan, seats, valid_until from entitlements where user_id = ?",
                    (rs, i) -> new Entitlement(rs.getString("plan"), rs.getInt("seats"), instant(rs, "valid_until")), userId);
            boolean same = !stored.isEmpty() && stored.get(0).plan().equals(want.plan())
                    && stored.get(0).seats() == want.seats()
                    && java.util.Objects.equals(stored.get(0).validUntil(), want.validUntil());
            if (same) continue;
            DriftItem item = new DriftItem(null, userId, "entitlement_stale", null, "reported", null);
            if (!tripped) {
                try {
                    sync.recomputeInTransaction(userId);
                    item = item.withAction("repaired", null);
                } catch (RuntimeException e) {
                    item = item.withAction("failed", e.getMessage());
                }
            }
            drift.add(item);
        }

        drift.sort(Comparator.comparing(DriftItem::kind)
                .thenComparing(d -> String.valueOf(d.stripeSubscriptionId())));
        int repaired = count(drift, "repaired"), failed = count(drift, "failed"), skipped = count(drift, "skipped"),
                reported = count(drift, "reported");
        return new ReconcileReport(UUID.randomUUID().toString(), trigger, startedAt.toString(), Instant.now().toString(),
                complete[0], seen.size(), new Counts(inSync, repaired, failed, skipped, reported), tripped, drift);
    }

    private static int count(List<DriftItem> drift, String action) {
        return (int) drift.stream().filter(d -> d.action().equals(action)).count();
    }

    private void collect(String customerId, Options o, Map<String, SubscriptionData> seen, boolean[] complete) {
        String after = null;
        try {
            for (;;) {
                String cursor = after;
                Page page = withRetry(o, () -> stripe.listSubscriptions(customerId, cursor, o.pageSize()));
                page.data().forEach(s -> seen.put(s.id(), s));
                if (!page.hasMore() || page.data().isEmpty()) return;
                after = page.data().get(page.data().size() - 1).id();
            }
        } catch (RuntimeException e) {
            complete[0] = false; // keep what we have; skip orphan detection
        }
    }

    public void save(ReconcileReport r) {
        try {
            jdbc.update("insert into reconcile_runs (id, trigger, started_at, finished_at, complete, report)"
                            + " values (?,?,?::timestamptz,?::timestamptz,?,?::jsonb)",
                    r.runId(), r.trigger(),
                    OffsetDateTime.ofInstant(Instant.parse(r.startedAt()), ZoneOffset.UTC),
                    OffsetDateTime.ofInstant(Instant.parse(r.finishedAt()), ZoneOffset.UTC),
                    r.complete(), mapper.writeValueAsString(r));
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }

    /** Only one reconcile at a time (manual vs nightly vs CLI). Empty if another run holds the lock. */
    public <T> Optional<T> withLock(Supplier<T> fn) {
        try (Connection c = dataSource.getConnection()) {
            boolean got;
            try (PreparedStatement ps = c.prepareStatement("select pg_try_advisory_lock(hashtext('reconcile'))");
                 ResultSet rs = ps.executeQuery()) {
                rs.next();
                got = rs.getBoolean(1);
            }
            if (!got) return Optional.empty();
            try {
                return Optional.ofNullable(fn.get());
            } finally {
                try (PreparedStatement ps = c.prepareStatement("select pg_advisory_unlock(hashtext('reconcile'))")) {
                    ps.execute();
                }
            }
        } catch (java.sql.SQLException e) {
            throw new IllegalStateException(e);
        }
    }

    /** Run + persist under the lock. */
    public Optional<ReconcileReport> runLocked(String trigger) {
        return withLock(() -> {
            ReconcileReport r = reconcile(trigger, Options.defaults());
            save(r);
            return r;
        });
    }
}
