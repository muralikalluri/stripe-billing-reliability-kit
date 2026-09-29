// Fills the results table in README.md (between <!-- chaos:begin --> and <!-- chaos:end -->) from chaos/results.
//   node scripts/render-readme.mjs [--check]
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ICON = { pass: "PASS", fail: "FAIL", precondition_violated: "PASS*" };
const ORDER = ["duplicate", "out-of-order", "missed-webhook", "tamper", "renewal-failure"];

export function resultsTable() {
  const dir = resolve(root, "chaos/results");
  const targets = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort() : [];
  if (!targets.length) return "_No results yet: run `chaos/run-all.sh`._";
  const data = {};
  const titles = {};
  const history = {};
  for (const t of targets) {
    data[t] = {};
    const hp = resolve(dir, t, "history.jsonl");
    history[t] = existsSync(hp) ? readFileSync(hp, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    for (const f of readdirSync(resolve(dir, t)).filter((x) => x.endsWith(".json"))) {
      const r = JSON.parse(readFileSync(resolve(dir, t, f), "utf8"));
      data[t][r.scenario] = r;
      titles[r.scenario] = r.title;
    }
  }
  const lines = [`| Scenario | ${targets.map((t) => `\`${t}\``).join(" | ")} |`, `|---|${targets.map(() => "---").join("|")}|`];
  for (const k of ORDER.filter((k) => titles[k])) {
    const cell = (t) => {
      const r = data[t][k];
      if (!r) return "not run";
      const label = ICON[r.verdict] ?? r.verdict;
      const h = history[t].filter((x) => x.scenario === k);
      const failed = h.filter((x) => x.verdict === "fail").length;
      // Never show only the latest run when earlier runs failed.
      return failed ? `${label} (latest of ${h.length} runs; ${failed} FAIL)` : label;
    };
    lines.push(`| ${titles[k]} | ${targets.map(cell).join(" | ")} |`);
  }
  return lines.join("\n");
}

function main() {
const path = resolve(root, "README.md");
const before = readFileSync(path, "utf8");
const after = before.replace(/<!-- chaos:begin -->[\s\S]*?<!-- chaos:end -->/, `<!-- chaos:begin -->\n${resultsTable()}\n<!-- chaos:end -->`);
if (process.argv.includes("--check")) {
  if (after !== before) { console.error("README.md results table is out of date: run node scripts/render-readme.mjs"); process.exit(1); }
  console.log("README.md results table is up to date");
} else if (after !== before) {
  writeFileSync(path, after);
  console.log("updated README.md results table");
}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
