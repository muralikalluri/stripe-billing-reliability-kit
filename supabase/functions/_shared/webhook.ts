// The webhook endpoint: verify the signature over the RAW body, then insert + enqueue atomically, then 200.
// Nothing slow happens here; the worker does the Stripe API calls.
import type Stripe from "npm:stripe@18";
import type { BillingDb } from "./db.ts";

export interface WebhookDeps {
  db: BillingDb;
  verify: (rawBody: string, signature: string) => Promise<Stripe.Event>;
  /** Kick the worker after the response (EdgeRuntime.waitUntil in production). */
  afterAccept?: () => void;
}

export async function handleWebhook(req: Request, deps: WebhookDeps): Promise<Response> {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const signature = req.headers.get("stripe-signature");
  if (!signature) return new Response("missing signature", { status: 400 });
  const raw = await req.text(); // raw body, never parsed before verification

  let event: Stripe.Event;
  try {
    event = await deps.verify(raw, signature);
  } catch {
    return new Response("invalid signature", { status: 400 });
  }

  let inserted: boolean;
  try {
    inserted = await deps.db.ingest(event.id, event.type, event);
  } catch {
    // The insert and the enqueue are one SQL statement-set: nothing was written, so Stripe's retry is safe.
    return new Response("enqueue failed", { status: 500 });
  }
  if (inserted) deps.afterAccept?.();
  return Response.json({ received: true, duplicate: !inserted });
}
