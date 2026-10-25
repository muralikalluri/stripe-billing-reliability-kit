// Reconcile: list subscriptions from Stripe, find drift, repair ONLY through apply_subscription.
// Port of nextjs/src/reconcile/reconcile.ts; same report shape (the chaos harness reads it).
import type Stripe from "npm:stripe@18";
import { idOf, subscriptionFields } from "./billing.ts";
import type { BillingDb, SubscriptionRow } from "./db.ts";
import { syncSubscription } from "./worker.ts";

export interface ReconcileStripe {
  subscriptions: {
    retrieve(id: string): Promise<Stripe.Subscription>;
    list(params: { status: "all"; limit: number; starting_after?: string; customer?: string }): Promise<{ data: Stripe.Subscription[]; has_more: boolean }>;
  };
}
export type DriftKind = "missing_in_db" | "field_mismatch" | "entitlement_stale" | "orphan";
export type DriftAction = "repaired" | "failed" | "skipped" | "reported";
export interface DriftItem { stripeSubscriptionId: string | null; userId: string | null; kind: DriftKind; fields?: string[]; action: DriftAction; error?: string }
export interface ReconcileReport {
  runId: string;
  trigger: string;
  startedAt: string;
  finishedAt: string;
  complete: boolean;
  scanned: number;
  counts: { inSync: number; repaired: number; failed: number; skipped: number; reported: number };
  circuitBreakerTripped: boolean;
  drift: DriftItem[];
}

const t = (v: string | Date | null) => (v == null ? null : new Date(v).getTime());

function diffFields(row: SubscriptionRow, sub: Stripe.Subscription): string[] {
  const f = subscriptionFields(sub);
  const pairs: [string, unknown, unknown][] = [
    ["status", row.status, f.status],
    ["priceId", row.price_id, f.priceId],
    ["quantity", row.quantity, f.quantity],
    ["currentPeriodStart", t(row.current_period_start), t(f.currentPeriodStart)],
    ["currentPeriodEnd", t(row.current_period_end), t(f.currentPeriodEnd)],
    ["cancelAtPeriodEnd", row.cancel_at_period_end, f.cancelAtPeriodEnd],
  ];
  return pairs.filter(([, a, b]) => a !== b).map(([k]) => k);
}

async function withRetry<T>(fn: () => Promise<T>, retries: number, delayMs: number): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      const retryable = status === 429 || (status !== undefined && status >= 500);
      if (!retryable || attempt >= retries) throw e;
      await new Promise((r) => setTimeout(r, delayMs * 2 ** attempt));
    }
  }
}

export async function reconcile(
  db: BillingDb, stripe: ReconcileStripe, pricePlans: Record<string, string>,
  opts: { trigger?: string; pageSize?: number; breaker?: { ratio: number; min: number }; retries?: number; retryDelayMs?: number } = {},
): Promise<ReconcileReport> {
  const { trigger = "manual", pageSize = 100, breaker = { ratio: 0.5, min: 20 }, retries = 3, retryDelayMs = 500 } = opts;
  const startedAt = new Date();
  const drift: DriftItem[] = [];
  let complete = true;

  const dbRows = await db.subscriptions();
  const byStripeId = new Map(dbRows.map((r) => [r.stripe_subscription_id, r]));
  const dbCustomers = await db.customers();

  // 1. What Stripe has: the global listing plus a per-customer listing for every known customer
  //    (Stripe omits test-clock subscriptions from the global listing unless filtered by customer).
  const seen = new Map<string, Stripe.Subscription>();
  const collect = async (customer?: string) => {
    let after: string | undefined;
    try {
      for (;;) {
        const page = await withRetry(
          () => stripe.subscriptions.list({ status: "all", limit: pageSize, ...(after ? { starting_after: after } : {}), ...(customer ? { customer } : {}) }),
          retries, retryDelayMs,
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
  for (const c of dbCustomers) await collect(c.stripe_customer_id);

  // 2. Classify.
  const work: { sub: Stripe.Subscription; kind: DriftKind; fields?: string[] }[] = [];
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

  // 3. Repair unless the circuit breaker trips (wrong account / wrong mode guard).
  const tripped = work.length >= breaker.min && seen.size > 0 && work.length / seen.size > breaker.ratio;
  const userOf = (sub: Stripe.Subscription) => {
    const cid = idOf(sub.customer as string | { id: string });
    return dbCustomers.find((c) => c.stripe_customer_id === cid)?.user_id ?? sub.metadata?.user_id ?? null;
  };
  const repair = async (id: string, item: DriftItem) => {
    try {
      // DB clock before the re-fetch: if a webhook writes the row after this, the snapshot is not applied.
      const fetchedAt = await db.now();
      const r = await syncSubscription(db, stripe, id, null, pricePlans, fetchedAt);
      if (r === "applied") item.action = "repaired";
      else { item.action = "skipped"; item.error = "updated_concurrently"; }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const unmapped = /no user for stripe customer/.test(msg);
      item.action = unmapped ? "skipped" : "failed";
      item.error = unmapped ? "unmapped_customer" : msg;
    }
  };
  for (const w of work) {
    const item: DriftItem = { stripeSubscriptionId: w.sub.id, userId: userOf(w.sub), kind: w.kind, fields: w.fields, action: "reported" };
    if (!tripped) await repair(w.sub.id, item);
    drift.push(item);
  }

  // 4. Orphans: DB rows the listing never returned. Only after a COMPLETE listing; confirm by retrieve. Never auto-revoked.
  if (complete) {
    for (const row of dbRows) {
      if (seen.has(row.stripe_subscription_id)) continue;
      try {
        const sub = await withRetry(() => stripe.subscriptions.retrieve(row.stripe_subscription_id), retries, retryDelayMs);
        const fields = diffFields(row, sub);
        if (!fields.length) { inSync++; continue; }
        const item: DriftItem = { stripeSubscriptionId: sub.id, userId: row.user_id, kind: "field_mismatch", fields, action: "reported" };
        if (!tripped) await repair(sub.id, item);
        drift.push(item);
      } catch (e) {
        const missing = (e as { code?: string }).code === "resource_missing";
        drift.push({ stripeSubscriptionId: row.stripe_subscription_id, userId: row.user_id, kind: "orphan", action: missing ? "reported" : "failed", ...(missing ? {} : { error: e instanceof Error ? e.message : String(e) }) });
      }
    }
  }

  // 5. Entitlement drift: stored vs what the subscription rows imply (after repairs).
  const userIds = new Set((await db.subscriptions()).map((r) => r.user_id));
  for (const userId of userIds) {
    const stored = await db.entitlement(userId);
    const want = await db.computeEntitlement(userId, pricePlans);
    const same = stored && stored.plan === want.plan && stored.seats === want.seats && t(stored.valid_until) === t(want.valid_until);
    if (same) continue;
    const item: DriftItem = { stripeSubscriptionId: null, userId, kind: "entitlement_stale", action: "reported" };
    if (!tripped) {
      try { await db.recomputeEntitlement(userId, pricePlans); item.action = "repaired"; }
      catch (e) { item.action = "failed"; item.error = e instanceof Error ? e.message : String(e); }
    }
    drift.push(item);
  }

  drift.sort((a, b) => a.kind.localeCompare(b.kind) || String(a.stripeSubscriptionId).localeCompare(String(b.stripeSubscriptionId)));
  const count = (a: DriftAction) => drift.filter((d) => d.action === a).length;
  return {
    runId: crypto.randomUUID(),
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
