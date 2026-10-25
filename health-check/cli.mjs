#!/usr/bin/env node
// Stripe billing health check. Read-only.
//   node health-check/cli.mjs scan <path-to-your-code> [--out report.md] [--json]
//   STRIPE_API_KEY=rk_test_... node health-check/cli.mjs stripe [--days 30] [--out report.md] [--json]
//   STRIPE_API_KEY=... node health-check/cli.mjs all <path> [--out report.md]
// Exit code: 0 = no critical/high findings, 1 = critical/high findings, 2 = usage or API error.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { scanCode } from "./code-scan.mjs";
import { checkStripe } from "./stripe-check.mjs";
import { renderReport } from "./report.mjs";

function parse(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") args.json = true;
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--days") args.days = Number(argv[++i]);
    else if (a === "-h" || a === "--help") args.help = true;
    else args._.push(a);
  }
  return args;
}

const USAGE = `Stripe billing health check (read-only)

  node health-check/cli.mjs scan <path>          scan your code for webhook/subscription mistakes
  node health-check/cli.mjs stripe               check your Stripe account's webhook setup
  node health-check/cli.mjs all <path>           both

Options: --out report.md   --json   --days 30 (stripe: look-back window, max 30)
The stripe check needs STRIPE_API_KEY: a restricted key with READ access to
Webhook Endpoints, Events and Subscriptions (rk_live_/rk_test_), or a test key (sk_test_).`;

async function main() {
  const args = parse(process.argv.slice(2));
  const [cmd, path] = args._;
  if (args.help || !["scan", "stripe", "all"].includes(cmd) || (cmd !== "stripe" && !path)) {
    console.log(USAGE);
    return args.help ? 0 : 2;
  }
  const result = {};
  if (cmd === "scan" || cmd === "all") result.code = scanCode(resolve(path));
  if (cmd === "stripe" || cmd === "all") {
    const key = process.env.STRIPE_API_KEY;
    if (!key) { console.error("Set STRIPE_API_KEY (restricted read-only key recommended)."); return 2; }
    result.stripe = await checkStripe({ key, days: Math.min(30, args.days || 30) });
  }
  const output = args.json ? JSON.stringify(result, null, 2) + "\n" : renderReport(result);
  if (args.out) { writeFileSync(args.out, output); console.error(`wrote ${args.out}`); }
  else process.stdout.write(output);
  const all = [...(result.code?.findings ?? []), ...(result.stripe?.findings ?? [])];
  return all.some((f) => f.severity === "critical" || f.severity === "high") ? 1 : 0;
}

main().then((code) => process.exit(code), (e) => { console.error(`health-check: ${e.message}`); process.exit(2); });
