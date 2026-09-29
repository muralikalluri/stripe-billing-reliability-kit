import type { Pool } from "pg";
import type Stripe from "stripe";
import type { Enqueue } from "./queue";

/**
 * Re-enqueue a FAILED event: refetch the payload from Stripe (webhook_events stores no payload),
 * reset the row to `received`, and enqueue, all in one transaction. Only `failed` rows can be retried.
 */
export async function retryFailedEvent(
  pool: Pool,
  stripe: { events: { retrieve(id: string): Promise<Stripe.Event> } },
  enqueue: Enqueue,
  eventId: string,
): Promise<"requeued" | "not_failed"> {
  const event = await stripe.events.retrieve(eventId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const res = await client.query("UPDATE webhook_events SET status='received', error=NULL WHERE event_id=$1 AND status='failed' RETURNING event_id", [eventId]);
    if (res.rowCount !== 1) {
      await client.query("ROLLBACK");
      return "not_failed";
    }
    await enqueue(event, client);
    await client.query("COMMIT");
    return "requeued";
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
