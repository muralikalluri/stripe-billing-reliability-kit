// POST /functions/v1/stripe-webhook  (deploy with verify_jwt = false: the Stripe signature is the authentication)
import Stripe from "npm:stripe@18";
import { handleWebhook } from "../_shared/webhook.ts";
import { processPending } from "../_shared/worker.ts";
import { db, env, pricePlans, stripeClient } from "../_shared/runtime.ts";

const stripe = stripeClient();
const billing = db();
const secret = env("STRIPE_WEBHOOK_SECRET");
const crypto = Stripe.createSubtleCryptoProvider(); // async verification: Deno has no Node crypto

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

Deno.serve((req) =>
  handleWebhook(req, {
    db: billing,
    verify: (raw, sig) => stripe.webhooks.constructEventAsync(raw, sig, secret, undefined, crypto),
    // Process right after responding; the scheduled worker is the safety net for anything left over.
    afterAccept: () => {
      const work = processPending(billing, stripe, pricePlans(), { budgetMs: 10_000 }).catch((e) => console.error("worker:", e));
      if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(work);
    },
  })
);
