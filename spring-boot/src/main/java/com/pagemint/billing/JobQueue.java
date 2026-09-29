package com.pagemint.billing;

import java.util.ArrayList;
import java.util.List;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Transactional outbox in Postgres (the Next.js side uses pg-boss). The job row is inserted in the SAME transaction
 * as the webhook_events row, so "row exists" always means "a job exists". Workers claim with FOR UPDATE SKIP LOCKED
 * and a lease; a crashed worker's lease expires and the job runs again (processing is idempotent).
 */
@Component
public class JobQueue {

    public record Job(String eventId, String payload, int retries) {}

    static final int RETRY_LIMIT = 5;
    static final int RETRY_DELAY_SECONDS = 5; // exponential: 5s, 10s, 20s, ...
    static final int LEASE_SECONDS = 300;

    private final JdbcTemplate jdbc;
    private final TransactionTemplate tx;

    public JobQueue(JdbcTemplate jdbc, TransactionTemplate tx) {
        this.jdbc = jdbc;
        this.tx = tx;
    }

    /** Call inside the ingest transaction. */
    public void enqueue(String eventId, String payloadJson) {
        jdbc.update("insert into event_jobs (event_id, payload) values (?, ?::jsonb)", eventId, payloadJson);
    }

    public List<Job> claim(int max) {
        List<Job> jobs = tx.execute(status -> {
            List<Job> found = jdbc.query(
                    "select event_id, payload::text as payload, retries from event_jobs"
                            + " where run_after <= now() and (locked_until is null or locked_until < now())"
                            + " order by run_after limit ? for update skip locked",
                    (rs, i) -> new Job(rs.getString("event_id"), rs.getString("payload"), rs.getInt("retries")), max);
            for (Job j : found) {
                jdbc.update("update event_jobs set locked_until = now() + (? * interval '1 second') where event_id = ?",
                        LEASE_SECONDS, j.eventId());
            }
            return found;
        });
        return jobs == null ? new ArrayList<>() : jobs;
    }

    public void complete(String eventId) {
        jdbc.update("delete from event_jobs where event_id = ?", eventId);
    }

    /** Back off exponentially; after RETRY_LIMIT retries the job is parked (run_after = infinity) but kept visible. */
    public void fail(Job job) {
        jdbc.update("update event_jobs set retries = retries + 1, locked_until = null,"
                        + " run_after = case when retries + 1 > ? then 'infinity'::timestamptz"
                        + " else now() + (? * power(2, retries) * interval '1 second') end"
                        + " where event_id = ?",
                RETRY_LIMIT, RETRY_DELAY_SECONDS, job.eventId());
    }

    /** Admin retry: (re)queue an event whose status was reset to received. */
    public void requeue(String eventId, String payloadJson) {
        jdbc.update("insert into event_jobs (event_id, payload) values (?, ?::jsonb)"
                        + " on conflict (event_id) do update set payload = excluded.payload, run_after = now(),"
                        + " retries = 0, locked_until = null",
                eventId, payloadJson);
    }
}
