// Deliberately broken example for the health check. Do not deploy.
import Stripe from "stripe";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "edge";
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export async function POST(req: Request) {
  const body = await req.json();
  const sig = req.headers.get("stripe-signature")!;
  const event = stripe.webhooks.constructEvent(JSON.stringify(body), sig, process.env.STRIPE_WEBHOOK_SECRET!);

  if (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated") {
    const sub = event.data.object as Stripe.Subscription;
    await supabaseAdmin.from("profiles").update({ subscription_status: event.data.object.status }).eq("stripe_customer_id", sub.customer);
  }
  if (event.type === "customer.subscription.deleted") {
    await supabaseAdmin.from("profiles").update({ subscription_status: "canceled" }).eq("stripe_customer_id", (event.data.object as Stripe.Subscription).customer);
  }
  return new Response("ok");
}
