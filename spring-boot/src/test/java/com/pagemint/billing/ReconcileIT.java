package com.pagemint.billing;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.pagemint.billing.ReconcileService.Options;
import com.pagemint.billing.StripeGateway.SubscriptionData;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

/** Mirror of nextjs/test/reconcile.test.ts, including the missed-webhook scenario. */
class ReconcileIT extends IntegrationTestBase {

    @Autowired ReconcileService reconcile;
    @Autowired SubscriptionSync sync;
    @Autowired ObjectMapper mapper;

    final Options opts = new Options(2, 0.5, 20, 3, 0);

    @BeforeEach
    void users() {
        user("u1", "cus_1");
    }

    ReconcileReport run() { return reconcile.reconcile("manual", opts); }

    @Test
    void missedWebhookRecoversWithExactlyOneRepairAndACleanSecondRun() {
        stripe.put(FakeStripe.sub("sub_1", "cus_1", "active"));
        assertThat(plan("u1")).isNull(); // no webhook ever arrived: the user paid but has no access

        ReconcileReport r1 = run();
        assertThat(plan("u1")).isEqualTo("pro");
        assertThat(r1.counts().repaired()).isEqualTo(1);
        assertThat(r1.drift()).hasSize(1);
        assertThat(r1.drift().get(0)).satisfies(d -> {
            assertThat(d.kind()).isEqualTo("missing_in_db");
            assertThat(d.action()).isEqualTo("repaired");
            assertThat(d.stripeSubscriptionId()).isEqualTo("sub_1");
            assertThat(d.userId()).isEqualTo("u1");
        });
        assertThat(r1.complete()).isTrue();

        ReconcileReport r2 = run();
        assertThat(r2.drift()).isEmpty();
        assertThat(r2.counts().repaired()).isZero();
        assertThat(r2.counts().inSync()).isEqualTo(1);
    }

    @Test
    void aMissedStatusChangeIsRepairedAsFieldMismatch() {
        stripe.put(FakeStripe.sub("sub_1", "cus_1", "active"));
        run();
        stripe.put(FakeStripe.sub("sub_1", "cus_1", "canceled"));
        ReconcileReport r = run();
        assertThat(r.drift()).hasSize(1);
        assertThat(r.drift().get(0).kind()).isEqualTo("field_mismatch");
        assertThat(r.drift().get(0).fields()).containsExactly("status");
        assertThat(r.drift().get(0).action()).isEqualTo("repaired");
        assertThat(plan("u1")).isEqualTo("free");
    }

    @Test
    void findsTestClockSubscriptionsThatTheGlobalListingHides() {
        stripe.putOnTestClock(FakeStripe.sub("sub_tc", "cus_1", "active"));
        assertThat(run().counts().repaired()).isEqualTo(1);
        assertThat(plan("u1")).isEqualTo("pro");
    }

    @Test
    void paginatesAcrossPages() {
        for (String x : List.of("a", "b", "c", "d", "e")) stripe.put(FakeStripe.sub("sub_" + x, "cus_1", "active"));
        assertThat(run().scanned()).isEqualTo(5);
        assertThat(count("select count(*) from subscriptions")).isEqualTo(5);
    }

    @Test
    void aReconcileRepairDoesNotMoveTheEventClockSoAnOlderEventStillApplies() {
        stripe.put(FakeStripe.sub("sub_1", "cus_1", "active"));
        run();
        assertThat(jdbc.queryForObject("select updated_from_event_created from subscriptions", Long.class)).isNull();
        stripe.put(FakeStripe.sub("sub_1", "cus_1", "canceled"));
        assertThat(sync.sync("sub_1", 1L)).isTrue();
        assertThat(jdbc.queryForObject("select status from subscriptions", String.class)).isEqualTo("canceled");
    }

    @Test
    void reconcileOverwritesARowWhoseEventClockIsFarInTheFuture() {
        stripe.put(FakeStripe.sub("sub_1", "cus_1", "active"));
        sync.sync("sub_1", 9_999_999_999L);
        stripe.put(FakeStripe.sub("sub_1", "cus_1", "canceled"));
        assertThat(run().counts().repaired()).isEqualTo(1);
        assertThat(plan("u1")).isEqualTo("free");
    }

    @Test
    void anUnknownPriceDoesNotAbortTheRunAndTheValidSubscriptionIsStillRepaired() {
        user("u2", "cus_2");
        stripe.put(new SubscriptionData("sub_bad", "cus_2", "active", "price_unmapped", 1, FakeStripe.START, FakeStripe.END, false, null));
        stripe.put(FakeStripe.sub("sub_ok", "cus_1", "active"));
        ReconcileReport r = run();
        assertThat(r.counts().repaired()).isEqualTo(1);
        assertThat(r.counts().failed()).isEqualTo(1);
        assertThat(r.drift().stream().filter(d -> "sub_bad".equals(d.stripeSubscriptionId())).findFirst().get().error())
                .contains("unknown price");
        assertThat(plan("u1")).isEqualTo("pro");
    }

    @Test
    void aCustomerWithNoUserIsSkippedNeverGuessed() {
        stripe.put(FakeStripe.sub("sub_x", "cus_stranger", "active"));
        ReconcileReport r = run();
        assertThat(r.drift()).hasSize(1);
        assertThat(r.drift().get(0).action()).isEqualTo("skipped");
        assertThat(r.drift().get(0).error()).isEqualTo("unmapped_customer");
        assertThat(count("select count(*) from subscriptions")).isZero();
    }

    @Test
    void aSubscriptionWhoseMetadataUserWasDeletedIsSkippedNotFailed() {
        stripe.put(new SubscriptionData("sub_gone", "cus_deleted", "active", "price_pro_m", 1, FakeStripe.START, FakeStripe.END, false, "user_that_was_deleted"));
        ReconcileReport r = run();
        assertThat(r.counts().skipped()).isEqualTo(1);
        assertThat(r.counts().failed()).isZero();
    }

    @Test
    void aListingFailureMidPaginationMarksTheRunIncompleteAndSkipsOrphanDetection() {
        for (String x : List.of("a", "b", "c", "d")) stripe.put(FakeStripe.sub("sub_" + x, "cus_1", "active"));
        run(); // baseline: all four stored
        stripe.remove("sub_a"); // would look like an orphan...
        stripe.listCalls = 0;
        stripe.failListOnCall = 2; // ...but page 2 of the global listing fails
        ReconcileReport r = run();
        assertThat(r.complete()).isFalse();
        assertThat(r.drift().stream().filter(d -> d.kind().equals("orphan"))).isEmpty();
    }

    @Test
    void circuitBreakerReportsOnlyAndChangesNothingWhenMostSubscriptionsDrift() {
        for (String x : List.of("a", "b", "c", "d")) stripe.put(FakeStripe.sub("sub_" + x, "cus_1", "active"));
        ReconcileReport r = reconcile.reconcile("manual", new Options(2, 0.5, 3, 3, 0));
        assertThat(r.circuitBreakerTripped()).isTrue();
        assertThat(r.counts().repaired()).isZero();
        assertThat(r.drift()).allSatisfy(d -> assertThat(d.action()).isEqualTo("reported"));
        assertThat(count("select count(*) from subscriptions")).isZero();
    }

    @Test
    void anOrphanIsReportedAndNeverAutoRevoked() {
        stripe.put(FakeStripe.sub("sub_1", "cus_1", "active"));
        run();
        stripe.remove("sub_1");
        ReconcileReport r = run();
        assertThat(r.drift()).hasSize(1);
        assertThat(r.drift().get(0).kind()).isEqualTo("orphan");
        assertThat(r.drift().get(0).action()).isEqualTo("reported");
        assertThat(plan("u1")).isEqualTo("pro");
    }

    @Test
    void aWrongEntitlementRowIsRecomputedFromTheSubscriptionRows() {
        stripe.put(FakeStripe.sub("sub_1", "cus_1", "active"));
        run();
        jdbc.update("update entitlements set plan='free', valid_until=null where user_id='u1'");
        ReconcileReport r = run();
        assertThat(r.drift()).hasSize(1);
        assertThat(r.drift().get(0).kind()).isEqualTo("entitlement_stale");
        assertThat(r.drift().get(0).action()).isEqualTo("repaired");
        assertThat(plan("u1")).isEqualTo("pro");
    }

    @Test
    void theReportIsPersistedAndHasTheSameJsonShapeAsTheNextjsReport() throws Exception {
        stripe.put(FakeStripe.sub("sub_1", "cus_1", "active"));
        ReconcileReport r = reconcile.reconcile("manual", opts);
        reconcile.save(r);
        assertThat(jdbc.queryForObject("select complete from reconcile_runs where id = ?", Boolean.class, r.runId())).isTrue();
        var json = mapper.readTree(mapper.writeValueAsString(r));
        assertThat(json.fieldNames()).toIterable().contains(
                "runId", "trigger", "startedAt", "finishedAt", "complete", "scanned", "counts", "circuitBreakerTripped", "drift");
        assertThat(json.get("counts").fieldNames()).toIterable().containsExactly("inSync", "repaired", "failed", "skipped", "reported");
        assertThat(json.get("drift").get(0).get("kind").asText()).isEqualTo("missing_in_db");
    }

    @Test
    void driftItemsAlwaysCarryStripeSubscriptionIdAndUserIdEvenWhenNull() throws Exception {
        stripe.put(FakeStripe.sub("sub_1", "cus_1", "active"));
        run();
        jdbc.update("update entitlements set plan='free', valid_until=null where user_id='u1'");
        var item = mapper.readTree(mapper.writeValueAsString(run())).get("drift").get(0);
        assertThat(item.get("kind").asText()).isEqualTo("entitlement_stale");
        assertThat(item.has("stripeSubscriptionId")).isTrue(); // explicit null, like the Next.js report
        assertThat(item.get("stripeSubscriptionId").isNull()).isTrue();
        assertThat(item.get("userId").asText()).isEqualTo("u1");
    }

    @Test
    void aNonGatewayErrorWhileConfirmingAnOrphanDoesNotAbortTheRun() {
        stripe.put(FakeStripe.sub("sub_1", "cus_1", "active"));
        stripe.put(FakeStripe.sub("sub_2", "cus_1", "active"));
        run();
        stripe.remove("sub_1"); // will be checked as a possible orphan...
        stripe.failRetrieveId = "sub_1";
        stripe.failRetrieveWith = new IllegalStateException("subscription sub_1 has no items"); // ...and blows up
        stripe.put(FakeStripe.sub("sub_2", "cus_1", "canceled")); // a genuine drift elsewhere
        ReconcileReport r = run();
        assertThat(r.drift().stream().anyMatch(d -> "orphan".equals(d.kind()) && "failed".equals(d.action()))).isTrue();
        assertThat(r.drift().stream().anyMatch(d -> "sub_2".equals(d.stripeSubscriptionId()) && "repaired".equals(d.action()))).isTrue();
    }

    @Test
    void twoOverlappingRunsCannotBothProceed() throws Exception {
        CountDownLatch inside = new CountDownLatch(1), release = new CountDownLatch(1);
        var t = new Thread(() -> reconcile.withLock(() -> {
            inside.countDown();
            try { release.await(10, TimeUnit.SECONDS); } catch (InterruptedException ignored) { }
            return "first";
        }));
        t.start();
        assertThat(inside.await(5, TimeUnit.SECONDS)).isTrue();
        assertThat(reconcile.withLock(() -> "second")).isEmpty();
        release.countDown();
        t.join();
        assertThat(reconcile.withLock(() -> "third")).contains("third");
    }
}
