package com.pagemint.billing;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.pagemint.billing.StripeGateway.SubscriptionData;
import java.time.Instant;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

/** Worker/sync behaviour (mirror of nextjs/test/process-event.test.ts and sync.test.ts). */
class PipelineIT extends IntegrationTestBase {

    @Autowired SubscriptionSync sync;
    @Autowired ApiController api;

    @BeforeEach
    void users() {
        user("u1", "cus_1");
        user("u2", "cus_2");
    }

    java.util.Map<String, Object> row(String subId) {
        return jdbc.queryForMap("select * from subscriptions where stripe_subscription_id = ?", subId);
    }

    java.util.Map<String, Object> event(String id) {
        return jdbc.queryForMap("select * from webhook_events where event_id = ?", id);
    }

    static SubscriptionData with(SubscriptionData s, String status) {
        return new SubscriptionData(s.id(), s.customerId(), status, s.priceId(), s.quantity(), s.periodStart(),
                s.periodEnd(), s.cancelAtPeriodEnd(), s.metadataUserId());
    }

    // ---------- end to end ----------
    @Test
    void signedCheckoutEventGrantsAccessOnlyAfterTheWorkerRuns() throws Exception {
        stripe.put(FakeStripe.sub("sub_1", "cus_1", "active"));
        assertThat(postSigned(checkoutEvent("evt_1", "sub_1", 100))).isEqualTo(200);
        assertThat(plan("u1")).isNull(); // the webhook alone (like the redirect) grants nothing
        assertThat(worker.runOnce()).isEqualTo(1);
        assertThat(plan("u1")).isEqualTo("pro");
        assertThat(event("evt_1")).containsEntry("status", "processed").containsEntry("attempts", 1);
        assertThat(count("select count(*) from event_jobs")).isZero();
    }

    @Test
    void runningTheSameJobTwiceLeavesOneSubscriptionAndAttemptsAtOne() throws Exception {
        stripe.put(FakeStripe.sub("sub_1", "cus_1", "active"));
        postSigned(checkoutEvent("evt_1", "sub_1", 100));
        worker.runOnce();
        jdbc.update("insert into event_jobs (event_id, payload) values ('evt_1', '{\"id\":\"evt_1\",\"type\":\"checkout.session.completed\",\"created\":100,\"data\":{\"object\":{\"subscription\":\"sub_1\"}}}'::jsonb)");
        worker.runOnce(); // a re-run (e.g. lease expired after a crash) is a no-op
        assertThat(count("select count(*) from subscriptions")).isEqualTo(1);
        assertThat(event("evt_1")).containsEntry("attempts", 1);
    }

    @Test
    void aFailingAttemptIsRecordedAndTheRetrySucceedsWithAttemptsTwo() throws Exception {
        postSigned(checkoutEvent("evt_1", "sub_1", 100)); // Stripe does not know sub_1 yet: fetch fails
        worker.runOnce();
        assertThat(event("evt_1")).containsEntry("status", "failed").containsEntry("attempts", 1);
        assertThat(event("evt_1").get("error").toString()).contains("No such subscription");
        assertThat(count("select retries from event_jobs where event_id='evt_1'")).isEqualTo(1);

        stripe.put(FakeStripe.sub("sub_1", "cus_1", "active"));
        makeJobsDue();
        worker.runOnce();
        assertThat(event("evt_1")).containsEntry("status", "processed").containsEntry("attempts", 2);
        assertThat(event("evt_1").get("error")).isNull();
        assertThat(plan("u1")).isEqualTo("pro");
    }

    @Test
    void afterTheRetryLimitTheJobIsParkedButStaysVisible() throws Exception {
        postSigned(checkoutEvent("evt_1", "sub_missing", 100));
        for (int i = 0; i < 6; i++) {
            worker.runOnce();
            if (i < 5) makeJobsDue(); // skip the backoff wait between attempts, but not after the last one
        }
        assertThat(event("evt_1")).containsEntry("status", "failed").containsEntry("attempts", 6);
        assertThat(jdbc.queryForObject("select run_after = 'infinity' from event_jobs", Boolean.class)).isTrue();
        assertThat(worker.runOnce()).isZero(); // parked jobs are not picked up again
    }

    // ---------- failure modes ----------
    @Test
    void unknownPriceFailsLoudlyInsteadOfGrantingFree() throws Exception {
        stripe.put(new SubscriptionData("sub_1", "cus_1", "active", "price_unmapped", 1, FakeStripe.START, FakeStripe.END, false, null));
        postSigned(checkoutEvent("evt_1", "sub_1", 100));
        worker.runOnce();
        assertThat(event("evt_1")).containsEntry("status", "failed");
        assertThat(event("evt_1").get("error").toString()).contains("unknown price");
        assertThat(plan("u1")).isNull();
    }

    @Test
    void unknownCustomerThrowsInsteadOfGuessingAUser() {
        stripe.put(FakeStripe.sub("sub_1", "cus_stranger", "active"));
        assertThatThrownBy(() -> sync.sync("sub_1", 100L)).hasMessageContaining("no user for stripe customer");
        assertThat(count("select count(*) from entitlements")).isZero();
    }

    @Test
    void metadataPointingAtAUserThatDoesNotExistIsTheSameUnmappedOutcome() {
        stripe.put(new SubscriptionData("sub_1", "cus_deleted", "active", "price_pro_m", 1, FakeStripe.START, FakeStripe.END, false, "user_that_was_deleted"));
        assertThatThrownBy(() -> sync.sync("sub_1", 100L)).hasMessageContaining("no user for stripe customer");
    }

    @Test
    void aSubscriptionCanNeverBeReassignedToAnotherUser() {
        stripe.put(FakeStripe.sub("sub_1", "cus_1", "active"));
        sync.sync("sub_1", 100L);
        stripe.put(FakeStripe.sub("sub_1", "cus_2", "active"));
        assertThatThrownBy(() -> sync.sync("sub_1", 200L)).hasMessageContaining("another user");
        assertThat(row("sub_1")).containsEntry("user_id", "u1");
    }

    @Test
    void canceledSubscriptionRemovesAccess() {
        stripe.put(FakeStripe.sub("sub_1", "cus_1", "active"));
        sync.sync("sub_1", 100L);
        stripe.put(FakeStripe.sub("sub_1", "cus_1", "canceled"));
        sync.sync("sub_1", 200L);
        assertThat(api.hasAccess("u1", Instant.parse("2030-01-15T00:00:00Z"), null)).isFalse();
    }

    // ---------- out-of-order / compare-and-set ----------
    @Test
    void anOlderEventCannotOverwriteNewerState() {
        stripe.put(FakeStripe.sub("sub_1", "cus_1", "active"));
        assertThat(sync.sync("sub_1", 200L)).isTrue();
        stripe.put(FakeStripe.sub("sub_1", "cus_1", "canceled"));
        assertThat(sync.sync("sub_1", 100L)).isFalse();
        assertThat(plan("u1")).isEqualTo("pro");
        assertThat(row("sub_1")).containsEntry("status", "active").containsEntry("updated_from_event_created", 200L);
    }

    @Test
    void anEqualOrNewerEventIsApplied() {
        stripe.put(FakeStripe.sub("sub_1", "cus_1", "active"));
        sync.sync("sub_1", 200L);
        assertThat(sync.sync("sub_1", 200L)).isTrue();
        stripe.put(FakeStripe.sub("sub_1", "cus_1", "canceled"));
        assertThat(sync.sync("sub_1", 300L)).isTrue();
        assertThat(plan("u1")).isEqualTo("free");
    }

    @Test
    void updatedDeliveredBeforeCreatedStillEndsInTheStripeStateAndTheClockDoesNotRegress() throws Exception {
        stripe.put(new SubscriptionData("sub_1", "cus_1", "active", "price_pro_m", 1, FakeStripe.START, FakeStripe.END, true, null));
        postSigned(subEvent("evt_u", "customer.subscription.updated", "sub_1", 200));
        worker.runOnce();
        postSigned(subEvent("evt_c", "customer.subscription.created", "sub_1", 100));
        worker.runOnce();
        assertThat(row("sub_1")).containsEntry("updated_from_event_created", 200L).containsEntry("cancel_at_period_end", true);
        assertThat(plan("u1")).isEqualTo("pro");
        assertThat(event("evt_c")).containsEntry("status", "processed"); // ignored as stale, not failed
    }

    @Test
    void concurrentWorkersOnTheSameSubscriptionEndWithTheNewestState() throws Exception {
        stripe.put(FakeStripe.sub("sub_1", "cus_1", "canceled"));
        stripe.delay("sub_1", 80); // slow worker holds an OLD snapshot
        var pool = Executors.newFixedThreadPool(2);
        Future<Boolean> slow = pool.submit(() -> sync.sync("sub_1", 100L));
        Thread.sleep(20);
        stripe.put(FakeStripe.sub("sub_1", "cus_1", "active"));
        stripe.delay("sub_1", 0);
        Future<Boolean> fast = pool.submit(() -> sync.sync("sub_1", 200L));
        slow.get(); fast.get(); pool.shutdown();
        assertThat(row("sub_1")).containsEntry("updated_from_event_created", 200L);
        assertThat(plan("u1")).isEqualTo("pro");
    }

    // ---------- several subscriptions per user ----------
    @Test
    void anOldSubscriptionBeingCanceledDoesNotWipeANewerActiveOne() {
        stripe.put(FakeStripe.sub("sub_a", "cus_1", "active"));
        sync.sync("sub_a", 100L);
        stripe.put(new SubscriptionData("sub_b", "cus_1", "active", "price_team", 3, FakeStripe.START, FakeStripe.END, false, null));
        sync.sync("sub_b", 110L);
        stripe.put(FakeStripe.sub("sub_a", "cus_1", "canceled"));
        sync.sync("sub_a", 200L);
        assertThat(plan("u1")).isEqualTo("team");
        assertThat(count("select seats from entitlements where user_id='u1'")).isEqualTo(3);
        stripe.put(new SubscriptionData("sub_b", "cus_1", "canceled", "price_team", 3, FakeStripe.START, FakeStripe.END, false, null));
        sync.sync("sub_b", 210L);
        assertThat(plan("u1")).isEqualTo("free");
    }

    @Test
    void twoDifferentSubscriptionsOfOneUserSyncingConcurrentlyNeverLoseTheActiveOne() throws Exception {
        // Regression for the per-user lock: without it this ended in `free` in a few % of runs.
        var pool = Executors.newFixedThreadPool(2);
        for (int i = 0; i < 40; i++) {
            jdbc.execute("truncate entitlements, subscriptions");
            stripe.put(FakeStripe.sub("sub_a", "cus_1", "active"));
            sync.sync("sub_a", 100L);
            stripe.put(FakeStripe.sub("sub_a", "cus_1", "canceled"));
            stripe.put(new SubscriptionData("sub_b", "cus_1", "active", "price_team", 1, FakeStripe.START, FakeStripe.END, false, null));
            Future<Boolean> a = pool.submit(() -> sync.sync("sub_a", 200L));
            Future<Boolean> b = pool.submit(() -> sync.sync("sub_b", 200L));
            a.get(); b.get();
            assertThat(plan("u1")).as("iteration %d", i).isEqualTo("team");
        }
        pool.shutdown();
    }

    // ---------- invoice / trial events and expiry ----------
    @Test
    void invoicePaymentFailedUsesTheParentSubscriptionAndKeepsAccessOnlyWithinGrace() throws Exception {
        Instant start = Instant.parse("2030-01-01T00:00:00Z");
        stripe.put(new SubscriptionData("sub_1", "cus_1", "past_due", "price_pro_m", 1, start, start.plusSeconds(2_592_000), false, null));
        postSigned(event("evt_i", "invoice.payment_failed",
                "{\"id\":\"in_1\",\"parent\":{\"subscription_details\":{\"subscription\":\"sub_1\"}}}", 500));
        worker.runOnce();
        Instant graceEnd = start.plus(DeriveEntitlement.PAST_DUE_GRACE);
        assertThat(api.hasAccess("u1", graceEnd.minusMillis(1), null)).isTrue();
        assertThat(api.hasAccess("u1", graceEnd, null)).isFalse();
    }

    @Test
    void invoicePaidAfterUnpaidRestoresAccess() throws Exception {
        stripe.put(FakeStripe.sub("sub_1", "cus_1", "unpaid"));
        postSigned(subEvent("e1", "customer.subscription.updated", "sub_1", 100));
        worker.runOnce();
        assertThat(api.hasAccess("u1", Instant.parse("2030-01-15T00:00:00Z"), null)).isFalse();
        stripe.put(FakeStripe.sub("sub_1", "cus_1", "active"));
        postSigned(event("e2", "invoice.paid", "{\"id\":\"in_2\",\"subscription\":\"sub_1\"}", 200));
        worker.runOnce();
        assertThat(plan("u1")).isEqualTo("pro");
    }

    @Test
    void anInvoiceWithNoSubscriptionIsAcknowledgedNotFailed() throws Exception {
        postSigned(event("evt_o", "invoice.paid", "{\"id\":\"in_x\",\"parent\":null}", 100));
        worker.runOnce();
        assertThat(event("evt_o")).containsEntry("status", "processed");
        assertThat(count("select count(*) from entitlements")).isZero();
    }

    @Test
    void trialWillEndSyncsStateAndIsProcessed() throws Exception {
        stripe.put(FakeStripe.sub("sub_1", "cus_1", "trialing"));
        postSigned(subEvent("evt_t", "customer.subscription.trial_will_end", "sub_1", 100));
        worker.runOnce();
        assertThat(plan("u1")).isEqualTo("pro");
    }

    @Test
    void accessEndsAtValidUntilEvenIfNoWebhookEverArrives() {
        stripe.put(FakeStripe.sub("sub_1", "cus_1", "active"));
        sync.sync("sub_1", 100L);
        Instant until = jdbc.queryForObject("select valid_until from entitlements where user_id='u1'", java.sql.Timestamp.class).toInstant();
        assertThat(api.hasAccess("u1", until.minusMillis(1), null)).isTrue();
        assertThat(api.hasAccess("u1", until, null)).isFalse();
    }
}
