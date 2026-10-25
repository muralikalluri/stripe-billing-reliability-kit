// Read-only checks of a Stripe account's webhook setup. Only GET requests are ever sent (enforced below).
// Use a RESTRICTED key with read access to Webhook Endpoints, Events and Subscriptions, or a test-mode key.
const API = "https://api.stripe.com/v1";

export const REQUIRED_EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
];

export function keyKind(key) {
  if (/^rk_live_/.test(key)) return { mode: "live", restricted: true };
  if (/^rk_test_/.test(key)) return { mode: "test", restricted: true };
  if (/^sk_live_/.test(key)) return { mode: "live", restricted: false };
  if (/^sk_test_/.test(key)) return { mode: "test", restricted: false };
  return null;
}

function client(key, fetchImpl) {
  return async function get(path, params = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.append(k, String(v));
    const res = await fetchImpl(`${API}${path}${qs.size ? `?${qs}` : ""}`, {
      method: "GET", // never anything else
      headers: { Authorization: `Bearer ${key}` },
    });
    const body = await res.json();
    if (!res.ok) {
      const msg = body?.error?.message ?? `HTTP ${res.status}`;
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return body;
  };
}

async function listAll(get, path, params, max) {
  const out = [];
  let after;
  while (out.length < max) {
    const page = await get(path, { ...params, limit: Math.min(100, max - out.length), starting_after: after });
    out.push(...page.data);
    if (!page.has_more || page.data.length === 0) break;
    after = page.data[page.data.length - 1].id;
  }
  return out;
}

/**
 * @param {{ key: string, fetch?: typeof fetch, days?: number, now?: Date, maxEvents?: number }} opts
 */
export async function checkStripe({ key, fetch: fetchImpl = globalThis.fetch, days = 30, now = new Date(), maxEvents = 1000 }) {
  const kind = keyKind(key ?? "");
  if (!kind) throw new Error("STRIPE_API_KEY must be an sk_test_, rk_test_ or rk_live_ key (sk_live_ works but a restricted read-only key is recommended).");
  const get = client(key, fetchImpl);
  const findings = [];
  const add = (f) => findings.push(f);
  const notes = [];
  if (kind.mode === "live" && !kind.restricted) notes.push("You used a full live secret key. This tool only reads, but a restricted read-only key is safer to share.");

  // Endpoints
  const endpoints = await listAll(get, "/webhook_endpoints", {}, 100);
  const enabled = endpoints.filter((e) => e.status === "enabled");
  if (endpoints.length === 0) {
    const live = kind.mode === "live";
    add({ id: "S1", severity: live ? "high" : "medium", title: "No webhook endpoint is registered in this account (" + kind.mode + " mode)",
      why: live
        ? "Without an endpoint your app never hears about renewals, failed payments or cancellations."
        : "Expected if you only develop locally with `stripe listen` (it forwards events without registering an endpoint). A deployed staging app needs a registered endpoint, or it never hears about renewals, failed payments or cancellations.",
      fix: `Register your deployed webhook URL in Developers → Webhooks and subscribe it to: ${REQUIRED_EVENTS.join(", ")}.` });
  }
  for (const e of endpoints) {
    if (e.status !== "enabled") {
      add({ id: "S2", severity: "high", title: `Endpoint is disabled: ${e.url}`,
        why: "Stripe disables an endpoint after repeated delivery failures (or someone disabled it). No events reach it.",
        fix: "Fix the failing handler, then re-enable the endpoint and replay missed events." });
    }
    const evs = e.enabled_events ?? [];
    if (!evs.includes("*")) {
      const missing = REQUIRED_EVENTS.filter((t) => !evs.includes(t));
      if (missing.length) {
        add({ id: "S3", severity: missing.includes("customer.subscription.deleted") ? "high" : "medium",
          title: `Endpoint ${e.url} is not subscribed to: ${missing.join(", ")}`,
          why: "Events you don't subscribe to are never sent, so those state changes never reach your database.",
          fix: "Add the missing event types to the endpoint (Developers → Webhooks → endpoint → Update details)." });
      }
    }
    let host = "";
    try { host = new URL(e.url).hostname; } catch { /* malformed */ }
    if (kind.mode === "live" && (!e.url.startsWith("https://") || /^(localhost|127\.|0\.0\.0\.0)/.test(host) || /ngrok|trycloudflare|loca\.lt/.test(host))) {
      add({ id: "S4", severity: "medium", title: `Live endpoint uses a non-production URL: ${e.url}`,
        why: "Tunnels and plain-HTTP URLs break or change without notice; live events get lost.",
        fix: "Point live webhooks at a stable HTTPS URL on your production deployment." });
    }
  }
  const byUrl = new Map();
  for (const e of enabled) byUrl.set(e.url, (byUrl.get(e.url) ?? 0) + 1);
  for (const [url, n] of byUrl) if (n > 1) {
    add({ id: "S5", severity: "medium", title: `${n} enabled endpoints point at the same URL: ${url}`,
      why: "Every event is delivered once per endpoint, so your handler receives each event " + n + " times (signed with different secrets, so only one verifies).",
      fix: "Delete the duplicate endpoint, or make sure each one is intended." });
  }

  // Undelivered events
  const since = Math.floor(now.getTime() / 1000) - days * 86400;
  const failed = await listAll(get, "/events", { delivery_success: false, "created[gte]": since }, maxEvents);
  const failedByType = {};
  for (const ev of failed) failedByType[ev.type] = (failedByType[ev.type] ?? 0) + 1;
  const relevantFailed = failed.filter((ev) => REQUIRED_EVENTS.includes(ev.type) || ev.type.startsWith("customer.subscription.") || ev.type.startsWith("invoice."));
  if (relevantFailed.length) {
    const top = Object.entries(failedByType).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([t, n]) => `${t} ×${n}`).join(", ");
    add({ id: "S6", severity: relevantFailed.length >= 5 ? "high" : "medium",
      title: `${failed.length >= maxEvents ? `${maxEvents}+` : failed.length} events in the last ${days} days were not delivered successfully (${top})`,
      why: "Each undelivered billing event is a customer whose access may not match what they paid for, until your app catches up.",
      fix: "Check the endpoint's failed attempts in the Dashboard for the error, fix the handler, then reconcile subscriptions so nobody is left in the wrong state.",
      sample: relevantFailed.slice(0, 5).map((ev) => ({ id: ev.id, type: ev.type, created: new Date(ev.created * 1000).toISOString(), pending_webhooks: ev.pending_webhooks })) });
  }

  // API version drift between the account (from recent events) and pinned endpoints
  const recent = await get("/events", { limit: 1 });
  const accountVersion = recent.data[0]?.api_version ?? null;
  for (const e of enabled) {
    if (e.api_version && accountVersion && e.api_version !== accountVersion) {
      add({ id: "S7", severity: "low", title: `Endpoint ${e.url} is pinned to API version ${e.api_version}; recent events use ${accountVersion}`,
        why: "Payload shapes differ between versions (for example, newer versions moved invoice.subscription under invoice.parent). Code written for one shape silently reads null on the other.",
        fix: "Make sure your handler reads fields for the version this endpoint is pinned to, or re-create the endpoint on your current version after testing." });
    }
  }

  // Subscription health (counts only)
  const subStatus = {};
  let subsScanned = 0;
  try {
    const subs = await listAll(get, "/subscriptions", { status: "all" }, 1000);
    subsScanned = subs.length;
    for (const s of subs) subStatus[s.status] = (subStatus[s.status] ?? 0) + 1;
  } catch (e) {
    notes.push(`Subscriptions could not be read (${e.message}); give the key read access to Subscriptions for the counts.`);
  }
  if ((subStatus.past_due ?? 0) + (subStatus.unpaid ?? 0) > 0) {
    add({ id: "S8", severity: "low", title: `${subStatus.past_due ?? 0} past_due and ${subStatus.unpaid ?? 0} unpaid subscriptions`,
      why: "Normal in small numbers, but each one needs a clear access rule (grace period, then lock) and a dunning email.",
      fix: "Confirm your app's access rule for past_due/unpaid matches what you intend, and that customers are notified." });
  }

  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.id.localeCompare(b.id));
  return {
    mode: kind.mode,
    endpoints: endpoints.map((e) => ({ url: e.url, status: e.status, api_version: e.api_version, events: (e.enabled_events ?? []).length })),
    accountVersion,
    undelivered: { days, total: failed.length, byType: failedByType },
    subscriptions: { scanned: subsScanned, byStatus: subStatus },
    findings,
    notes,
  };
}
