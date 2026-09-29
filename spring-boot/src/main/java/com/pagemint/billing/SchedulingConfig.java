package com.pagemint.billing;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnExpression;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/** Scheduling is on by default; off for the CLI profile and in tests (pagemint.scheduling.enabled=false). */
@Configuration
@EnableScheduling
@ConditionalOnProperty(name = "pagemint.scheduling.enabled", havingValue = "true", matchIfMissing = true)
public class SchedulingConfig {

    /**
     * Nightly reconcile at 03:00 UTC. DISABLE_SCHEDULE=1 (used by the chaos harness) turns it off so a scheduled run
     * cannot repair state in the middle of a scenario. The webhook worker poll is unaffected.
     */
    @Component
    @ConditionalOnExpression("'${DISABLE_SCHEDULE:0}' != '1'")
    static class Nightly {
        private static final Logger log = LoggerFactory.getLogger(Nightly.class);
        private final ReconcileService service;

        Nightly(ReconcileService service) {
            this.service = service;
        }

        @Scheduled(cron = "0 0 3 * * *", zone = "UTC")
        void run() {
            var r = service.runLocked("nightly");
            log.info(r.map(x -> "nightly reconcile: repaired=" + x.counts().repaired() + " failed=" + x.counts().failed())
                    .orElse("nightly reconcile skipped: already running"));
        }
    }
}
