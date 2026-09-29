import type { Pool } from "pg";
import type Stripe from "stripe";
import type { Enqueue } from "../queue";

export type IngestResult =
  | { status: 200; duplicate: boolean; eventId: string }
  | { status: 400; reason: string }
  | { status: 500; reason: string };

interface Deps {
  pool: Pool;
  stripe: Pick<Stripe, "webhooks">;
  secret: string;
  enqueue: Enqueue;
}

/**
 * 1. verify signature over the RAW body (before any parsing) -> 400 if bad
 * 2. in ONE transaction: insert webhook_events (idempotent on event_id) + enqueue job
 * 3. 200. A conflict means the event was already accepted (row + job are atomic).
 * If enqueue fails the transaction rolls back and we return 500 so Stripe retries.
 */
export async function ingestWebhook(rawBody: string, signature: string | null, deps: Deps): Promise<IngestResult> {
  if (!signature) return { status: 400, reason: "missing signature" };

  let event: Stripe.Event;
  try {
    event = deps.stripe.webhooks.constructEvent(rawBody, signature, deps.secret);
  } catch {
    return { status: 400, reason: "invalid signature" };
  }

  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");
    const res = await client.query(
      "INSERT INTO webhook_events (event_id, type) VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING RETURNING event_id",
      [event.id, event.type],
    );
    const inserted = res.rowCount === 1;
    if (inserted) await deps.enqueue(event, client);
    await client.query("COMMIT");
    return { status: 200, duplicate: !inserted, eventId: event.id };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    return { status: 500, reason: e instanceof Error ? e.message : "enqueue failed" };
  } finally {
    client.release();
  }
}
