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
import { summarize, toMarkdown } from "./report.ts";
import type { EvalReport, IntentResult } from "./types.ts";

interface Args {
  suite: string;
  server?: string;
  samples: number;
  model?: string;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { suite: "", samples: 3, json: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]!;
    if (v === "--server") a.server = argv[++i];
    else if (v === "--samples") a.samples = Number(argv[++i] ?? 3);
    else if (v === "--model") a.model = argv[++i];
    else if (v === "--json") a.json = true;
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
  return a;
}

function printUsage(): void {
  console.error(
    'usage: routeproof <intents.json|.yaml> --server "<cmd>" [--samples N] [--model M] [--json]',
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
  const results: IntentResult[] = [];
  for (const intent of suite.intents) {
    results.push(await evalIntent(provider, tools, intent, args.samples));
  }

  const report: EvalReport = {
    server,
    model: provider.model,
    samplesPerIntent: args.samples,
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
