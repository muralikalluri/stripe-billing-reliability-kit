#!/usr/bin/env node
// LIVE smoke check of the Next.js app's real HTTP routes against Stripe TEST mode.
// Needs the dev server running (`npm run dev` in nextjs/, DEMO_AUTH=1; the demo login is disabled in production builds).
//
//   set -a; . ./.env; set +a
//   (cd nextjs && APP_URL=http://localhost:3100 ADMIN_EMAILS=admin@example.com npx next dev -p 3100) &
//   BASE=http://localhost:3100 ADMIN_EMAIL=admin@example.com npm run flows:live
//
// Creates throwaway users (flow-check-*) and Stripe customers and deletes them afterwards.
// It does NOT pay: creating a Checkout session is checked here; paying on the hosted page is nextjs/e2e.
import pg from "pg";
import Stripe from "stripe";

const BASE = process.env.BASE ?? "http://localhost:3100";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL; // must be in the server's ADMIN_EMAILS to test the admin page
const key = process.env.STRIPE_SECRET_KEY ?? "";
if (!/^(sk|rk)_test_/.test(key) || key.includes("REPLACE_ME")) throw new Error("STRIPE_SECRET_KEY must be a Stripe TEST key (load .env first)");
const dbUrl = process.env.DATABASE_URL ?? "";
if (!["localhost", "127.0.0.1", "::1"].includes(new URL(dbUrl || "postgres://none").hostname)) throw new Error("DATABASE_URL must be a local database");

const stripe = new Stripe(key);
const pool = new pg.Pool({ connectionString: dbUrl });
const stamp = Date.now().toString(36);
const emails = [];

class Client {
  jar = new Map();
  async req(path, opts = {}) {
    const cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(BASE + path, { redirect: "manual", ...opts, headers: { ...(opts.headers ?? {}), cookie } });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [kv] = c.split(";");
      const i = kv.indexOf("=");
      this.jar.set(kv.slice(0, i), kv.slice(i + 1));
    }
    return res;
  }
  async login(email) {
    emails.push(email);
    const csrf = (await (await this.req("/api/auth/csrf")).json()).csrfToken;
    await this.req("/api/auth/callback/credentials", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrfToken: csrf, email, callbackUrl: BASE }),
    });
    return (await (await this.req("/api/auth/session")).json())?.user?.id;
  }
}

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const form = (o) => new URLSearchParams(o);

try {
  const anon = new Client();
  let r = await anon.req("/api/checkout", { method: "POST", body: form({ plan: "pro_monthly" }) });
  check("checkout requires login", r.status === 401, `status ${r.status}`);
  r = await anon.req("/api/me/entitlement");
  check("entitlement API requires login", r.status === 401, `status ${r.status}`);

  const user = new Client();
  const userId = await user.login(`flow-check-${stamp}@example.com`);
  check("demo login creates a session", !!userId);

  r = await user.req("/pricing");
  const html = await r.text();
  check("pricing page shows the plans with Subscribe buttons", r.status === 200 && /Pro monthly/.test(html) && /Subscribe/.test(html), `status ${r.status}`);

  for (const plan of ["pro_monthly", "pro_yearly", "team_seat"]) {
    r = await user.req("/api/checkout", { method: "POST", body: form({ plan }) });
    check(`checkout creates a real Stripe Checkout session for ${plan}`, r.status === 303 && /^https:\/\/checkout\.stripe\.com\//.test(r.headers.get("location") ?? ""), `status ${r.status}`);
  }
  r = await user.req("/api/checkout", { method: "POST", body: form({ plan: "price_1RawPriceIdFromClient" }) });
  check("checkout rejects a raw price id (server-side allowlist)", r.status === 400, `status ${r.status}`);

  r = await user.req("/checkout/success");
  check("success page renders and grants nothing by itself", r.status === 200 && /Confirming your payment/.test(await r.text()), `status ${r.status}`);
  r = await user.req("/api/me/entitlement");
  const ent = await r.json();
  check("no access before a webhook grants it (uncached)", ent.access === false && /no-store/.test(r.headers.get("cache-control") ?? ""), JSON.stringify(ent));
  r = await user.req("/account");
  check("account page shows the free plan", r.status === 200 && /free/.test(await r.text()), `status ${r.status}`);

  r = await user.req("/api/portal", { method: "POST" });
  check("customer portal session (303 to billing.stripe.com)", r.status === 303 && /billing\.stripe\.com/.test(r.headers.get("location") ?? ""), `status ${r.status}`);

  r = await user.req("/admin/events");
  check("admin page is 404 for a non-admin", r.status === 404, `status ${r.status}`);

  if (ADMIN_EMAIL) {
    const admin = new Client();
    await admin.login(ADMIN_EMAIL);
    r = await admin.req("/admin/events");
    const body = await r.text();
    check("admin sees the webhook events page", r.status === 200 && /Webhook events/.test(body), `status ${r.status} (ADMIN_EMAIL must be in the server's ADMIN_EMAILS)`);
    check("admin page has the reconcile control", /Run reconcile now/.test(body));
    r = await admin.req("/admin/events?status=failed");
    check("admin status filter works", r.status === 200);
  } else {
    console.log("SKIP  admin checks (set ADMIN_EMAIL to an address in the server's ADMIN_EMAILS)");
  }
} finally {
  // Cleanup: Stripe customers first, then our rows.
  for (const email of emails) {
    const row = (await pool.query("select u.id, c.stripe_customer_id from users u left join customers c on c.user_id = u.id where u.email = $1", [email])).rows[0];
    if (!row) continue;
    if (row.stripe_customer_id) await stripe.customers.del(row.stripe_customer_id).catch(() => {});
    for (const t of ["entitlements", "subscriptions", "customers"]) await pool.query(`delete from ${t} where user_id = $1`, [row.id]);
    await pool.query("delete from users where id = $1", [row.id]);
  }
  await pool.end();
}
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
