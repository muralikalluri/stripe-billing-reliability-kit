package com.pagemint.billing;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.List;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/** Port of processEvent: same status/attempts/error semantics as the Next.js worker. */
@Component
public class EventProcessor {

    private static final Logger log = LoggerFactory.getLogger(EventProcessor.class);

    /** Events that carry (or point to) a subscription: everything in SPEC 3.4. */
    private static final Set<String> SUBSCRIPTION_EVENTS = Set.of(
            "checkout.session.completed",
            "customer.subscription.created",
            "customer.subscription.updated",
            "customer.subscription.deleted",
            "customer.subscription.trial_will_end",
            "invoice.paid",
            "invoice.payment_failed");

    private final JdbcTemplate jdbc;
    private final SubscriptionSync sync;

    public EventProcessor(JdbcTemplate jdbc, SubscriptionSync sync) {
        this.jdbc = jdbc;
        this.sync = sync;
    }

    static String idOf(JsonNode n) {
        if (n == null || n.isMissingNode() || n.isNull()) return null;
        if (n.isTextual()) return n.asText();
        JsonNode id = n.path("id");
        return id.isTextual() ? id.asText() : null;
    }

    static String subscriptionIdOf(JsonNode event) {
        JsonNode obj = event.path("data").path("object");
        return switch (event.path("type").asText()) {
            case "checkout.session.completed" -> idOf(obj.path("subscription"));
            case "invoice.paid", "invoice.payment_failed" -> {
                // Newer API versions moved this to invoice.parent.subscription_details.subscription.
                String viaParent = idOf(obj.path("parent").path("subscription_details").path("subscription"));
                yield viaParent != null ? viaParent : idOf(obj.path("subscription"));
            }
            default -> idOf(obj);
        };
    }

    /**
     * Idempotent: safe to run twice or after a crash. Throws on failure so the queue retries; status, attempts and
     * error are recorded first. Never revokes access from an event type: subscription state decides.
     */
    public void process(JsonNode event) {
        String eventId = event.path("id").asText();
        String type = event.path("type").asText();
        long created = event.path("created").asLong();

        List<String> claimed = jdbc.queryForList(
                "update webhook_events set status='processing', attempts=attempts+1, error=null"
                        + " where event_id=? and status<>'processed' returning event_id", String.class, eventId);
        if (claimed.isEmpty()) return; // already processed (or unknown row): nothing to do

        try {
            if (SUBSCRIPTION_EVENTS.contains(type)) {
                String subId = subscriptionIdOf(event);
                if (subId != null) sync.sync(subId, created);
                // else: e.g. a one-off invoice with no subscription; acknowledged.
                if (type.equals("customer.subscription.trial_will_end")) {
                    log.info("trial_will_end for {} (notification hook point)", subId);
                }
            }
            jdbc.update("update webhook_events set status='processed', processed_at=now(), error=null where event_id=?",
                    eventId);
        } catch (RuntimeException e) {
            jdbc.update("update webhook_events set status='failed', error=? where event_id=?",
                    String.valueOf(e.getMessage()), eventId);
            throw e;
        }
    }
}
