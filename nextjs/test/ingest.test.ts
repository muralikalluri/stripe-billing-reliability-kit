import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PgBoss } from "pg-boss";
import { ingestWebhook } from "@/lib/webhook/ingest";
import { EVENT_QUEUE, JOB_OPTIONS, txAdapter, type Enqueue } from "@/lib/queue";
import { getEntitlement } from "@/lib/entitlements/access";
import { processEvent } from "@/worker/process-event";
import { fakeEvent, fakeSubscription, seedUser, signed, startDb, stripeOffline, WEBHOOK_SECRET } from "./helpers";

let ctx: Awaited<ReturnType<typeof startDb>>;
let boss: PgBoss;

// Real pg-boss enqueue, on the caller's transaction (same shape as production enqueueEvent).
const realEnqueue: Enqueue = async (event, client) => {
  await boss.send(EVENT_QUEUE, { event }, { ...JOB_OPTIONS, singletonKey: event.id, db: txAdapter(client) });
};

const count = async (sql: string) => Number((await ctx.pool.query(sql)).rows[0].n);
const events = () => count("select count(*) n from webhook_events");
const jobs = () => count(`select count(*) n from pgboss.job where name='${EVENT_QUEUE}'`);

beforeAll(async () => {
  ctx = await startDb();
  boss = new PgBoss(ctx.url);
  await boss.start();
  await boss.createQueue(EVENT_QUEUE);
});
afterAll(async () => {
  await boss.stop({ graceful: false });
  await ctx.stop();
});
beforeEach(async () => {
  await ctx.pool.query("truncate webhook_events");
  await ctx.pool.query(`delete from pgboss.job where name='${EVENT_QUEUE}'`);
});

const deps = (enqueue: Enqueue) => ({ pool: ctx.pool, stripe: stripeOffline, secret: WEBHOOK_SECRET, enqueue });
const evt = fakeEvent("evt_1", "customer.subscription.created", { id: "sub_1" });

describe("webhook ingest", () => {
  it("rejects a tampered payload with 400 and processes nothing", async () => {
    const { body, header } = signed(evt);
    const enqueue = vi.fn(realEnqueue);
    const res = await ingestWebhook(body.replace("sub_1", "sub_EVIL"), header, deps(enqueue));
    expect(res.status).toBe(400);
    expect(enqueue).not.toHaveBeenCalled();
    expect(await events()).toBe(0);
    expect(await jobs()).toBe(0);
  });

  it("rejects a wrong-secret signature and a missing signature", async () => {
    const bad = signed(evt, "whsec_someone_else");
    expect((await ingestWebhook(bad.body, bad.header, deps(realEnqueue))).status).toBe(400);
    expect((await ingestWebhook(bad.body, null, deps(realEnqueue))).status).toBe(400);
    expect(await events()).toBe(0);
  });

  it("accepts a valid event: one row, one job", async () => {
    const { body, header } = signed(evt);
    const res = await ingestWebhook(body, header, deps(realEnqueue));
    expect(res).toMatchObject({ status: 200, duplicate: false });
    expect(await events()).toBe(1);
    expect(await jobs()).toBe(1);
  });

  it("is idempotent on event_id: same event twice -> one row, one job, 200 both times", async () => {
    const { body, header } = signed(evt);
    const first = await ingestWebhook(body, header, deps(realEnqueue));
    const second = await ingestWebhook(body, header, deps(realEnqueue));
    expect(first).toMatchObject({ status: 200, duplicate: false });
    expect(second).toMatchObject({ status: 200, duplicate: true });
    expect(await events()).toBe(1);
    expect(await jobs()).toBe(1);
  });

  it("concurrent duplicate deliveries still yield one row and one job", async () => {
    const { body, header } = signed(evt);
    const results = await Promise.all(Array.from({ length: 5 }, () => ingestWebhook(body, header, deps(realEnqueue))));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await events()).toBe(1);
    expect(await jobs()).toBe(1);
  });

  it("enqueue failure rolls back the row and returns 500, so Stripe's retry starts clean", async () => {
    const { body, header } = signed(evt);
    const boom: Enqueue = async () => {
      throw new Error("queue down");
    };
    const res = await ingestWebhook(body, header, deps(boom));
    expect(res.status).toBe(500);
    expect(await events()).toBe(0);
    const retry = await ingestWebhook(body, header, deps(realEnqueue));
    expect(retry).toMatchObject({ status: 200, duplicate: false });
    expect(await jobs()).toBe(1);
  });

  it("end to end: signed checkout event -> ingest -> queued job -> processEvent -> entitlement", async () => {
    process.env.STRIPE_PRICE_PRO_MONTHLY = "price_pro_m";
    await ctx.pool.query("truncate entitlements, subscriptions, customers, users cascade");
    await seedUser(ctx.db, "u1", "cus_test_1");
    const checkout = fakeEvent("evt_e2e", "checkout.session.completed", { id: "cs_1", subscription: "sub_test_1" });
    const { body, header } = signed(checkout);
    expect((await ingestWebhook(body, header, deps(realEnqueue))).status).toBe(200);
    expect(await getEntitlement(ctx.db, "u1")).toBeNull(); // nothing granted before the worker runs

    const [job] = await boss.fetch<{ event: typeof checkout }>(EVENT_QUEUE);
    expect(job).toBeDefined();
    await processEvent(ctx.db, { subscriptions: { retrieve: async () => fakeSubscription() } }, job.data.event);
    expect((await getEntitlement(ctx.db, "u1"))?.plan).toBe("pro");
  });
});
