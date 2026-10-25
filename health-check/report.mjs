// Renders scan results as a Markdown report a client can read without opening the code.
const BADGE = { critical: "🔴 Critical", high: "🟠 High", medium: "🟡 Medium", low: "⚪ Low" };

function counts(findings) {
  const c = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) c[f.severity]++;
  return c;
}

function findingBlock(f, i) {
  const loc = f.file ? `\`${f.file}${f.line ? `:${f.line}` : ""}\`` : "";
  const lines = [
    `### ${i + 1}. ${f.title}`,
    "",
    `**${BADGE[f.severity]}**${f.confidence ? ` · ${f.confidence === "definite" ? "definite" : "likely, needs a human look"}` : ""}${loc ? ` · ${loc}` : ""} · rule ${f.id}`,
    "",
  ];
  if (f.snippet) lines.push("```", f.snippet, "```", "");
  lines.push(`**Why it matters.** ${f.why}`, "", `**Fix.** ${f.fix}`, "");
  if (f.sample?.length) {
    lines.push("| Event | Type | Created | Pending deliveries |", "|---|---|---|---|");
    for (const s of f.sample) lines.push(`| \`${s.id}\` | ${s.type} | ${s.created} | ${s.pending_webhooks} |`);
    lines.push("");
  }
  return lines.join("\n");
}

export function renderReport({ code, stripe, generatedAt = new Date() }) {
  const all = [...(stripe?.findings ?? []), ...(code?.findings ?? [])];
  const c = counts(all);
  const out = [
    "# Stripe billing health check",
    "",
    `Generated ${generatedAt ? `${generatedAt.toISOString().slice(0, 16).replace("T", " ")} UTC ` : ""}by \`health-check\` from [stripe-billing-reliability-kit](https://github.com/muralikalluri/stripe-billing-reliability-kit). Read-only: nothing was changed.`,
    "",
    "| Severity | Count |",
    "|---|---|",
    `| Critical | ${c.critical} |`,
    `| High | ${c.high} |`,
    `| Medium | ${c.medium} |`,
    `| Low | ${c.low} |`,
    "",
  ];
  if (all.length === 0) out.push("**No issues found by the automated checks.** That covers the common mistakes, not everything; a manual review is still worth it before a launch.", "");

  if (stripe) {
    out.push(`## Stripe account (${stripe.mode} mode)`, "");
    out.push(`- Webhook endpoints: ${stripe.endpoints.length} (${stripe.endpoints.filter((e) => e.status === "enabled").length} enabled)`);
    for (const e of stripe.endpoints) out.push(`  - \`${e.url}\` · ${e.status} · ${e.events === 0 ? "no" : e.events} event type(s)${e.api_version ? ` · pinned to ${e.api_version}` : ""}`);
    out.push(`- Undelivered events, last ${stripe.undelivered.days} days: ${stripe.undelivered.total}`);
    if (stripe.subscriptions.scanned) out.push(`- Subscriptions by status: ${Object.entries(stripe.subscriptions.byStatus).map(([k, v]) => `${k} ${v}`).join(", ")}`);
    for (const n of stripe.notes) out.push(`- Note: ${n}`);
    out.push("");
    stripe.findings.forEach((f, i) => out.push(findingBlock(f, i)));
  }
  if (code) {
    out.push("## Code", "", `Scanned ${code.filesScanned} file${code.filesScanned === 1 ? "" : "s"}. Webhook handler file(s): ${code.webhookFiles.length ? code.webhookFiles.map((f) => `\`${f}\``).join(", ") : "none found"}.`, "");
    if (!code.webhookFiles.length) out.push("No Stripe webhook handler was recognised. If you have one, point the scan at the folder that contains it.", "");
    code.findings.forEach((f, i) => out.push(findingBlock(f, (stripe?.findings.length ?? 0) + i)));
  }
  out.push("---", "", "Automated checks catch the common, expensive mistakes. They can miss logic that is spread across files or written in an unusual way, and a \"likely\" finding can be a false alarm. Each rule maps to a mechanism in this kit, tested against real Stripe test mode: see the repository README.");
  return out.join("\n") + "\n";
}
