// Test helpers: a throwaway Postgres database with the migration applied, a pg-backed BillingDb
// (same SQL functions the supabase-js implementation calls), and a fake Stripe.
import pg from "npm:pg@8";
import type Stripe from "npm:stripe@18";
import { applyParams, type BillingDb } from "../_shared/db.ts";

const here = new URL(".", import.meta.url);
export const ADMIN_URL = Deno.env.get("TEST_DATABASE_URL"); // e.g. postgres://postgres@127.0.0.1:55432/postgres

/** Fresh database per test file: stub (only if no Supabase auth schema) + migration. */
export async function freshDb(opts: { migrate?: boolean } = {}): Promise<{ pool: pg.Pool; drop: () => Promise<void> }> {
  if (!ADMIN_URL) throw new Error("TEST_DATABASE_URL not set");
  const name = `billing_test_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 8 });
  const stub = await Deno.readTextFile(new URL("../../tests/supabase-stub.sql", here));
  const migration = await Deno.readTextFile(new URL("../../migrations/20261025000000_billing.sql", here));
  if (opts.migrate !== false) {
    await pool.query(stub);
    await pool.query(migration);
  }
  return {
    pool,
    drop: async () => {
      await pool.end();
      const a = new pg.Client({ connectionString: ADMIN_URL });
      await a.connect();
      await a.query(`drop database if exists ${name} with (force)`);
      await a.end();
    },
  };
}

export function pgDb(pool: pg.Pool): BillingDb {
  const one = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;
  return {
    ingest: async (id, type, payload) => (await one("select public.ingest_stripe_event($1,$2,$3) as ok", [id, type, payload]))[0].ok,
    claimJobs: async (limit, lease) => await one("select * from public.claim_event_jobs($1,$2)", [limit, lease]),
    completeJob: async (id) => { await one("select public.complete_event_job($1)", [id]); },
    failJob: async (id, err) => { await one("select public.fail_event_job($1,$2)", [id, err]); },
    applySubscription: async (a) => {
      const p = applyParams(a);
      return (await one("select public.apply_subscription($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) as r", [
        p.p_stripe_subscription_id, p.p_stripe_customer_id, p.p_metadata_user_id, p.p_status, p.p_price_id, p.p_quantity,
        p.p_period_start, p.p_period_end, p.p_cancel_at_period_end, p.p_version, p.p_fetched_at, JSON.stringify(p.p_price_plans),
      ]))[0].r;
    },
    now: async () => (await one("select public.billing_now() as n"))[0].n,
    subscriptions: async () => await one("select user_id, stripe_subscription_id, status, price_id, quantity, current_period_start, current_period_end, cancel_at_period_end from public.subscriptions"),
    customers: async () => await one("select user_id, stripe_customer_id from public.customers"),
    entitlement: async (u) => (await one("select plan, seats, valid_until from public.entitlements where user_id = $1", [u]))[0] ?? null,
    computeEntitlement: async (u, plans) => (await one("select * from public.compute_entitlement($1,$2)", [u, JSON.stringify(plans)]))[0],
    recomputeEntitlement: async (u, plans) => { await one("select public.recompute_entitlement($1,$2)", [u, JSON.stringify(plans)]); },
    acquireLease: async (n, s) => (await one("select public.acquire_lease($1,$2) as ok", [n, s]))[0].ok,
    releaseLease: async (n) => { await one("select public.release_lease($1)", [n]); },
    saveReconcileRun: async (r) => {
      await one("insert into public.reconcile_runs (id, trigger, started_at, finished_at, complete, report) values ($1,$2,$3,$4,$5,$6)",
        [r.runId, r.trigger, r.startedAt, r.finishedAt, r.complete, JSON.stringify(r.report)]);
    },
  };
}

export const PRICE_PRO = "price_pro_monthly";
export const PRICE_TEAM = "price_team_seat";
export const PLANS = { [PRICE_PRO]: "pro", [PRICE_TEAM]: "team" };
export const DAY = 86_400;

export function fakeSub(o: { id: string; customer: string; status: string; price?: string; start: number; end: number; quantity?: number; cancel?: boolean; userId?: string }): Stripe.Subscription {
  return {
    id: o.id, object: "subscription", customer: o.customer, status: o.status,
    cancel_at_period_end: o.cancel ?? false, cancel_at: null, metadata: o.userId ? { user_id: o.userId } : {},
    items: { object: "list", data: [{ id: `si_${o.id}`, price: { id: o.price ?? PRICE_PRO }, quantity: o.quantity ?? 1, current_period_start: o.start, current_period_end: o.end }] },
  } as unknown as Stripe.Subscription;
}

/** In-memory Stripe: `subs` is what the API currently returns. */
export function fakeStripe(subs: Map<string, Stripe.Subscription>) {
  const calls = { retrieve: 0, list: 0 };
  return {
    calls,
    subscriptions: {
      async retrieve(id: string) {
        calls.retrieve++;
        const s = subs.get(id);
        if (!s) throw Object.assign(new Error(`No such subscription: '${id}'`), { code: "resource_missing", statusCode: 404 });
        return structuredClone(s);
      },
      async list(params: { customer?: string; starting_after?: string; limit: number }) {
        calls.list++;
        const all = [...subs.values()].filter((s) => !params.customer || s.customer === params.customer);
        return { data: all.map((s) => structuredClone(s)), has_more: false };
      },
    },
  };
}

export function event(id: string, type: string, created: number, object: Record<string, unknown>) {
  return { id, object: "event", type, created, api_version: "2025-03-31.basil", data: { object } };
}

export async function addUser(pool: pg.Pool, userId: string, customerId: string) {
  await pool.query("insert into public.users (id, email) values ($1, $2)", [userId, `${userId}@example.com`]);
  await pool.query("insert into public.customers (user_id, stripe_customer_id) values ($1, $2)", [userId, customerId]);
}
