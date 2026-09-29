import { PgBoss } from "pg-boss";
import type { PoolClient } from "pg";
import type Stripe from "stripe";

export const EVENT_QUEUE = "stripe-events";
export const RECONCILE_QUEUE = "reconcile";
// pg-boss does not re-export its BossDb type; this is the shape it needs.
type BossDb = { executeSql(text: string, values?: unknown[]): Promise<{ rows: any[] }> };

export const JOB_OPTIONS = { retryLimit: 5, retryDelay: 5, retryBackoff: true, expireInSeconds: 300 } as const;

/** Lets pg-boss run its INSERT on OUR transaction so row + job commit atomically. */
export function txAdapter(client: PoolClient): BossDb {
  return { executeSql: async (text, values) => ({ rows: (await client.query(text, values as unknown[])).rows }) };
}

const g = globalThis as unknown as { __boss?: Promise<PgBoss> };

export function getBoss(): Promise<PgBoss> {
  return (g.__boss ??= (async () => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    const boss = new PgBoss(url);
    await boss.start();
    await boss.createQueue(EVENT_QUEUE);
    await boss.createQueue(RECONCILE_QUEUE);
    return boss;
  })());
}

export type Enqueue = (event: Stripe.Event, client: PoolClient) => Promise<void>;

export const enqueueEvent: Enqueue = async (event, client) => {
  const boss = await getBoss();
  // Exactly-one-job comes from the webhook_events row and this job being written in the SAME transaction
  // (ingest only enqueues when its INSERT won). singletonKey is just a label for tracing.
  await boss.send(EVENT_QUEUE, { event }, { ...JOB_OPTIONS, singletonKey: event.id, db: txAdapter(client) });
};
