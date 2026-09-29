CREATE TABLE "reconcile_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"trigger" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"complete" boolean NOT NULL,
	"report" jsonb NOT NULL
);
