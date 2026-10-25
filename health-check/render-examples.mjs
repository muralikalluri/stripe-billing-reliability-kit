// Regenerates health-check/examples/report-*.md (fixed timestamp so the files are reproducible).
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanCode } from "./code-scan.mjs";
import { renderReport } from "./report.mjs";

const examples = join(dirname(fileURLToPath(import.meta.url)), "examples");
for (const name of ["express-app", "nextjs-app", "no-verification"]) {
  const out = join(examples, `report-${name}.md`);
  writeFileSync(out, renderReport({ code: scanCode(join(examples, name)), generatedAt: null }));
  console.log(`wrote ${out}`);
}
