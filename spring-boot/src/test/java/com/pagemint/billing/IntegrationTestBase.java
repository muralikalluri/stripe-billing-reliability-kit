package com.pagemint.billing;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.junit.jupiter.api.BeforeEach;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.containers.PostgreSQLContainer;

@SpringBootTest(properties = {
        "pagemint.scheduling.enabled=false",
        "STRIPE_SECRET_KEY=sk_test_fixture_not_real",
        "STRIPE_WEBHOOK_SECRET=whsec_test_fixture_not_real",
        "JWT_SECRET=0123456789abcdef0123456789abcdef",
        "ADMIN_EMAILS=boss@example.com",
        "STRIPE_PRICE_PRO_MONTHLY=price_pro_m",
        "STRIPE_PRICE_PRO_YEARLY=price_pro_y",
        "STRIPE_PRICE_TEAM_SEAT=price_team"})
@AutoConfigureMockMvc
@Import(IntegrationTestBase.StripeConfig.class)
abstract class IntegrationTestBase {

    static final String SECRET = "whsec_test_fixture_not_real";
    static final PostgreSQLContainer<?> PG = new PostgreSQLContainer<>("postgres:16-alpine");

    static {
        PG.start();
    }

    @DynamicPropertySource
    static void db(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", PG::getJdbcUrl);
        r.add("spring.datasource.username", PG::getUsername);
        r.add("spring.datasource.password", PG::getPassword);
    }

    @TestConfiguration
    static class StripeConfig {
        @Bean
        @Primary
        FakeStripe fakeStripe() {
            return new FakeStripe();
        }
    }

    @Autowired JdbcTemplate jdbc;
    @Autowired FakeStripe stripe;
    @Autowired MockMvc mvc;
    @Autowired JobWorker worker;

    @BeforeEach
    void cleanState() {
        jdbc.execute("truncate webhook_events, event_jobs, entitlements, subscriptions, customers, users, reconcile_runs cascade");
        stripe.reset();
    }

    // ---------- helpers ----------
    void user(String id, String stripeCustomerId) {
        jdbc.update("insert into users (id, email) values (?, ?)", id, id + "@example.com");
        if (stripeCustomerId != null) {
            jdbc.update("insert into customers (user_id, stripe_customer_id) values (?, ?)", id, stripeCustomerId);
        }
    }

    static String hmac(String secret, String data) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            StringBuilder sb = new StringBuilder();
            for (byte b : mac.doFinal(data.getBytes(StandardCharsets.UTF_8))) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    static String header(String body, String secret, long ts) {
        return "t=" + ts + ",v1=" + hmac(secret, ts + "." + body);
    }

    static String header(String body) {
        return header(body, SECRET, Instant.now().getEpochSecond());
    }

    static String event(String id, String type, String objectJson, long created) {
        return "{\"id\":\"" + id + "\",\"object\":\"event\",\"type\":\"" + type + "\",\"created\":" + created
                + ",\"livemode\":false,\"data\":{\"object\":" + objectJson + "}}";
    }

    static String checkoutEvent(String id, String subId, long created) {
        return event(id, "checkout.session.completed", "{\"id\":\"cs_1\",\"subscription\":\"" + subId + "\"}", created);
    }

    static String subEvent(String id, String type, String subId, long created) {
        return event(id, type, "{\"id\":\"" + subId + "\"}", created);
    }

    int postRaw(String body, String signatureHeader) throws Exception {
        var req = org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post("/api/webhooks/stripe")
                .contentType("application/json").content(body);
        if (signatureHeader != null) req.header("Stripe-Signature", signatureHeader);
        return mvc.perform(req).andReturn().getResponse().getStatus();
    }

    int postSigned(String body) throws Exception {
        return postRaw(body, header(body));
    }

    long count(String sql, Object... args) {
        return jdbc.queryForObject(sql, Long.class, args);
    }

    String plan(String userId) {
        var l = jdbc.queryForList("select plan from entitlements where user_id = ?", String.class, userId);
        return l.isEmpty() ? null : l.get(0);
    }

    /** Make every parked/backed-off job due now so runOnce() picks it up (tests must not sleep through backoff). */
    void makeJobsDue() {
        jdbc.update("update event_jobs set run_after = now(), locked_until = null");
    }
}
