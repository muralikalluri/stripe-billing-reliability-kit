// Production wiring: env, clients, and the service-role check for the worker/reconcile endpoints.
import Stripe from "npm:stripe@18";
import { createClient } from "npm:@supabase/supabase-js@2";
import { pricePlansFromEnv } from "./billing.ts";
import { supabaseDb } from "./db.ts";

export function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export function stripeClient(): Stripe {
  const key = env("STRIPE_SECRET_KEY");
  if (/^sk_live_/.test(key) && Deno.env.get("ALLOW_LIVE_STRIPE") !== "1") {
    throw new Error("live Stripe key refused: set ALLOW_LIVE_STRIPE=1 only after testing in test mode");
  }
  return new Stripe(key, { httpClient: Stripe.createFetchHttpClient() });
}

export function db() {
  // SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected into every Edge Function by Supabase.
  const sb = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
  return supabaseDb(sb);
}

export const pricePlans = () => pricePlansFromEnv((k) => Deno.env.get(k));

function timingSafeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/**
 * Worker and reconcile are callable only with the service-role key (pg_cron, the chaos target, an admin).
 * These functions are deployed with verify_jwt = false, so the check is done here and works for both the
 * legacy JWT service_role key and the newer sb_secret_ keys.
 */
export function isServiceCaller(req: Request, serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""): boolean {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  return token.length > 0 && serviceKey.length > 0 && timingSafeEqual(token, serviceKey);
}
