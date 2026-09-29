package com.pagemint.billing;

import java.time.Instant;
import java.util.List;

/**
 * Everything the app needs from Stripe, behind one boundary. Responses are mapped to plain records here so the rest
 * of the code never depends on stripe-java model details (and tests can stub it).
 */
public interface StripeGateway {

    /** {@code cancelAtPeriodEnd} is already "cancel_at_period_end OR a cancel_at date is set". */
    record SubscriptionData(
            String id, String customerId, String status, String priceId, int quantity,
            Instant periodStart, Instant periodEnd, boolean cancelAtPeriodEnd, String metadataUserId) {}

    record Page(List<SubscriptionData> data, boolean hasMore) {}

    SubscriptionData retrieveSubscription(String id);

    /** All statuses, one page. {@code customerId} may be null (global listing). */
    Page listSubscriptions(String customerId, String startingAfter, int limit);

    /** Raw event JSON (used to retry a failed event; webhook_events stores no payload). */
    String retrieveEventJson(String id);

    class GatewayException extends RuntimeException {
        private final String code;
        private final Integer statusCode;

        public GatewayException(String message, String code, Integer statusCode, Throwable cause) {
            super(message, cause);
            this.code = code;
            this.statusCode = statusCode;
        }

        /** Stripe error code, e.g. "resource_missing"; "ECONNRESET" for connection failures. */
        public String code() { return code; }

        public Integer statusCode() { return statusCode; }
    }
}
