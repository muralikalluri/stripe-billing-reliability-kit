import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { customers, entitlements, reconcileRuns, subscriptions } from "@/db/schema";
import { recomputeEntitlement, computeEntitlement, subscriptionFields, syncSubscription } from "@/worker/process-event";

export interface ReconcileStripe {
  subscriptions: {
    retrieve(id: string): Promise<Stripe.Subscription>;
    list(params: { status: "all"; limit: number; starting_after?: string; customer?: string }): Promise<{ data: Stripe.Subscription[]; has_more: boolean }>;
  };
}

export type DriftKind = "missing_in_db" | "field_mismatch" | "entitlement_stale" | "orphan";
export type DriftAction = "repaired" | "failed" | "skipped" | "reported";

export interface DriftItem {
  stripeSubscriptionId: string | null;
  userId: string | null;
  kind: DriftKind;
  fields?: string[];
  action: DriftAction;
  error?: string;
}

export interface ReconcileReport {
  runId: string;
  trigger: "nightly" | "manual" | "cli";
  startedAt: string;
  finishedAt: string;
  /** false if any Stripe listing failed part-way: orphan detection is skipped then. */
  complete: boolean;
  scanned: number;
  counts: { inSync: number; repaired: number; failed: number; skipped: number; reported: number };
  circuitBreakerTripped: boolean;
  drift: DriftItem[];
}

export interface ReconcileOptions {
  trigger?: ReconcileReport["trigger"];
  pageSize?: number;
  /** Stop repairing (report only) if drift exceeds this share AND this many subscriptions: wrong account/mode guard. */
  breaker?: { ratio: number; min: number };
  retries?: number;
  retryDelayMs?: number;
}

const COMPARED = ["status", "priceId", "quantity", "currentPeriodStart", "currentPeriodEnd", "cancelAtPeriodEnd"] as const;

function diffFields(row: typeof subscriptions.$inferSelect, sub: Stripe.Subscription): string[] {
  const f = subscriptionFields(sub);
  return COMPARED.filter((k) => {
    const a = row[k];
    const b = f[k];
    return a instanceof Date || b instanceof Date ? (a as Date | null)?.getTime() !== (b as Date | null)?.getTime() : a !== b;
  });
}

async function withRetry<T>(fn: () => Promise<T>, retries: number, delayMs: number): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      const retryable = status === 429 || (status !== undefined && status >= 500) || (e as { code?: string }).code === "ECONNRESET";
      if (!retryable || attempt >= retries) throw e;
      await new Promise((r) => setTimeout(r, delayMs * 2 ** attempt));
    }
  }
}

/**
 * Detect drift from Stripe's listing, repair ONLY via syncSubscription (which re-fetches under the lock:
 * a listing snapshot may be stale by the time we write). Repairs pass version=null so the event clock is
 * never moved. One failing subscription never aborts the run.
 */
export async function reconcile(db: Db, stripe: ReconcileStripe, opts: ReconcileOptions = {}): Promise<ReconcileReport> {
  const { trigger = "manual", pageSize = 100, breaker = { ratio: 0.5, min: 20 }, retries = 3, retryDelayMs = 500 } = opts;
  const startedAt = new Date();
  const drift: DriftItem[] = [];
  let complete = true;

  const dbRows = await db.select().from(subscriptions);
  const byStripeId = new Map(dbRows.map((r) => [r.stripeSubscriptionId, r]));
  const dbCustomers = await db.select().from(customers);

  // 1. Collect what Stripe has: the global listing, plus a per-customer listing for every customer we know
  //    (Stripe omits test-clock subscriptions from the global listing unless filtered by customer).
  const seen = new Map<string, Stripe.Subscription>();
  const collect = async (customer?: string) => {
    let after: string | undefined;
    try {
      for (;;) {
        const page = await withRetry(
          () => stripe.subscriptions.list({ status: "all", limit: pageSize, ...(after ? { starting_after: after } : {}), ...(customer ? { customer } : {}) }),
          retries,
          retryDelayMs,
        );
        for (const s of page.data) seen.set(s.id, s);
        if (!page.has_more || page.data.length === 0) return;
        after = page.data[page.data.length - 1].id;
      }
    } catch {
      complete = false; // keep what we have; skip orphan detection
    }
  };
  await collect();
  for (const c of dbCustomers) await collect(c.stripeCustomerId);

  // 2. Classify.
  type Work = { sub: Stripe.Subscription; kind: DriftKind; fields?: string[] };
  const work: Work[] = [];
  let inSync = 0;
  for (const sub of seen.values()) {
    const row = byStripeId.get(sub.id);
    if (!row) work.push({ sub, kind: "missing_in_db" });
    else {
      const fields = diffFields(row, sub);
      if (fields.length) work.push({ sub, kind: "field_mismatch", fields });
      else inSync++;
    }
  }

  // 3. Repair (unless the circuit breaker trips).
  const tripped = work.length >= breaker.min && seen.size > 0 && work.length / seen.size > breaker.ratio;
  const userOf = (sub: Stripe.Subscription) => {
    const cid = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
    return dbCustomers.find((c) => c.stripeCustomerId === cid)?.userId ?? sub.metadata?.user_id ?? null;
  };
  for (const w of work) {
    const item: DriftItem = { stripeSubscriptionId: w.sub.id, userId: userOf(w.sub), kind: w.kind, fields: w.fields, action: "reported" };
    if (!tripped) {
      try {
        await syncSubscription(db, stripe, w.sub.id, null);
        item.action = "repaired";
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        item.action = /no user for stripe customer/.test(msg) ? "skipped" : "failed";
        item.error = /no user for stripe customer/.test(msg) ? "unmapped_customer" : msg;
      }
    }
    drift.push(item);
  }

  // 4. Orphans: DB rows Stripe's listing never returned. Only meaningful after a COMPLETE listing; confirm by retrieve.
  if (complete) {
    for (const row of dbRows) {
      if (seen.has(row.stripeSubscriptionId)) continue;
      try {
        const sub = await withRetry(() => stripe.subscriptions.retrieve(row.stripeSubscriptionId), retries, retryDelayMs);
        const fields = diffFields(row, sub);
        if (!fields.length) { inSync++; continue; }
        const item: DriftItem = { stripeSubscriptionId: sub.id, userId: row.userId, kind: "field_mismatch", fields, action: "reported" };
        if (!tripped) {
          try { await syncSubscription(db, stripe, sub.id, null); item.action = "repaired"; }
          catch (e) { item.action = "failed"; item.error = e instanceof Error ? e.message : String(e); }
        }
        drift.push(item);
      } catch (e) {
        if ((e as { code?: string }).code === "resource_missing") {
          // Reported, never auto-revoked in M3: a human decides.
          drift.push({ stripeSubscriptionId: row.stripeSubscriptionId, userId: row.userId, kind: "orphan", action: "reported" });
        } else {
          drift.push({ stripeSubscriptionId: row.stripeSubscriptionId, userId: row.userId, kind: "orphan", action: "failed", error: e instanceof Error ? e.message : String(e) });
        }
      }
    }
  }

  // 5. Entitlement drift: stored entitlements vs what the subscription rows imply (runs after repairs).
  const userIds = new Set((await db.select({ u: subscriptions.userId }).from(subscriptions)).map((r) => r.u));
  for (const userId of userIds) {
    const [stored] = await db.select().from(entitlements).where(eq(entitlements.userId, userId));
    const want = await computeEntitlement(db, userId);
    const same = stored && stored.plan === want.plan && stored.seats === want.seats && stored.validUntil?.getTime() === want.validUntil?.getTime();
    if (same) continue;
    const item: DriftItem = { stripeSubscriptionId: null, userId, kind: "entitlement_stale", action: "reported" };
    if (!tripped) {
      try {
        await db.transaction((tx) => recomputeEntitlement(tx, userId));
        item.action = "repaired";
      } catch (e) {
        item.action = "failed";
        item.error = e instanceof Error ? e.message : String(e);
      }
    }
    drift.push(item);
  }

  drift.sort((a, b) => a.kind.localeCompare(b.kind) || String(a.stripeSubscriptionId).localeCompare(String(b.stripeSubscriptionId)));
  const count = (a: DriftAction) => drift.filter((d) => d.action === a).length;
  return {
    runId: randomUUID(),
    trigger,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    complete,
    scanned: seen.size,
    counts: { inSync, repaired: count("repaired"), failed: count("failed"), skipped: count("skipped"), reported: count("reported") },
    circuitBreakerTripped: tripped,
    drift,
  };
}

export async function saveReport(db: Db, report: ReconcileReport): Promise<void> {
  await db.insert(reconcileRuns).values({
    id: report.runId,
    trigger: report.trigger,
    startedAt: new Date(report.startedAt),
    finishedAt: new Date(report.finishedAt),
    complete: report.complete,
    report,
  });
}

/** Only one reconcile at a time (manual vs nightly). Returns null if another run holds the lock. */
export async function withReconcileLock<T>(pool: Pool, fn: () => Promise<T>): Promise<T | null> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query("select pg_try_advisory_lock(hashtext('reconcile')) as ok");
    if (!rows[0].ok) return null;
    try {
      return await fn();
    } finally {
      await client.query("select pg_advisory_unlock(hashtext('reconcile'))");
    }
  } finally {
    client.release();
  }
}
