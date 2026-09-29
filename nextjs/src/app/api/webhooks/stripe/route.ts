import { getPool } from "@/db/client";
import { env } from "@/lib/env";
import { enqueueEvent } from "@/lib/queue";
import { getStripe } from "@/lib/stripe";
import { ingestWebhook } from "@/lib/webhook/ingest";

// Stripe signatures need the exact raw bytes and Node crypto/pg: never Edge.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const rawBody = await req.text(); // raw body, unparsed
  const result = await ingestWebhook(rawBody, req.headers.get("stripe-signature"), {
    pool: getPool(),
    stripe: getStripe(),
    secret: env.webhookSecret,
    enqueue: enqueueEvent,
  });
  if (result.status === 200) return Response.json({ received: true, duplicate: result.duplicate });
  return Response.json({ error: result.reason }, { status: result.status });
}
