package com.pagemint.billing;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import org.junit.jupiter.api.Test;

/** Signature verification and idempotent ingest (mirror of nextjs/test/ingest.test.ts). */
class WebhookIT extends IntegrationTestBase {

    final String evt = subEvent("evt_1", "customer.subscription.created", "sub_1", 100);

    long events() { return count("select count(*) from webhook_events"); }
    long jobs() { return count("select count(*) from event_jobs"); }

    @Test
    void tamperedPayloadIs400AndNothingIsProcessed() throws Exception {
        String good = header(evt);
        assertThat(postRaw(evt.replace("sub_1", "sub_EVIL"), good)).isEqualTo(400);
        assertThat(events()).isZero();
        assertThat(jobs()).isZero();
    }

    @Test
    void reindentedJsonWithTheSameContentIs400BecauseTheRawBytesAreVerified() throws Exception {
        String good = header(evt);
        assertThat(postRaw(evt.replace(",", ", "), good)).isEqualTo(400);
        assertThat(events()).isZero();
    }

    @Test
    void wrongSecretMissingHeaderAndExpiredTimestampAre400() throws Exception {
        assertThat(postRaw(evt, header(evt, "whsec_someone_else", Instant.now().getEpochSecond()))).isEqualTo(400);
        assertThat(postRaw(evt, null)).isEqualTo(400);
        assertThat(postRaw(evt, header(evt, SECRET, Instant.now().getEpochSecond() - 3600))).isEqualTo(400);
        assertThat(events()).isZero();
    }

    @Test
    void validEventGivesOneRowAndOneJob() throws Exception {
        assertThat(postSigned(evt)).isEqualTo(200);
        assertThat(events()).isEqualTo(1);
        assertThat(jobs()).isEqualTo(1);
        assertThat(jdbc.queryForObject("select status from webhook_events", String.class)).isEqualTo("received");
    }

    @Test
    void sameEventTwiceIsIdempotent() throws Exception {
        assertThat(postSigned(evt)).isEqualTo(200);
        var second = mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post("/api/webhooks/stripe")
                .contentType("application/json").content(evt).header("Stripe-Signature", header(evt))).andReturn().getResponse();
        assertThat(second.getStatus()).isEqualTo(200);
        assertThat(second.getContentAsString()).contains("\"duplicate\":true");
        assertThat(events()).isEqualTo(1);
        assertThat(jobs()).isEqualTo(1);
    }

    @Test
    void concurrentDuplicateDeliveriesStillYieldOneRowAndOneJob() throws Exception {
        var pool = Executors.newFixedThreadPool(5);
        List<Future<Integer>> futures = new ArrayList<>();
        for (int i = 0; i < 5; i++) futures.add(pool.submit((Callable<Integer>) () -> postSigned(evt)));
        for (var f : futures) assertThat(f.get()).isEqualTo(200);
        pool.shutdown();
        assertThat(events()).isEqualTo(1);
        assertThat(jobs()).isEqualTo(1);
    }

    @Test
    void enqueueFailureRollsBackTheRowAndReturns500SoStripeRetriesCleanly() throws Exception {
        jdbc.execute("create or replace function boom() returns trigger as $$ begin raise exception 'queue down'; end $$ language plpgsql");
        jdbc.execute("create trigger boom before insert on event_jobs for each row execute function boom()");
        try {
            assertThat(postSigned(evt)).isEqualTo(500);
            assertThat(events()).isZero(); // no row without a job
        } finally {
            jdbc.execute("drop trigger boom on event_jobs");
        }
        assertThat(postSigned(evt)).isEqualTo(200); // Stripe's retry starts from a clean slate
        assertThat(events()).isEqualTo(1);
        assertThat(jobs()).isEqualTo(1);
    }
}
