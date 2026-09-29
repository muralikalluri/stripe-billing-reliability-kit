package com.pagemint.billing;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.MACSigner;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import java.time.Instant;
import java.util.Date;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

class SecurityIT extends IntegrationTestBase {

    @Autowired SubscriptionSync sync;

    @BeforeEach
    void users() {
        user("u1", "cus_1");
        user("u2", "cus_2");
    }

    int status(org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder req) throws Exception {
        return mvc.perform(req).andReturn().getResponse().getStatus();
    }

    static String token(String secret, String sub, String email) throws Exception {
        var claims = new JWTClaimsSet.Builder().subject(sub).claim("email", email)
                .expirationTime(Date.from(Instant.now().plusSeconds(600))).build();
        var jwt = new SignedJWT(new JWSHeader(JWSAlgorithm.HS256), claims);
        jwt.sign(new MACSigner(secret.getBytes()));
        return jwt.serialize();
    }

    @Test
    void everythingExceptTheWebhookNeedsAuthentication() throws Exception {
        assertThat(status(get("/api/me/entitlement"))).isEqualTo(401);
        assertThat(status(get("/api/admin/events"))).isEqualTo(401);
        assertThat(status(post("/api/admin/reconcile"))).isEqualTo(401);
        assertThat(status(get("/anything-else"))).isEqualTo(401);
        // The webhook is reachable without a JWT (it authenticates by Stripe signature): bad signature -> 400, not 401.
        assertThat(status(post("/api/webhooks/stripe").contentType("application/json").content("{}"))).isEqualTo(400);
    }

    @Test
    void aRealTokenSignedWithTheRightSecretIsAcceptedAndOneSignedWithAnotherIsRejected() throws Exception {
        String good = token("0123456789abcdef0123456789abcdef", "u1", "u1@example.com");
        String forged = token("ffffffffffffffffffffffffffffffff", "u1", "u1@example.com");
        assertThat(status(get("/api/me/entitlement").header("Authorization", "Bearer " + good))).isEqualTo(200);
        assertThat(status(get("/api/me/entitlement").header("Authorization", "Bearer " + forged))).isEqualTo(401);
    }

    @Test
    void entitlementIsReadFromTheTokenSubjectOnlyAndIsNotCached() throws Exception {
        stripe.put(FakeStripe.sub("sub_1", "cus_1", "active"));
        sync.sync("sub_1", 100L);
        var res1 = mvc.perform(get("/api/me/entitlement").with(jwt().jwt(j -> j.subject("u1")))).andReturn().getResponse();
        assertThat(res1.getContentAsString()).contains("\"access\":true").contains("\"plan\":\"pro\"");
        assertThat(res1.getHeader("Cache-Control")).contains("no-store");
        var res2 = mvc.perform(get("/api/me/entitlement").with(jwt().jwt(j -> j.subject("u2")))).andReturn().getResponse();
        assertThat(res2.getContentAsString()).contains("\"access\":false");
        // a user id in the query string is ignored
        var res3 = mvc.perform(get("/api/me/entitlement?userId=u1").with(jwt().jwt(j -> j.subject("u2")))).andReturn().getResponse();
        assertThat(res3.getContentAsString()).contains("\"access\":false");
    }

    @Test
    void adminEndpointsAre403ForNonAdminsAndWorkForTheAllowlistedEmail() throws Exception {
        var user = jwt().jwt(j -> j.subject("u1").claim("email", "u1@example.com"));
        var admin = jwt().jwt(j -> j.subject("boss").claim("email", "Boss@Example.com"));
        assertThat(status(get("/api/admin/events").with(user))).isEqualTo(403);
        assertThat(status(post("/api/admin/reconcile").with(user))).isEqualTo(403);
        assertThat(status(post("/api/admin/events/evt_1/retry").with(user))).isEqualTo(403);
        assertThat(status(get("/api/admin/events").with(admin))).isEqualTo(200);
    }

    @Test
    void adminCanRetryOnlyFailedEvents() throws Exception {
        var admin = jwt().jwt(j -> j.subject("boss").claim("email", "boss@example.com"));
        stripe.eventJson = subEvent("evt_f", "customer.subscription.updated", "sub_1", 100);
        jdbc.update("insert into webhook_events (event_id, type, status, error, attempts) values ('evt_f','customer.subscription.updated','failed','boom',6)");
        assertThat(status(post("/api/admin/events/evt_f/retry").with(admin))).isEqualTo(200);
        assertThat(jdbc.queryForObject("select status from webhook_events where event_id='evt_f'", String.class)).isEqualTo("received");
        assertThat(count("select count(*) from event_jobs where event_id='evt_f'")).isEqualTo(1);
        assertThat(status(post("/api/admin/events/evt_f/retry").with(admin))).isEqualTo(409); // no longer failed
    }

    @Test
    void adminCanTriggerAReconcile() throws Exception {
        stripe.put(FakeStripe.sub("sub_1", "cus_1", "active"));
        var admin = jwt().jwt(j -> j.subject("boss").claim("email", "boss@example.com"));
        assertThat(status(post("/api/admin/reconcile").with(admin))).isEqualTo(200);
        assertThat(plan("u1")).isEqualTo("pro");
        assertThat(count("select count(*) from reconcile_runs")).isEqualTo(1);
    }
}
