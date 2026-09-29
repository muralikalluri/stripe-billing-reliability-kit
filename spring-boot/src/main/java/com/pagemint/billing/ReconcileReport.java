package com.pagemint.billing;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;

/** Same JSON shape as ReconcileReport in nextjs/src/reconcile/reconcile.ts (camelCase). */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ReconcileReport(
        String runId,
        String trigger,
        String startedAt,
        String finishedAt,
        boolean complete,
        int scanned,
        Counts counts,
        boolean circuitBreakerTripped,
        List<DriftItem> drift) {

    public record Counts(int inSync, int repaired, int failed, int skipped, int reported) {}

    /** kind: missing_in_db | field_mismatch | entitlement_stale | orphan; action: repaired | failed | skipped | reported */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record DriftItem(
            // Always present (explicit null), like the Next.js report; the contract lists both as required.
            @JsonInclude(JsonInclude.Include.ALWAYS) String stripeSubscriptionId,
            @JsonInclude(JsonInclude.Include.ALWAYS) String userId,
            String kind, List<String> fields, String action, String error) {

        DriftItem withAction(String newAction, String newError) {
            return new DriftItem(stripeSubscriptionId, userId, kind, fields, newAction, newError);
        }
    }
}
