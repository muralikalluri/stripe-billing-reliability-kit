import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import Stripe from "stripe";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Verdict = "pass" | "fail" | "precondition_violated";
export interface Assertion { id: string; expected: string; actual: string; pass: boolean }

export class Recorder {
  assertions: Assertion[] = [];
  evidence: Record<string, unknown> = {};
  precondition?: string;
  check(id: string, expected: string, actual: unknown, pass: boolean) {
    this.assertions.push({ id, expected, actual: typeof actual === "string" ? actual : JSON.stringify(actual), pass });
    console.log(`  ${pass ? "PASS" : "FAIL"}  ${id}  (expected: ${expected}; actual: ${typeof actual === "string" ? actual : JSON.stringify(actual)})`);
  }
  get verdict(): Verdict {
    if (this.assertions.some((a) => !a.pass)) return "fail";
    return this.precondition ? "precondition_violated" : "pass";
  }
}

export interface Ctx {
  runId: string;
  target: string;
  stripe: Stripe;
  pool: pg.Pool;
  webhookUrl: string;
  secret: string;
  priceId: string;
  reconcileCmd: string;
  tracked: { eventIds: Set<string>; customerIds: Set<string>; clockIds: Set<string>; userIds: Set<string> };
  listener?: ChildProcess;
  listenerLog?: { text: string };
  startedAt: Date;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);

/** Safety first: TEST keys only, localhost DB only. Nothing here can touch live data. */
export function loadCtx(): Ctx {
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  if (!/^(sk|rk)_test_/.test(key) || /REPLACE_ME/.test(key)) throw new Error("STRIPE_SECRET_KEY must be a Stripe TEST key");
  const dbUrl = process.env.DATABASE_URL ?? "";
  const host = new URL(dbUrl || "postgres://none").hostname;
  if (!["localhost", "127.0.0.1", "::1"].includes(host)) throw new Error(`DATABASE_URL host must be local, got "${host}"`);
  const secret = process.env.STRIPE_WEBHOOK_SECRET ?? "";
  if (!secret.startsWith("whsec_") || /REPLACE_ME/.test(secret)) throw new Error("STRIPE_WEBHOOK_SECRET is not set");
  const priceId = process.env.STRIPE_PRICE_PRO_MONTHLY ?? "";
  if (!priceId.startsWith("price_") || /REPLACE_ME/.test(priceId)) throw new Error("STRIPE_PRICE_PRO_MONTHLY is not set (run npm run seed:stripe)");
  return {
    runId: Date.now().toString(36),
    target: process.env.CHAOS_TARGET ?? "nextjs",
    stripe: new Stripe(key),
    pool: new pg.Pool({ connectionString: dbUrl }),
    webhookUrl: process.env.WEBHOOK_URL ?? `http://localhost:${process.env.APP_PORT ?? "3100"}/api/webhooks/stripe`,
    secret,
    priceId,
    reconcileCmd: process.env.RECONCILE_CMD ?? "npm --prefix nextjs run --silent reconcile",
    tracked: { eventIds: new Set(), customerIds: new Set(), clockIds: new Set(), userIds: new Set() },
    startedAt: new Date(),
  };
}

export async function waitFor<T>(desc: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 60_000, everyMs = 1000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${desc}`);
    await sleep(everyMs);
  }
}

// ---------- fixtures ----------
export interface Fixture { userId: string; customerId: string; clockId?: string }

export async function createFixture(ctx: Ctx, scenario: string, opts: { testClock?: boolean; paymentMethod?: string } = {}): Promise<Fixture> {
  const userId = `chaos_${ctx.runId}_${scenario}`;
  const clock = opts.testClock ? await ctx.stripe.testHelpers.testClocks.create({ frozen_time: Math.floor(Date.now() / 1000), name: `chaos-${ctx.runId}-${scenario}` }) : undefined;
  if (clock) ctx.tracked.clockIds.add(clock.id);
  const customer = await ctx.stripe.customers.create({
    email: `${userId}@example.com`,
    name: `chaos-${ctx.runId}-${scenario}`,
    metadata: { user_id: userId, chaos_run: ctx.runId },
    ...(clock ? { test_clock: clock.id } : {}),
  });
  ctx.tracked.customerIds.add(customer.id);
  await ctx.pool.query("insert into users (id, email) values ($1, $2)", [userId, `${userId}@example.com`]);
  await ctx.pool.query("insert into customers (user_id, stripe_customer_id) values ($1, $2)", [userId, customer.id]);
  ctx.tracked.userIds.add(userId);
  await setPaymentMethod(ctx, customer.id, opts.paymentMethod ?? "pm_card_visa");
  return { userId, customerId: customer.id, clockId: clock?.id };
}

export async function setPaymentMethod(ctx: Ctx, customerId: string, pm: string) {
  const attached = await ctx.stripe.paymentMethods.attach(pm, { customer: customerId });
  await ctx.stripe.customers.update(customerId, { invoice_settings: { default_payment_method: attached.id } });
}

export async function createSubscription(ctx: Ctx, fx: Fixture) {
  return ctx.stripe.subscriptions.create({
    customer: fx.customerId,
    items: [{ price: ctx.priceId }],
    metadata: { user_id: fx.userId },
  });
}

export async function advanceClock(ctx: Ctx, clockId: string, toSec: number) {
  await ctx.stripe.testHelpers.testClocks.advance(clockId, { frozen_time: toSec });
  await waitFor("test clock ready", async () => (await ctx.stripe.testHelpers.testClocks.retrieve(clockId)).status === "ready", 120_000, 2000);
}

// ---------- events and delivery ----------
export async function findEvents(ctx: Ctx, opts: { sinceSec: number; types: string[]; subId: string; min: number; timeoutMs?: number }): Promise<Stripe.Event[]> {
  return waitFor(`${opts.min} event(s) ${opts.types.join(",")} for ${opts.subId}`, async () => {
    const list = await ctx.stripe.events.list({ types: opts.types, created: { gte: opts.sinceSec - 5 }, limit: 100 });
    const mine = list.data.filter((e) => (e.data.object as { id?: string }).id === opts.subId);
    if (mine.some((e) => e.livemode)) throw new Error("refusing: got a livemode event");
    return mine.length >= opts.min ? mine.sort((a, b) => a.created - b.created || a.id.localeCompare(b.id)) : null;
  }, opts.timeoutMs ?? 60_000, 2000);
}

export function sign(ctx: Ctx, body: string, secret = ctx.secret) {
  return ctx.stripe.webhooks.generateTestHeaderString({ payload: body, secret });
}

export interface Delivery { status: number; body: string }
/** Harness-signed replay of a real Stripe event (the only sender: the CLI listener is off in S1-S4). */
export async function deliver(ctx: Ctx, event: Stripe.Event, o: { body?: string; header?: string | null } = {}): Promise<Delivery> {
  const body = o.body ?? JSON.stringify(event);
  ctx.tracked.eventIds.add(event.id);
  const headers: Record<string, string> = { "content-type": "application/json" };
  const header = o.header === undefined ? sign(ctx, body) : o.header;
  if (header) headers["stripe-signature"] = header;
  const res = await fetch(ctx.webhookUrl, { method: "POST", headers, body });
  return { status: res.status, body: (await res.text()).slice(0, 200) };
}

export async function eventRow(ctx: Ctx, id: string) {
  return (await ctx.pool.query("select * from webhook_events where event_id=$1", [id])).rows[0] ?? null;
}
/** Settled = every given event is processed or failed (not received/processing). */
export async function waitSettled(ctx: Ctx, ids: string[], timeoutMs = 60_000) {
  return waitFor(`events settled ${ids.join(",")}`, async () => {
    const { rows } = await ctx.pool.query("select event_id, status from webhook_events where event_id = any($1)", [ids]);
    return rows.length === ids.length && rows.every((r) => r.status === "processed" || r.status === "failed") ? rows : null;
  }, timeoutMs, 500);
}
export async function waitAllIdle(ctx: Ctx, timeoutMs = 90_000) {
  await sleep(6000);
  await waitFor("no webhook events in flight", async () => {
    const { rows } = await ctx.pool.query("select count(*)::int n from webhook_events where status in ('received','processing')");
    return rows[0].n === 0;
  }, timeoutMs, 1000);
}

export async function subRow(ctx: Ctx, stripeSubId: string) {
  return (await ctx.pool.query("select * from subscriptions where stripe_subscription_id=$1", [stripeSubId])).rows[0] ?? null;
}
export async function entRow(ctx: Ctx, userId: string) {
  return (await ctx.pool.query("select * from entitlements where user_id=$1", [userId])).rows[0] ?? null;
}
export const count = async (ctx: Ctx, sql: string, args: unknown[] = []) => (await ctx.pool.query(sql, args)).rows[0].n as number;

// ---------- listener (stripe listen) ----------
// The seven event types the app handles (SPEC 3.4); CLI 1.5x requires an explicit list.
const HANDLED_EVENTS = "checkout.session.completed,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,customer.subscription.trial_will_end,invoice.paid,invoice.payment_failed";
export async function startListener(ctx: Ctx): Promise<void> {
  const proc = spawn("stripe", ["listen", "--events", HANDLED_EVENTS, "--forward-to", ctx.webhookUrl], {
    env: { ...process.env, STRIPE_API_KEY: process.env.STRIPE_SECRET_KEY }, // key via env, never argv
    stdio: ["ignore", "pipe", "pipe"],
  });
  ctx.listener = proc;
  let out = "";
  ctx.listenerLog = { text: "" };
  const collect = (d: Buffer) => { out += d.toString(); ctx.listenerLog!.text = out; };
  proc.stdout!.on("data", collect);
  proc.stderr!.on("data", collect);
  await waitFor("stripe listen ready", async () => (/Ready!/.test(out) ? out : null), 30_000, 300);
  const listen = /whsec_[A-Za-z0-9]+/.exec(out)?.[0];
  if (!listen || sha(listen) !== sha(ctx.secret)) {
    await stopListener(ctx);
    throw new Error("the listener's signing secret differs from STRIPE_WEBHOOK_SECRET (hash compare); refusing to run");
  }
}
export async function stopListener(ctx: Ctx) {
  if (!ctx.listener) return;
  const p = ctx.listener;
  ctx.listener = undefined;
  p.kill("SIGTERM");
  await sleep(1000);
}

// ---------- reconcile ----------
export interface ReconcileReport { counts: { inSync: number; repaired: number; failed: number; skipped: number; reported: number }; complete: boolean; drift: { stripeSubscriptionId: string | null; userId: string | null; kind: string; action: string; error?: string }[] }
export function runReconcile(ctx: Ctx): ReconcileReport {
  const path = resolve(ROOT, `chaos/results/.reconcile-${ctx.runId}.json`);
  execFileSync("/bin/sh", ["-c", ctx.reconcileCmd], { cwd: ROOT, env: { ...process.env, RECONCILE_REPORT_PATH: path }, stdio: ["ignore", "pipe", "inherit"] });
  const report = JSON.parse(readFileSync(path, "utf8")) as ReconcileReport;
  execFileSync("rm", ["-f", path]);
  return report;
}

// ---------- diagnostics (only on failure) ----------
/** What the system and Stripe looked like when a scenario failed: enough to tell "events never arrived" from "arrived, no effect". */
export async function dumpDiagnostics(ctx: Ctx, rec: Recorder) {
  const d: Record<string, unknown> = {};
  try {
    const users = [...ctx.tracked.userIds];
    d.webhook_events_since_start = (await ctx.pool.query(
      "select event_id, type, status, attempts, error, received_at, processed_at from webhook_events where received_at >= $1 order by received_at",
      [ctx.startedAt])).rows;
    d.subscriptions = (await ctx.pool.query(
      "select stripe_subscription_id, status, current_period_start, current_period_end, updated_from_event_created from subscriptions where user_id = any($1)", [users])).rows;
    d.entitlements = (await ctx.pool.query("select plan, valid_until from entitlements where user_id = any($1)", [users])).rows;
    d.stripe_subscriptions = [];
    for (const c of ctx.tracked.customerIds) {
      const subs = await ctx.stripe.subscriptions.list({ customer: c, status: "all" });
      for (const s of subs.data) {
        const invId = typeof s.latest_invoice === "string" ? s.latest_invoice : s.latest_invoice?.id;
        const inv = invId ? await ctx.stripe.invoices.retrieve(invId) : null;
        (d.stripe_subscriptions as unknown[]).push({
          id: s.id, status: s.status,
          latest_invoice: inv && { id: inv.id, status: inv.status, paid: inv.status === "paid", attempt_count: inv.attempt_count, auto_advance: inv.auto_advance, next_payment_attempt: inv.next_payment_attempt, created: inv.created },
        });
      }
    }
    d.test_clocks = [];
    for (const id of ctx.tracked.clockIds) {
      const c = await ctx.stripe.testHelpers.testClocks.retrieve(id);
      (d.test_clocks as unknown[]).push({ id, status: c.status, frozen_time: c.frozen_time });
    }
    d.listener_output_tail = (ctx.listenerLog?.text ?? "").replace(/whsec_[A-Za-z0-9]+/g, "[scrubbed]").split("\n").slice(-40);
  } catch (e) {
    d.diagnostics_error = e instanceof Error ? e.message : String(e);
  }
  rec.evidence.diagnostics_on_failure = d;
}

// ---------- cleanup ----------
export async function cleanup(ctx: Ctx) {
  await stopListener(ctx);
  const users = [...ctx.tracked.userIds];
  if (users.length) {
    await ctx.pool.query("delete from entitlements where user_id = any($1)", [users]);
    await ctx.pool.query("delete from subscriptions where user_id = any($1)", [users]);
    await ctx.pool.query("delete from customers where user_id = any($1)", [users]);
    await ctx.pool.query("delete from users where id = any($1)", [users]);
  }
  const ids = [...ctx.tracked.eventIds];
  if (ids.length) await ctx.pool.query("delete from webhook_events where event_id = any($1)", [ids]);
  // DB rows first, THEN Stripe objects, so reconcile never sees orphans mid-cleanup.
  for (const c of ctx.tracked.customerIds) await ctx.stripe.customers.del(c).catch(() => {});
  for (const c of ctx.tracked.clockIds) await ctx.stripe.testHelpers.testClocks.del(c).catch(() => {});
  await ctx.pool.end();
}

// ---------- results ----------
export function writeResult(ctx: Ctx, scenario: string, rec: Recorder, meta: { startedAt: string; deliveryMode: string; title: string }) {
  const gitSha = (() => {
    try { const h = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT }).toString().trim();
      const dirty = execFileSync("git", ["status", "--porcelain", "--", ":!chaos/results", ":!docs/chaos.md"], { cwd: ROOT }).toString().trim();
      return dirty ? `${h}+dirty` : h; } catch { return "unknown"; }
  })();
  const result = {
    schema_version: 1,
    run_id: ctx.runId,
    target: ctx.target,
    scenario,
    title: meta.title,
    git_sha: gitSha,
    started_at: meta.startedAt,
    finished_at: new Date().toISOString(),
    delivery_mode: meta.deliveryMode,
    verdict: rec.verdict,
    precondition_note: rec.precondition ?? null,
    assertions: rec.assertions,
    evidence: rec.evidence,
  };
  // Scrub anything key-shaped before it can reach a committed file.
  const text = JSON.stringify(result, null, 2).replace(/\b(sk|rk|pk)_(test|live)_[A-Za-z0-9]{8,}|whsec_[A-Za-z0-9]{8,}/g, "[scrubbed]");
  const dir = resolve(ROOT, "chaos/results", ctx.target);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, `${scenario}.json`), text + "\n");
  // Every run is appended, so pass rates in the docs come from data, not memory.
  appendFileSync(resolve(dir, "history.jsonl"), JSON.stringify({ scenario, run_id: ctx.runId, verdict: result.verdict, git_sha: gitSha, finished_at: result.finished_at }) + "\n");
  return result.verdict;
}
