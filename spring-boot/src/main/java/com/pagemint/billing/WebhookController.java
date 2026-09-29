package com.pagemint.billing;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.stripe.net.Webhook;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * 1. verify the signature over the RAW bytes (before any JSON parsing) -> 400 if bad
 * 2. in ONE transaction: insert webhook_events (idempotent on event_id) + enqueue the job
 * 3. 200. A conflict means the event was already accepted (row + job are atomic).
 * If the enqueue fails the transaction rolls back and we return 500 so Stripe retries.
 */
@RestController
public class WebhookController {

    private static final Logger log = LoggerFactory.getLogger(WebhookController.class);
    private static final long TOLERANCE_SECONDS = 300;

    private final Settings settings;
    private final JdbcTemplate jdbc;
    private final TransactionTemplate tx;
    private final JobQueue queue;
    private final ObjectMapper mapper;

    public WebhookController(Settings settings, JdbcTemplate jdbc, TransactionTemplate tx, JobQueue queue,
                             ObjectMapper mapper) {
        this.settings = settings;
        this.jdbc = jdbc;
        this.tx = tx;
        this.queue = queue;
        this.mapper = mapper;
    }

    // byte[]: no charset converter or Jackson touches the body before the signature check.
    @PostMapping("/api/webhooks/stripe")
    public ResponseEntity<Map<String, Object>> receive(
            @RequestBody byte[] raw,
            @RequestHeader(value = "Stripe-Signature", required = false) String signature) {
        if (signature == null || signature.isBlank()) return error(400, "missing signature");

        String payload = new String(raw, StandardCharsets.UTF_8);
        try {
            Webhook.Signature.verifyHeader(payload, signature, settings.webhookSecret(), TOLERANCE_SECONDS);
        } catch (Exception e) {
            return error(400, "invalid signature");
        }

        // Parsed as plain JSON only AFTER verification (stripe-java's Event model can silently mismatch API versions).
        JsonNode event;
        try {
            event = mapper.readTree(payload);
        } catch (Exception e) {
            return error(400, "invalid payload");
        }
        String id = event.path("id").asText("");
        String type = event.path("type").asText("");
        if (id.isEmpty() || type.isEmpty()) return error(400, "invalid payload");

        try {
            Boolean inserted = tx.execute(status -> {
                int n = jdbc.update(
                        "insert into webhook_events (event_id, type) values (?, ?) on conflict (event_id) do nothing",
                        id, type);
                if (n == 1) queue.enqueue(id, payload);
                return n == 1;
            });
            return ResponseEntity.ok(Map.of("received", true, "duplicate", !Boolean.TRUE.equals(inserted)));
        } catch (Exception e) {
            log.error("webhook ingest failed for {}", id, e);
            return error(500, "enqueue failed");
        }
    }

    private static ResponseEntity<Map<String, Object>> error(int status, String reason) {
        return ResponseEntity.status(status).body(Map.of("error", reason));
    }
}
