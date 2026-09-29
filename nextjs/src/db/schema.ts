import { bigint, boolean, jsonb, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const customers = pgTable("customers", {
  userId: text("user_id").primaryKey().references(() => users.id),
  stripeCustomerId: text("stripe_customer_id").notNull().unique(),
});

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    stripeSubscriptionId: text("stripe_subscription_id").notNull(),
    status: text("status").notNull(),
    priceId: text("price_id").notNull(),
    quantity: integer("quantity").notNull().default(1),
    currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    // Unix seconds of the newest event applied (M2 uses this for out-of-order handling).
    updatedFromEventCreated: bigint("updated_from_event_created", { mode: "number" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("subscriptions_stripe_subscription_id_uq").on(t.stripeSubscriptionId)],
);

// The ONLY table the app checks for access.
export const entitlements = pgTable("entitlements", {
  userId: text("user_id").primaryKey().references(() => users.id),
  plan: text("plan").notNull(),
  seats: integer("seats").notNull().default(1),
  validUntil: timestamp("valid_until", { withTimezone: true }),
});

// status: received -> processing -> processed | failed
export const webhookEvents = pgTable("webhook_events", {
  eventId: text("event_id").primaryKey(),
  type: text("type").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  status: text("status").notNull().default("received"),
  error: text("error"),
  attempts: integer("attempts").notNull().default(0),
});

export type Subscription = typeof subscriptions.$inferSelect;

// One row per reconcile run; `report` is the drift report (also written to reconcile-report.json by the CLI).
export const reconcileRuns = pgTable("reconcile_runs", {
  id: text("id").primaryKey(),
  trigger: text("trigger").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }).notNull(),
  complete: boolean("complete").notNull(),
  report: jsonb("report").notNull(),
});
