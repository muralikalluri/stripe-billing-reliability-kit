// Static scan of a codebase for the Stripe webhook / subscription mistakes this kit is built to prevent.
// Heuristic by design: it reads source text, it does not execute anything. Every finding says how sure it is
// ("definite" = the pattern itself is the bug, "likely" = needs a human look) and points at file:line.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { extname, join, relative, sep } from "node:path";

const CODE_EXT = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".java", ".kt", ".py", ".rb", ".php", ".go"]);
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", "target", "out", "coverage", ".venv", "venv", "vendor", ".turbo", ".vercel"]);
const MAX_FILE_BYTES = 512 * 1024;

const LIFECYCLE = {
  checkout: /checkout\.session\.completed/,
  subCreated: /customer\.subscription\.created/,
  subUpdated: /customer\.subscription\.updated/,
  subDeleted: /customer\.subscription\.deleted/,
  invoicePaid: /invoice\.paid|invoice\.payment_succeeded/,
  invoiceFailed: /invoice\.payment_failed/,
};
const VERIFY = /constructEvent(Async)?\s*\(|Signature\.verifyHeader\s*\(|Webhook\.constructEvent\s*\(|Webhook\.construct_event\s*\(|construct_event\s*\(|webhook\.ConstructEvent\s*\(|\\Stripe\\Webhook::constructEvent/;
const IDEMPOTENCY = /webhook_events|processed_events|stripe_events|idempoten|on\s+conflict|onConflict|ON CONFLICT|unique.*event_?id|event_?id.*unique|findBy.*EventId|existsBy.*EventId|event\.id\s*\)\s*\)?\s*(\.exists|\.find)/i;
const RETRIEVE = /subscriptions\.retrieve\s*\(|Subscription\.retrieve\s*\(|Subscription\.retrieve|subscriptions\(\)\.retrieve|Subscription::retrieve/;
const LIST_SUBS = /subscriptions\.list\s*\(|Subscription\.list\s*\(|Subscription::all|subscriptions\.autoPagingEach|Subscription\.list/;
const SECRET_PATTERNS = [
  { re: /\bsk_live_[0-9a-zA-Z]{16,}/, sev: "critical", what: "a LIVE secret key (sk_live_)" },
  { re: /\brk_live_[0-9a-zA-Z]{16,}/, sev: "critical", what: "a LIVE restricted key (rk_live_)" },
  { re: /\bsk_test_[0-9a-zA-Z]{16,}/, sev: "high", what: "a test secret key (sk_test_)" },
  { re: /\bwhsec_[0-9a-zA-Z]{16,}/, sev: "high", what: "a webhook signing secret (whsec_)" },
];

function isTestOrExample(rel) {
  return /(^|[/\\])(test|tests|__tests__|fixtures|e2e|examples?|samples?)([/\\]|$)|\.(test|spec)\.[a-z]+$|\.example$|\.sample$|example\.env/i.test(rel);
}

function walk(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) stack.push(p); continue; }
      if (!e.isFile()) continue;
      // Local .env files are expected to hold keys; only a .env COMMITTED to git is a finding (checked below).
      if (!CODE_EXT.has(extname(e.name))) continue;
      try { if (statSync(p).size > MAX_FILE_BYTES) continue; } catch { continue; }
      out.push(p);
    }
  }
  return out.sort();
}

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}
function firstMatch(text, re) {
  const m = re.exec(text);
  return m ? { line: lineOf(text, m.index), snippet: text.split("\n")[lineOf(text, m.index) - 1].trim().slice(0, 160) } : null;
}

function trackedEnvFiles(root) {
  try {
    const out = execFileSync("git", ["-C", root, "ls-files"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.split("\n").filter((f) => /(^|\/)\.env(\.[^/]+)?$/.test(f) && !/example|sample|template/i.test(f));
  } catch {
    return null; // not a git repo or git missing
  }
}

/**
 * @param {string} root directory to scan
 * @returns {{ root: string, filesScanned: number, webhookFiles: string[], findings: object[] }}
 */
export function scanCode(root) {
  const files = walk(root).map((abs) => {
    const rel = relative(root, abs).split(sep).join("/");
    let text = "";
    try { text = readFileSync(abs, "utf8"); } catch { /* unreadable */ }
    return { abs, rel, text };
  });
  const src = files.filter((f) => !isTestOrExample(f.rel));
  const findings = [];
  const add = (f) => findings.push(f);

  // Files that look like Stripe webhook handlers: mention Stripe AND (event types OR signature header OR verification).
  const webhookFiles = src.filter(
    (f) => /stripe/i.test(f.text) && (/stripe-signature|Stripe-Signature|HTTP_STRIPE_SIGNATURE/.test(f.text) || VERIFY.test(f.text) || (/webhook/i.test(f.rel + f.text) && Object.values(LIFECYCLE).some((re) => re.test(f.text)))),
  );
  const all = src.map((f) => f.text).join("\n");
  // Where to point file-level findings: the first event-type check in the first handler file.
  const anchor = () => {
    const f = webhookFiles[0];
    const m = firstMatch(f.text, /checkout\.session\.completed|customer\.subscription\.|invoice\.(paid|payment_)/);
    return { file: f.rel, line: m ? m.line : 1 };
  };
  const verifies = VERIFY.test(all);

  // H1: no signature verification anywhere, but there is webhook handling.
  if (webhookFiles.length && !verifies) {
    add({
      id: "H1", severity: "critical", confidence: "definite", ...anchor(),
      title: "Webhook events are not signature-verified",
      why: "Anyone who finds the endpoint URL can POST a fake 'checkout.session.completed' or 'invoice.paid' and get paid access for free.",
      fix: "Verify every request with stripe.webhooks.constructEvent(rawBody, signatureHeader, endpointSecret) and return 400 on failure, before doing anything else.",
    });
  }

  for (const f of webhookFiles) {
    // H2: verifying a parsed / re-serialised body.
    const parsed = firstMatch(f.text, /constructEvent(Async)?\s*\(\s*(JSON\.stringify\s*\(|req\.body\s*[,)]|request\.body\s*[,)]|ctx\.request\.body\s*[,)])/);
    const nextJson = VERIFY.test(f.text) ? firstMatch(f.text, /await\s+(req|request)\.json\s*\(\s*\)/) : null;
    const globalJson = /app\.use\(\s*(express\.json|bodyParser\.json)\s*\(/.test(all) && !/express\.raw\s*\(|bodyParser\.raw\s*\(|verify\s*:\s*\(/.test(all);
    if (parsed && (globalJson || /JSON\.stringify/.test(parsed.snippet))) {
      add({ id: "H2", severity: "high", confidence: "definite", file: f.rel, line: parsed.line, snippet: parsed.snippet,
        title: "Signature is checked against a parsed (re-serialised) body",
        why: "express.json()/bodyParser has already parsed the body, so the bytes no longer match what Stripe signed. Verification fails at random; teams often 'fix' it by turning verification off.",
        fix: "Mount express.raw({ type: 'application/json' }) on the webhook route only (before any global JSON parser) and pass that Buffer to constructEvent." });
    } else if (nextJson) {
      add({ id: "H2", severity: "high", confidence: "definite", file: f.rel, line: nextJson.line, snippet: nextJson.snippet,
        title: "Webhook route reads req.json() instead of the raw body",
        why: "Parsing and re-stringifying changes the bytes, so the Stripe signature can't be checked reliably.",
        fix: "Read the body with `await req.text()` and pass that string to constructEvent; parse only the verified event." });
    }

    // H3: edge runtime with synchronous verification.
    const edge = firstMatch(f.text, /export\s+const\s+runtime\s*=\s*["']edge["']/);
    if (edge && /constructEvent\s*\(/.test(f.text) && !/constructEventAsync/.test(f.text)) {
      add({ id: "H3", severity: "high", confidence: "definite", file: f.rel, line: edge.line, snippet: edge.snippet,
        title: "Edge runtime with synchronous constructEvent",
        why: "The sync verifier needs Node's crypto; on the Edge runtime it throws, so every webhook fails with 400 and Stripe eventually disables the endpoint.",
        fix: "Use `export const runtime = 'nodejs'` for the webhook route, or switch to `await stripe.webhooks.constructEventAsync(...)`." });
    }

    // H8: applying event payload state directly (order-sensitive).
    const trustsPayload = firstMatch(f.text, /data\.object\.status|data\.object\[["']status["']\]|getDataObjectDeserializer|event\.data\.object\s+as\s+Stripe\.Subscription/);
    if (trustsPayload && !RETRIEVE.test(all)) {
      add({ id: "H8", severity: "medium", confidence: "likely", file: f.rel, line: trustsPayload.line, snippet: trustsPayload.snippet,
        title: "Subscription state is taken straight from the event payload",
        why: "Stripe does not guarantee delivery order. An older 'customer.subscription.updated' arriving late overwrites newer state (e.g. re-activates a canceled customer).",
        fix: "On each event, fetch the latest subscription with stripe.subscriptions.retrieve(id) and write it only if it is not older than what you stored (compare event.created)." });
    }
  }

  // H4: no idempotency evidence.
  if (webhookFiles.length && !IDEMPOTENCY.test(all)) {
    add({ id: "H4", severity: "high", confidence: "likely", ...anchor(),
      title: "No sign of duplicate-event protection",
      why: "Stripe delivers events at least once. Without recording event.id, a retry or resend runs side effects again: double credits, duplicate emails, two provisioning runs.",
      fix: "Insert event.id into a table with a unique key (ON CONFLICT DO NOTHING) in the same transaction as the side effect, and skip events already recorded." });
  }

  // H5: success page / redirect grants access.
  for (const f of src) {
    if (!/session_id|sessionId|CHECKOUT_SESSION_ID/.test(f.text)) continue;
    const r = /checkout\.sessions\.retrieve|Session\.retrieve|sessions\(\)\.retrieve/.exec(f.text);
    if (!r) continue;
    // Only look at code AFTER the session is retrieved (the next ~25 lines), not at webhook code elsewhere in the file.
    const startLine = lineOf(f.text, r.index);
    const window = f.text.split("\n").slice(startLine - 1, startLine + 24).join("\n");
    const g = firstMatch(window, /(update|upsert|insert|save|set)\w*\s*\([^)]*\b(plan|isPro|is_pro|premium|subscribed|subscription_status|credits|tier|role)\b/i)
      || firstMatch(window, /\b(plan|isPro|is_pro|premium|subscribed|tier)\s*[:=]\s*["'](pro|premium|paid|active|true)/i);
    const grant = g && { line: startLine - 1 + g.line, snippet: g.snippet };
    if (grant) {
      add({ id: "H5", severity: "high", confidence: "likely", file: f.rel, line: grant.line, snippet: grant.snippet,
        title: "Access is granted from the checkout success redirect",
        why: "The success URL can be reopened, shared or reached when payment later fails (3-D Secure, async methods). Access and Stripe drift apart.",
        fix: "Let only the verified webhook (or reconcile) grant access. The success page should just poll your own server state until the webhook has run." });
    }
  }

  // H6: lifecycle coverage.
  if (webhookFiles.length) {
    const has = Object.fromEntries(Object.entries(LIFECYCLE).map(([k, re]) => [k, re.test(all)]));
    const at = anchor();
    if ((has.checkout || has.subCreated) && !has.subDeleted) {
      add({ id: "H6", severity: "high", confidence: "definite", ...at,
        title: "Cancellations are never handled (no customer.subscription.deleted)",
        why: "Customers who cancel, or whose payments fail until Stripe gives up, keep paid access forever.",
        fix: "Handle customer.subscription.deleted (and .updated) and recompute access from the subscription status." });
    }
    if ((has.checkout || has.subCreated) && !has.subUpdated) {
      add({ id: "H6", severity: "medium", confidence: "definite", ...at,
        title: "Plan changes and status changes are ignored (no customer.subscription.updated)",
        why: "Upgrades, downgrades, past_due and cancel-at-period-end never reach your database.",
        fix: "Handle customer.subscription.updated by re-syncing the subscription." });
    }
    if ((has.checkout || has.subCreated) && !has.invoiceFailed) {
      add({ id: "H6", severity: "medium", confidence: "definite", ...at,
        title: "Failed renewals are not handled (no invoice.payment_failed)",
        why: "You can't warn the customer or apply a grace period, so access either continues unpaid or stops with no explanation.",
        fix: "Handle invoice.payment_failed: re-sync the subscription (it becomes past_due) and notify the customer." });
    }
  }

  // H7: committed secrets.
  for (const f of files) {
    if (isTestOrExample(f.rel)) continue;
    for (const s of SECRET_PATTERNS) {
      const m = firstMatch(f.text, s.re);
      if (m && !/x{6,}|your|placeholder|REPLACE|change-?me|\.\.\./i.test(m.snippet)) {
        add({ id: "H7", severity: s.sev, confidence: "definite", file: f.rel, line: m.line, snippet: m.snippet.replace(/(sk|rk)_(live|test)_[0-9a-zA-Z]{4}[0-9a-zA-Z]+|whsec_[0-9a-zA-Z]{4}[0-9a-zA-Z]+/g, (k) => k.slice(0, 12) + "…(redacted)"),
          title: `Source contains ${s.what}`,
          why: "Anyone with read access to the code (contractors, a leaked backup, CI logs) can use it.",
          fix: "Rotate the key in the Stripe Dashboard now, load it from an environment variable or secret manager, and remove it from git history." });
        break;
      }
    }
  }
  const envs = trackedEnvFiles(root);
  if (envs && envs.length) {
    add({ id: "H7", severity: "high", confidence: "definite", file: envs[0], line: 1,
      title: `.env file committed to git (${envs.join(", ")})`,
      why: "Environment files usually hold the Stripe secret key and webhook secret.",
      fix: "Add .env to .gitignore, git rm --cached it, rotate whatever it contained, and commit only a .env.example with placeholders." });
  }

  // H9: no reconciliation.
  if (webhookFiles.length && !LIST_SUBS.test(all)) {
    add({ id: "H9", severity: "low", confidence: "likely", ...anchor(),
      title: "No reconciliation job (nothing lists subscriptions from Stripe)",
      why: "If a webhook is never delivered (endpoint down, deploy, misconfiguration), a paying customer stays without access until they complain.",
      fix: "Run a scheduled job that lists subscriptions from Stripe and repairs any that differ from your database, through the same code path as webhooks." });
  }

  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.id.localeCompare(b.id));
  return { root, filesScanned: files.length, webhookFiles: webhookFiles.map((f) => f.rel), findings };
}
