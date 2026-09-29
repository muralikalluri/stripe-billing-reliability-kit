import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PgBoss } from "pg-boss";
import { isAdmin } from "@/lib/admin";
import { retryFailedEvent } from "@/lib/retry-event";
import { EVENT_QUEUE, JOB_OPTIONS, txAdapter, type Enqueue } from "@/lib/queue";
import { fakeEvent, startDb } from "./helpers";

describe("isAdmin", () => {
  it("only allowlisted emails, case-insensitive", () => {
    expect(isAdmin("Boss@Example.com", "boss@example.com, other@example.com")).toBe(true);
    expect(isAdmin("user@example.com", "boss@example.com")).toBe(false);
  });
  it("nobody is admin when unset/empty or when there is no email", () => {
    expect(isAdmin("boss@example.com", undefined)).toBe(false);
    expect(isAdmin("boss@example.com", "")).toBe(false);
    expect(isAdmin("boss@example.com", " , ")).toBe(false);
    expect(isAdmin(null, "boss@example.com")).toBe(false);
  });
});

describe("retryFailedEvent", () => {
  let ctx: Awaited<ReturnType<typeof startDb>>;
  let boss: PgBoss;
  const enqueue: Enqueue = async (event, client) => {
    await boss.send(EVENT_QUEUE, { event }, { ...JOB_OPTIONS, singletonKey: event.id, db: txAdapter(client) });
  };
  const evt = fakeEvent("evt_f", "invoice.paid", { id: "in_1" });
  const stripe = { events: { retrieve: async () => evt } };
  const jobs = async () => Number((await ctx.pool.query(`select count(*) n from pgboss.job where name='${EVENT_QUEUE}'`)).rows[0].n);

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

  it("re-enqueues a failed event and resets its status", async () => {
    await ctx.pool.query("insert into webhook_events (event_id,type,status,error,attempts) values ('evt_f','invoice.paid','failed','boom',5)");
    expect(await retryFailedEvent(ctx.pool, stripe, enqueue, "evt_f")).toBe("requeued");
    const { rows } = await ctx.pool.query("select status,error from webhook_events where event_id='evt_f'");
    expect(rows[0]).toEqual({ status: "received", error: null });
    expect(await jobs()).toBe(1);
  });

  it("refuses non-failed events (no job created)", async () => {
    await ctx.pool.query("insert into webhook_events (event_id,type,status) values ('evt_f','invoice.paid','processed')");
    expect(await retryFailedEvent(ctx.pool, stripe, enqueue, "evt_f")).toBe("not_failed");
    expect(await jobs()).toBe(0);
  });
});
