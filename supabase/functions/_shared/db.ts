// Every database call the functions make, behind one interface. Production uses supabase-js (service role);
// the integration tests use the same SQL functions over a plain Postgres connection (tests/pg-db.ts).
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { SubscriptionFields } from "./billing.ts";

export interface Job { event_id: string; payload: { id: string; type: string; created: number; data: { object: unknown } } }
export interface SubscriptionRow {
  user_id: string;
  stripe_subscription_id: string;
  status: string;
  price_id: string;
  quantity: number;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
}
export interface EntitlementRow { plan: string; seats: number; valid_until: string | null }

export interface ApplyArgs {
  stripeSubscriptionId: string;
  stripeCustomerId: string;
  metadataUserId: string | null;
  fields: SubscriptionFields;
  version: number | null;
  fetchedAt: Date | null;
  pricePlans: Record<string, string>;
}

export interface BillingDb {
  ingest(id: string, type: string, payload: unknown): Promise<boolean>;
  claimJobs(limit: number, leaseSeconds: number): Promise<Job[]>;
  completeJob(eventId: string): Promise<void>;
  failJob(eventId: string, error: string): Promise<void>;
  applySubscription(a: ApplyArgs): Promise<"applied" | "stale">;
  now(): Promise<Date>;
  subscriptions(): Promise<SubscriptionRow[]>;
  customers(): Promise<{ user_id: string; stripe_customer_id: string }[]>;
  entitlement(userId: string): Promise<EntitlementRow | null>;
  computeEntitlement(userId: string, pricePlans: Record<string, string>): Promise<EntitlementRow>;
  recomputeEntitlement(userId: string, pricePlans: Record<string, string>): Promise<void>;
  acquireLease(name: string, seconds: number): Promise<boolean>;
  releaseLease(name: string): Promise<void>;
  saveReconcileRun(r: { runId: string; trigger: string; startedAt: string; finishedAt: string; complete: boolean; report: unknown }): Promise<void>;
}

export const applyParams = (a: ApplyArgs) => ({
  p_stripe_subscription_id: a.stripeSubscriptionId,
  p_stripe_customer_id: a.stripeCustomerId,
  p_metadata_user_id: a.metadataUserId,
  p_status: a.fields.status,
  p_price_id: a.fields.priceId,
  p_quantity: a.fields.quantity,
  p_period_start: a.fields.currentPeriodStart?.toISOString() ?? null,
  p_period_end: a.fields.currentPeriodEnd?.toISOString() ?? null,
  p_cancel_at_period_end: a.fields.cancelAtPeriodEnd,
  p_version: a.version,
  p_fetched_at: a.fetchedAt?.toISOString() ?? null,
  p_price_plans: a.pricePlans,
});

function must<T>(r: { data: T; error: { message: string } | null }): T {
  if (r.error) throw new Error(r.error.message);
  return r.data;
}

/** supabase-js implementation. The client MUST use the service role key (server-side only). */
export function supabaseDb(sb: SupabaseClient): BillingDb {
  return {
    ingest: async (id, type, payload) => must(await sb.rpc("ingest_stripe_event", { p_id: id, p_type: type, p_payload: payload })) as boolean,
    claimJobs: async (limit, lease) => must(await sb.rpc("claim_event_jobs", { p_limit: limit, p_lease_seconds: lease })) as Job[],
    completeJob: async (id) => { must(await sb.rpc("complete_event_job", { p_event_id: id })); },
    failJob: async (id, error) => { must(await sb.rpc("fail_event_job", { p_event_id: id, p_error: error })); },
    applySubscription: async (a) => must(await sb.rpc("apply_subscription", applyParams(a))) as "applied" | "stale",
    now: async () => new Date(must(await sb.rpc("billing_now")) as string),
    subscriptions: async () => must(await sb.from("subscriptions").select("user_id, stripe_subscription_id, status, price_id, quantity, current_period_start, current_period_end, cancel_at_period_end")) as SubscriptionRow[],
    customers: async () => must(await sb.from("customers").select("user_id, stripe_customer_id")) as { user_id: string; stripe_customer_id: string }[],
    entitlement: async (userId) => (must(await sb.from("entitlements").select("plan, seats, valid_until").eq("user_id", userId).maybeSingle()) as EntitlementRow | null),
    computeEntitlement: async (userId, plans) => (must(await sb.rpc("compute_entitlement", { p_user_id: userId, p_price_plans: plans })) as EntitlementRow[])[0],
    recomputeEntitlement: async (userId, plans) => { must(await sb.rpc("recompute_entitlement", { p_user_id: userId, p_price_plans: plans })); },
    acquireLease: async (name, seconds) => must(await sb.rpc("acquire_lease", { p_name: name, p_seconds: seconds })) as boolean,
    releaseLease: async (name) => { must(await sb.rpc("release_lease", { p_name: name })); },
    saveReconcileRun: async (r) => {
      must(await sb.from("reconcile_runs").insert({ id: r.runId, trigger: r.trigger, started_at: r.startedAt, finished_at: r.finishedAt, complete: r.complete, report: r.report }));
    },
  };
}
