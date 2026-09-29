package com.pagemint.billing;

import static org.assertj.core.api.Assertions.assertThat;

import com.stripe.model.Subscription;
import com.stripe.net.ApiResource;
import java.time.Instant;
import org.junit.jupiter.api.Test;

/**
 * The integration tests stub StripeGateway, so this is the only offline check of the real stripe-java mapping:
 * item-level period fields (current API version), cancel_at handling, metadata and quantity defaults.
 */
class StripeMappingTest {

    static Subscription parse(String json) {
        return ApiResource.GSON.fromJson(json, Subscription.class);
    }

    static final String BASE = """
            {"id":"sub_1","object":"subscription","customer":"cus_1","status":"active","cancel_at_period_end":false,
             "metadata":{"user_id":"u1"},
             "items":{"object":"list","data":[{"id":"si_1","object":"subscription_item","quantity":3,
               "current_period_start":1790000000,"current_period_end":1792592000,
               "price":{"id":"price_pro_m","object":"price"}}]}}
            """;

    @Test
    void mapsTheFieldsSyncAndReconcileDependOn() {
        var d = StripeClientGateway.map(parse(BASE));
        assertThat(d.id()).isEqualTo("sub_1");
        assertThat(d.customerId()).isEqualTo("cus_1");
        assertThat(d.status()).isEqualTo("active");
        assertThat(d.priceId()).isEqualTo("price_pro_m");
        assertThat(d.quantity()).isEqualTo(3);
        assertThat(d.periodStart()).isEqualTo(Instant.ofEpochSecond(1790000000L));
        assertThat(d.periodEnd()).isEqualTo(Instant.ofEpochSecond(1792592000L));
        assertThat(d.cancelAtPeriodEnd()).isFalse();
        assertThat(d.metadataUserId()).isEqualTo("u1");
    }

    @Test
    void aScheduledCancelAtDateAlsoMeansNotRenewing() {
        var d = StripeClientGateway.map(parse(BASE.replace("\"cancel_at_period_end\":false", "\"cancel_at_period_end\":false,\"cancel_at\":1792592000")));
        assertThat(d.cancelAtPeriodEnd()).isTrue();
        var e = StripeClientGateway.map(parse(BASE.replace("\"cancel_at_period_end\":false", "\"cancel_at_period_end\":true")));
        assertThat(e.cancelAtPeriodEnd()).isTrue();
    }

    @Test
    void missingQuantityDefaultsToOneAndMissingMetadataIsNull() {
        var d = StripeClientGateway.map(parse(BASE.replace("\"quantity\":3,", "").replace("\"metadata\":{\"user_id\":\"u1\"},", "")));
        assertThat(d.quantity()).isEqualTo(1);
        assertThat(d.metadataUserId()).isNull();
    }
}
