// Fills the <!-- generated:NAME --> blocks in the sample deliverables from result files (no hand-typed numbers).
//   node sample-deliverable/render.mjs [--check]
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const ICON = { pass: "PASS", fail: "FAIL", precondition_violated: "PASS*" };
const ORDER = ["duplicate", "out-of-order", "missed-webhook", "tamper", "renewal-failure"];

function diffBlock() {
  const a = resolve(here, "duplicate-credits-repro/handler.vulnerable.mjs");
  const b = resolve(here, "duplicate-credits-repro/handler.fixed.mjs");
  let out = "";
  try { execFileSync("diff", ["-u", "--label", "handler.vulnerable.mjs", "--label", "handler.fixed.mjs", a, b]); } catch (e) { out = e.stdout?.toString() ?? ""; }
  return "```diff\n" + out.trimEnd() + "\n```";
}

function reproBlock() {
  const p = resolve(here, "duplicate-credits-repro/results.json");
  if (!existsSync(p)) return "_No results yet: run `node sample-deliverable/duplicate-credits-repro/repro.mjs`._";
  const r = JSON.parse(readFileSync(p, "utf8"));
  const row = (name, x) => `| ${name} | ${r.deliveries} | ${x.ledgerRows} | ${x.balance} | ${x.ledgerRows * r.creditsPerInvoice} |`;
  return [
    `One event delivered ${r.deliveries} times; each paid invoice is worth ${r.creditsPerInvoice} credits.`,
    "",
    "| Handler / delivery | Deliveries | Ledger rows | Balance | Sum of ledger |",
    "|---|---|---|---|---|",
    row("vulnerable, sequential", r.vulnerable.sequential),
    row("vulnerable, concurrent", r.vulnerable.concurrent),
    row("fixed, sequential", r.fixed.sequential),
    row("fixed, concurrent", r.fixed.concurrent),
  ].join("\n");
}

function chaosBlock() {
  const dir = resolve(root, "chaos/results");
  if (!existsSync(dir)) return "_No chaos results yet._";
  const targets = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  const data = {};
  for (const t of targets) {
    data[t] = {};
    for (const f of readdirSync(resolve(dir, t)).filter((x) => x.endsWith(".json"))) {
      const r = JSON.parse(readFileSync(resolve(dir, t, f), "utf8"));
      data[t][r.scenario] = r;
    }
  }
  const titles = {};
  for (const t of targets) for (const [k, r] of Object.entries(data[t])) titles[k] = r.title;
  const lines = [`| Scenario | ${targets.map((t) => `\`${t}\``).join(" | ")} |`, `|---|${targets.map(() => "---").join("|")}|`];
  for (const k of ORDER.filter((k) => titles[k])) {
    lines.push(`| ${titles[k]} | ${targets.map((t) => (data[t][k] ? ICON[data[t][k].verdict] ?? data[t][k].verdict : "not run")).join(" | ")} |`);
  }
  return lines.join("\n");
}

const BLOCKS = { diff: diffBlock, repro: reproBlock, chaos: chaosBlock };
const FILES = ["FIX_REPORT_duplicate-credits.md", "WEBHOOK_HARDENING_REPORT.md", "SUBSCRIPTIONS_IMPLEMENTATION_HANDOVER.md"];
let stale = false;
for (const f of FILES) {
  const path = resolve(here, f);
  const before = readFileSync(path, "utf8");
  const after = before.replace(/<!-- generated:(\w+) -->[\s\S]*?<!-- \/generated -->/g, (_m, name) => {
    if (!BLOCKS[name]) throw new Error(`unknown block ${name} in ${f}`);
    return `<!-- generated:${name} -->\n${BLOCKS[name]()}\n<!-- /generated -->`;
  });
  if (after !== before) {
    if (process.argv.includes("--check")) { console.error(`${f} is out of date: run node sample-deliverable/render.mjs`); stale = true; }
    else writeFileSync(path, after);
  }
}
process.exit(stale ? 1 : 0);
