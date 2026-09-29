-- Spring-only queue state (the Next.js implementation uses pg-boss). webhook_events stays identical in both.
-- A job row is written in the SAME transaction as its webhook_events row (transactional outbox).
CREATE TABLE "event_jobs" (
	"event_id" text PRIMARY KEY REFERENCES "webhook_events"("event_id") ON DELETE CASCADE,
	"payload" jsonb NOT NULL,
	"run_after" timestamptz NOT NULL DEFAULT now(),
	"retries" integer NOT NULL DEFAULT 0,
	"locked_until" timestamptz
);
CREATE INDEX "event_jobs_due_idx" ON "event_jobs" ("run_after");
