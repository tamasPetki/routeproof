// Turn eval results into something a developer can act on: a score, a table,
// and — for every misroute — what it picked instead and why. The "why" is the
// product; a bare percentage tells you that you have a problem, not where.

import type { EvalReport, IntentResult } from "./types.ts";

export function summarize(results: IntentResult[]): { passed: number; total: number } {
  return { passed: results.filter((r) => r.pass).length, total: results.length };
}

export function toMarkdown(report: EvalReport): string {
  const { score } = report;
  const pct = score.total ? Math.round((score.passed / score.total) * 100) : 0;
  const lines: string[] = [];

  lines.push(`# routeproof report`, "");
  lines.push(
    `**Server:** \`${report.server}\`  ·  **Model:** ${report.model}  ·  **Samples/intent:** ${report.samplesPerIntent}`,
    "",
  );
  lines.push(`**Routing score: ${score.passed}/${score.total} (${pct}%)**`, "");

  lines.push(`| intent | query | expected | picked | conf | |`);
  lines.push(`|---|---|---|---|---|---|`);
  for (const r of report.results) {
    const conf = `${Math.round(r.confidence * 100)}%`;
    const mark = r.pass ? "✅" : "❌";
    lines.push(
      `| ${r.intent.id} | ${esc(r.intent.query)} | \`${r.intent.expect}\` | \`${r.pick ?? "none"}\` | ${conf} | ${mark} |`,
    );
  }

  const misses = report.results.filter((r) => !r.pass);
  if (misses.length) {
    lines.push("", `## Misroutes (${misses.length})`);
    for (const r of misses) {
      lines.push("", `### ❌ ${r.intent.id} — "${esc(r.intent.query)}"`);
      lines.push(
        `- expected \`${r.intent.expect}\`, got \`${r.pick ?? "none"}\` (${Math.round(r.confidence * 100)}% of ${r.samples.length} samples)`,
      );
      const reason = r.samples.find((s) => (s.picked ?? "none") === (r.pick ?? "none"))?.reason;
      if (reason) lines.push(`- model's reasoning: ${esc(reason)}`);
    }
  }

  return lines.join("\n") + "\n";
}

function esc(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
