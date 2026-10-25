// Exports Markdown deliverables to styled PDFs: pandoc converts Markdown to HTML, headless Chromium renders
// Mermaid diagrams and prints. Usage (repo root):
//   node scripts/export-pdf.mjs sample-deliverable/*.md
// Needs pandoc, plus `playwright` (installed with the Next.js e2e deps) and `mermaid` resolvable from
// nextjs/node_modules or from PDF_DEPS=<dir with node_modules>:  npm i --no-save --prefix /tmp/pdfdeps playwright mermaid
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bases = [process.env.PDF_DEPS, join(root, "nextjs")].filter(Boolean);
const find = (spec) => {
  for (const b of bases) { try { return createRequire(join(b, "package.json")).resolve(spec); } catch { /* next */ } }
  throw new Error(`cannot resolve ${spec}; install it (see header of scripts/export-pdf.mjs)`);
};
const pw = await import(pathToFileURL(find("playwright")).href);
const chromium = pw.chromium ?? pw.default.chromium; // CommonJS package
const mermaidFile = find("mermaid/dist/mermaid.min.js");

const inputs = process.argv.slice(2);
if (!inputs.length) { console.error("usage: node scripts/export-pdf.mjs <file.md> [...]"); process.exit(2); }
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  for (const input of inputs) {
    const html = join(tmpdir(), `export-${basename(input)}.html`);
    const title = readFileSync(input, "utf8").split("\n")[0].replace(/^#\s*/, "");
    execFileSync("pandoc", [input, "-f", "gfm", "-t", "html5", "--standalone", "--embed-resources",
      "--css", join(root, "scripts", "pdf-style.css"), "--metadata", `title=${title}`, "--metadata", `pagetitle=${title}`,
      "-V", "document-css=false", "-o", html]);
    appendFileSync(html, "<style>header#title-block-header{display:none}</style>");
    const page = await browser.newPage();
    await page.goto(pathToFileURL(html).href, { waitUntil: "load" });
    await page.addScriptTag({ path: mermaidFile });
    const { blocks, rendered } = await page.evaluate(async () => {
      document.querySelectorAll("pre.mermaid").forEach((pre) => { pre.textContent = pre.textContent; });
      window.mermaid.initialize({ startOnLoad: false, theme: "neutral" });
      await window.mermaid.run({ querySelector: "pre.mermaid" });
      return { blocks: document.querySelectorAll("pre.mermaid").length, rendered: document.querySelectorAll("pre.mermaid svg").length };
    });
    if (blocks !== rendered) throw new Error(`${input}: ${blocks} Mermaid block(s) but only ${rendered} rendered`);
    const out = input.replace(/\.md$/, ".pdf");
    await page.pdf({
      path: out, format: "A4", printBackground: true, displayHeaderFooter: true, headerTemplate: "<span></span>",
      footerTemplate: `<div style="font-size:8px;width:100%;text-align:center;color:#5b6675">${title.replace(/[<&]/g, "")} - page <span class="pageNumber"></span> of <span class="totalPages"></span></div>`,
      margin: { top: "18mm", bottom: "20mm", left: "15mm", right: "15mm" },
    });
    await page.close();
    console.log(`wrote ${out} (${rendered} diagram(s))`);
  }
} finally { await browser.close(); }
