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
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    suite: "",
    samples: 3,
    json: false,
    diagnose: true,
    minConfidence: 0.8,
    concurrency: 4,
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]!;
    if (v === "--server") a.server = argv[++i];
    else if (v === "--samples") a.samples = Number(argv[++i] ?? 3);
    else if (v === "--model") a.model = argv[++i];
    else if (v === "--min-confidence") a.minConfidence = Number(argv[++i] ?? 0.8);
    else if (v === "--concurrency") a.concurrency = Number(argv[++i] ?? 4);
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
  return a;
}

function printUsage(): void {
  console.error(
    'usage: routeproof <intents.json|.yaml> --server "<cmd>" [--samples N] [--concurrency N] [--model M] [--min-confidence 0..1] [--json] [--no-diagnose]',
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
  // problem worth explaining. Clean, confident passes cost nothing.
  if (args.diagnose) {
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

  console.log(args.json ? JSON.stringify(report, null, 2) : toMarkdown(report));
  process.exit(report.score.passed === report.score.total ? 0 : 1);
}

main().catch((e: unknown) => {
  console.error(`routeproof: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
});
