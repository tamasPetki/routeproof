#!/usr/bin/env node
// routeproof CLI — evaluate how a host routes user intents to your MCP tools.
//
//   routeproof <intents.yaml> --server "npx your-mcp-server" [--samples N] [--model M] [--json]
//
// Exit code: 0 if every intent routed as expected, 1 on any misroute, 2 on error.

import { loadIntentSuite } from "./intents.ts";
import { loadToolsFromServer } from "./mcp-client.ts";
import { AnthropicProvider } from "./providers/anthropic.ts";
import { evalIntent } from "./router.ts";
import { diagnoseMisroute } from "./diagnose.ts";
import { mapWithConcurrency } from "./concurrency.ts";
import { summarize, toMarkdown } from "./report.ts";
import {
  toBaseline,
  parseBaseline,
  compareToBaseline,
  regressionMarkdown,
} from "./baseline.ts";
import { readFileSync, writeFileSync } from "node:fs";
import type { EvalReport, IntentResult } from "./types.ts";

interface Args {
  suite: string;
  server?: string;
  samples: number;
  model?: string;
  json: boolean;
  diagnose: boolean;
  minConfidence: number;
  concurrency: number;
  saveBaseline?: string;
  baseline?: string;
  driftTolerance: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    suite: "",
    samples: 3,
    json: false,
    diagnose: true,
    minConfidence: 0.8,
    concurrency: 4,
    driftTolerance: 0.2,
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]!;
    if (v === "--server") a.server = argv[++i];
    else if (v === "--samples") a.samples = Number(argv[++i] ?? 3);
    else if (v === "--model") a.model = argv[++i];
    else if (v === "--min-confidence") a.minConfidence = Number(argv[++i] ?? 0.8);
    else if (v === "--concurrency") a.concurrency = Number(argv[++i] ?? 4);
    else if (v === "--save-baseline") {
      a.saveBaseline = argv[++i];
      if (!a.saveBaseline) throw new Error("--save-baseline needs a file path");
    } else if (v === "--baseline") {
      a.baseline = argv[++i];
      if (!a.baseline) throw new Error("--baseline needs a file path");
    } else if (v === "--drift-tolerance") a.driftTolerance = Number(argv[++i] ?? 0.2);
    else if (v === "--json") a.json = true;
    else if (v === "--no-diagnose") a.diagnose = false;
    else if (v === "-h" || v === "--help") {
      printUsage();
      process.exit(0);
    } else if (!a.suite) a.suite = v;
  }
  if (!a.suite) {
    printUsage();
    throw new Error("missing <intents> file");
  }
  if (!Number.isFinite(a.samples) || a.samples < 1) throw new Error("--samples must be >= 1");
  if (!Number.isFinite(a.concurrency) || a.concurrency < 1) throw new Error("--concurrency must be >= 1");
  // A NaN/out-of-range tolerance would silently disable the soft half of the
  // gate (every comparison falls outside [-tol, tol]); fail loudly instead.
  if (!Number.isFinite(a.driftTolerance) || a.driftTolerance < 0 || a.driftTolerance > 1) {
    throw new Error("--drift-tolerance must be a number in 0..1");
  }
  if (!Number.isFinite(a.minConfidence) || a.minConfidence < 0 || a.minConfidence > 1) {
    throw new Error("--min-confidence must be a number in 0..1");
  }
  if (a.saveBaseline && a.baseline) {
    throw new Error("--save-baseline and --baseline are mutually exclusive (pin, or check against a pin)");
  }
  return a;
}

function printUsage(): void {
  console.error(
    'usage: routeproof <intents.json|.yaml> --server "<cmd>" [--samples N] [--concurrency N] [--model M] [--min-confidence 0..1] [--json] [--no-diagnose]\n' +
      "       regression mode: [--save-baseline <file>] to pin, [--baseline <file>] to fail on drift [--drift-tolerance 0..1]",
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const suite = await loadIntentSuite(args.suite);
  const server = args.server ?? suite.server;
  if (!server) {
    throw new Error("no server command — pass --server or set 'server' in the intent file");
  }

  const tools = await loadToolsFromServer(server);
  if (tools.length === 0) throw new Error(`server '${server}' advertised no tools`);

  const provider = new AnthropicProvider(args.model);
  const results: IntentResult[] = await mapWithConcurrency(
    suite.intents,
    args.concurrency,
    (intent) => evalIntent(provider, tools, intent, args.samples),
  );

  // A pass below the confidence threshold is flaky — it routes wrong a real
  // fraction of the time, which a single-sample test would miss entirely.
  for (const r of results) {
    if (r.pass && r.confidence < args.minConfidence) r.flaky = true;
  }

  // Diagnose hard misroutes AND flaky passes — both have a real description
  // problem worth explaining. Clean, confident passes cost nothing. Skip it in
  // regression mode: pinning a baseline just snapshots, and the CI drift-check
  // runs often — the diagnosis is for the standalone report, not the gate.
  const wantDiagnose = args.diagnose && !args.saveBaseline && !args.baseline;
  if (wantDiagnose) {
    const issues = results.filter((r) => !r.pass || r.flaky);
    const diagnoses = await mapWithConcurrency(issues, args.concurrency, (r) =>
      diagnoseMisroute(provider, tools, r.intent, r.pick),
    );
    issues.forEach((r, i) => (r.diagnosis = diagnoses[i]));
  }

  const report: EvalReport = {
    server,
    model: provider.model,
    samplesPerIntent: args.samples,
    minConfidence: args.minConfidence,
    tools,
    results,
    score: summarize(results),
  };

  // Pin: snapshot this run as the baseline and exit clean. No gate, no failure —
  // you're declaring "this is the routing I expect from here on."
  if (args.saveBaseline) {
    const baseline = toBaseline(report);
    writeFileSync(args.saveBaseline, JSON.stringify(baseline, null, 2) + "\n");
    console.error(
      `routeproof: pinned ${report.results.length} intents to ${args.saveBaseline} (model ${report.model}, ${report.samplesPerIntent} samples/intent).`,
    );
    process.exit(0);
  }

  // Check: compare against a pinned baseline and FAIL on drift. This is the CI
  // gate — a description edit that silently re-routed a query trips it here.
  if (args.baseline) {
    let raw: string;
    try {
      raw = readFileSync(args.baseline, "utf8");
    } catch {
      throw new Error(`baseline file not found: ${args.baseline} — pin one first with --save-baseline ${args.baseline}`);
    }
    const baseline = parseBaseline(JSON.parse(raw), args.baseline);
    const cmp = compareToBaseline(baseline, report, args.driftTolerance);

    // Across models, routing differs for reasons unrelated to your edits — the
    // comparison is meaningless, so refuse to gate on it rather than flip CI on noise.
    if (cmp.modelMismatch) {
      console.log(args.json ? JSON.stringify({ report, comparison: cmp }, null, 2) : regressionMarkdown(cmp));
      console.error(
        `routeproof: baseline was pinned on ${cmp.modelMismatch.baseline} but this run used ${cmp.modelMismatch.current}. Re-pin on the model you gate with (--save-baseline) — refusing to gate on a cross-model comparison.`,
      );
      process.exit(2);
    }

    // A gate that compared nothing must not report success. An empty or stale
    // baseline (bad merge, wrong path) would otherwise mark everything "added" and exit 0.
    if (cmp.compared === 0) {
      throw new Error(
        `baseline ${args.baseline} shares no intents with this suite (${report.results.length} intents, 0 matched) — re-pin with --save-baseline`,
      );
    }

    console.log(args.json ? JSON.stringify({ report, comparison: cmp }, null, 2) : regressionMarkdown(cmp));
    process.exit(cmp.hasRegression ? 1 : 0);
  }

  console.log(args.json ? JSON.stringify(report, null, 2) : toMarkdown(report));
  process.exit(report.score.passed === report.score.total ? 0 : 1);
}

main().catch((e: unknown) => {
  console.error(`routeproof: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
});
