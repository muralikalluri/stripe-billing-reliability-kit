package com.pagemint.billing;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/** Polls the outbox. {@link #runOnce()} is public so tests (and the CLI) can drive it deterministically. */
@Component
public class JobWorker {

    private static final Logger log = LoggerFactory.getLogger(JobWorker.class);

    private final JobQueue queue;
    private final EventProcessor processor;
    private final ObjectMapper mapper;

    public JobWorker(JobQueue queue, EventProcessor processor, ObjectMapper mapper) {
        this.queue = queue;
        this.processor = processor;
        this.mapper = mapper;
    }

    @Scheduled(fixedDelayString = "${pagemint.worker.poll-ms:1000}")
    public void poll() {
        try {
            runOnce();
        } catch (RuntimeException e) {
            log.error("worker poll failed", e);
        }
    }

    /** @return number of jobs handled (successfully or not) */
    public int runOnce() {
        var jobs = queue.claim(5);
        for (var job : jobs) {
            try {
                processor.process(mapper.readTree(job.payload()));
                queue.complete(job.eventId());
            } catch (Exception e) {
                log.warn("event {} failed (retry {}): {}", job.eventId(), job.retries(), e.getMessage());
                queue.fail(job);
            }
        }
        return jobs.size();
    }
}
