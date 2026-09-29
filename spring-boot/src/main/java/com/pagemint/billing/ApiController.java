package com.pagemint.billing;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** Entitlement API + admin endpoints. Identity comes ONLY from the verified JWT, never from a parameter. */
@RestController
public class ApiController {

    private static final List<String> STATUSES = List.of("received", "processing", "processed", "failed");

    private final JdbcTemplate jdbc;
    private final TransactionTemplate tx;
    private final StripeGateway stripe;
    private final JobQueue queue;
    private final ReconcileService reconcile;

    public ApiController(JdbcTemplate jdbc, TransactionTemplate tx, StripeGateway stripe, JobQueue queue,
                         ReconcileService reconcile) {
        this.jdbc = jdbc;
        this.tx = tx;
        this.stripe = stripe;
        this.queue = queue;
        this.reconcile = reconcile;
    }

    /** Access checks read the entitlements table ONLY. Fails closed on free, missing or expired validUntil. */
    public boolean hasAccess(String userId, Instant now, String[] planOut) {
        var rows = jdbc.query("select plan, valid_until from entitlements where user_id = ?",
                (rs, i) -> new Object[] {rs.getString("plan"), rs.getTimestamp("valid_until")}, userId);
        if (rows.isEmpty()) return false;
        String plan = (String) rows.get(0)[0];
        Timestamp until = (Timestamp) rows.get(0)[1];
        if (plan.equals("free") || until == null || !until.toInstant().isAfter(now)) return false;
        if (planOut != null) planOut[0] = plan;
        return true;
    }

    @GetMapping("/api/me/entitlement")
    public ResponseEntity<Map<String, Object>> myEntitlement(@AuthenticationPrincipal Jwt jwt) {
        String[] plan = new String[1];
        Map<String, Object> body = new LinkedHashMap<>();
        if (hasAccess(jwt.getSubject(), Instant.now(), plan)) {
            body.put("access", true);
            body.put("plan", plan[0]);
        } else {
            body.put("access", false);
        }
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(body);
    }

    @GetMapping("/api/admin/events")
    public List<Map<String, Object>> events(@RequestParam(required = false) String status) {
        boolean filter = status != null && STATUSES.contains(status);
        String sql = "select event_id, type, status, attempts, error, received_at, processed_at from webhook_events"
                + (filter ? " where status = ?" : "") + " order by received_at desc limit 200";
        return filter ? jdbc.queryForList(sql, status) : jdbc.queryForList(sql);
    }

    /** Re-enqueue a FAILED event: refetch the payload from Stripe, reset the row to received, enqueue, one tx. */
    @PostMapping("/api/admin/events/{id}/retry")
    public ResponseEntity<Map<String, Object>> retry(@PathVariable String id) {
        String payload = stripe.retrieveEventJson(id);
        Boolean requeued = tx.execute(s -> {
            var n = jdbc.queryForList(
                    "update webhook_events set status='received', error=null where event_id=? and status='failed'"
                            + " returning event_id", String.class, id);
            if (n.isEmpty()) return false;
            queue.requeue(id, payload);
            return true;
        });
        return Boolean.TRUE.equals(requeued)
                ? ResponseEntity.ok(Map.of("result", "requeued"))
                : ResponseEntity.status(409).body(Map.of("result", "not_failed"));
    }

    @PostMapping("/api/admin/reconcile")
    public ResponseEntity<Map<String, Object>> reconcileNow() {
        var report = reconcile.runLocked("manual");
        if (report.isEmpty()) return ResponseEntity.status(409).body(Map.of("result", "already_running"));
        var r = report.get();
        return ResponseEntity.ok(Map.of("result", "done", "runId", r.runId(), "complete", r.complete(),
                "counts", r.counts()));
    }
}
