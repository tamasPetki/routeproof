#!/usr/bin/env node
// routeproof CLI — evaluate how a host routes user intents to your MCP tools.
//
//   routeproof <intents.yaml> --server "npx your-mcp-server" [--samples N] [--model M] [--json]
//
// Exit code: 0 if every intent routed as expected, 1 on any misroute, 2 on error.

import { loadIntentSuite, unknownExpectations } from "./intents.ts";
import { loadToolsFromServer } from "./mcp-client.ts";
import { AnthropicProvider } from "./providers/anthropic.ts";
import { evalIntent } from "./router.ts";
import { diagnoseMisroute } from "./diagnose.ts";
import { generateIntentsForTool } from "./fuzz.ts";
import { mapWithConcurrency } from "./concurrency.ts";
import { annotateEscalations } from "./tiers.ts";
import { summarize, toMarkdown } from "./report.ts";
import {
  toBaseline,
  parseBaseline,
  compareToBaseline,
  regressionMarkdown,
} from "./baseline.ts";
import { readFileSync, writeFileSync } from "node:fs";
import type { EvalReport, Intent, IntentResult, Tier } from "./types.ts";

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
  failOnCoverageDrop: boolean;
  failOnEscalation: boolean;
  fuzz: boolean;
  fuzzPerTool: number;
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
    failOnCoverageDrop: false,
    failOnEscalation: false,
    fuzz: false,
    fuzzPerTool: 3,
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
    else if (v === "--fail-on-coverage-drop") a.failOnCoverageDrop = true;
    else if (v === "--fail-on-escalation") a.failOnEscalation = true;
    else if (v === "--fuzz") a.fuzz = true;
    else if (v === "--fuzz-per-tool") a.fuzzPerTool = Number(argv[++i] ?? 3);
    else if (v === "--json") a.json = true;
    else if (v === "--no-diagnose") a.diagnose = false;
    else if (v === "-h" || v === "--help") {
      printUsage();
      process.exit(0);
    } else if (v.startsWith("-")) {
      // Never silently swallow an unrecognized flag. A user copy-pasting a flag
      // from docs for a newer version must hear about it, not get a no-op run
      // that looks like it worked (e.g. a security gate that never gated).
      throw new Error(`unknown option '${v}'. Run --help for the supported flags.`);
    } else if (!a.suite) a.suite = v;
    else throw new Error(`unexpected extra argument '${v}'. Pass a single intents file (see --help).`);
  }
  // Fuzz invents its own intents from the tool descriptions, so it needs no
  // suite file — but it does need a server to read those descriptions from.
  if (!a.suite && !a.fuzz) {
    printUsage();
    throw new Error("missing <intents> file");
  }
  if (a.fuzz && !a.server) throw new Error("--fuzz needs --server (there's no intent file to read it from)");
  if (a.fuzz && (a.saveBaseline || a.baseline)) {
    throw new Error("--fuzz can't be combined with baseline mode — generated intents differ each run, so pinning them is meaningless. Promote the keepers into a suite first.");
  }
  if (!Number.isFinite(a.fuzzPerTool) || a.fuzzPerTool < 1) throw new Error("--fuzz-per-tool must be >= 1");
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
    "routeproof — test whether an AI host routes user intents to the right MCP tools.\n" +
      "It runs each query through a fresh model that sees ONLY your tools' names,\n" +
      "descriptions, and schemas (the host's-eye view), N times, and reports what\n" +
      "mis-routed and why. Needs ANTHROPIC_API_KEY (BYO; defaults to a cheap model).\n" +
      "\n" +
      'usage: routeproof <intents.json|.yaml> --server "<cmd>" [options]\n' +
      "\n" +
      "an intents file looks like:\n" +
      "  intents:\n" +
      '    - id: which-wallets\n' +
      '      query: "which wallets am I tracking?"\n' +
      "      expect: list_accounts          # or `none` to assert no tool should fire\n" +
      "  # optional, for severity grading:\n" +
      "  tiers: { remove_account: destructive }   # read < write < destructive\n" +
      "\n" +
      'example (against a real server):\n' +
      '  routeproof examples/headless-tracker.intents.yaml --server "npx headless-tracker"\n' +
      "  (more starter suites ship in the package’s examples/ directory)\n" +
      "\n" +
      "options:\n" +
      "  --server \"<cmd>\"        command that launches your MCP server over stdio\n" +
      "  --samples N             samples per intent (default 3; routing is nondeterministic)\n" +
      "  --concurrency N         intents evaluated in parallel (default 4)\n" +
      "  --model M               Anthropic model id (default: a cheap Haiku-class model)\n" +
      "  --min-confidence 0..1   below this, a passing route is flagged flaky (default 0.8)\n" +
      "  --json                  emit the full report as JSON instead of markdown\n" +
      "  --no-diagnose           skip the per-misroute why + suggested-fix pass\n" +
      "  regression mode: --save-baseline <file> to pin; --baseline <file> to fail CI on drift\n" +
      "                   [--drift-tolerance 0..1] [--fail-on-coverage-drop] [--fail-on-escalation]\n" +
      "  fuzz mode:       --fuzz [--fuzz-per-tool N] — invent queries from your descriptions",
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Resolve the server: from --server, or (non-fuzz only) the intent file.
  let server = args.server;
  let suiteIntents: Intent[] = [];
  let suiteTiers: Record<string, Tier> | undefined;
  if (!args.fuzz) {
    const suite = await loadIntentSuite(args.suite);
    server = server ?? suite.server;
    suiteIntents = suite.intents;
    suiteTiers = suite.tiers;
  }
  if (!server) {
    throw new Error("no server command — pass --server or set 'server' in the intent file");
  }

  const tools = await loadToolsFromServer(server);
  if (tools.length === 0) throw new Error(`server '${server}' advertised no tools`);

  // Warn (don't fail) when a hand-written intent expects a tool the server
  // doesn't expose — it can never pass and would otherwise masquerade as a
  // misroute. Fuzz generates its intents from the tools, so they always match.
  if (!args.fuzz) {
    const unknown = unknownExpectations(suiteIntents, tools.map((t) => t.name));
    if (unknown.length) {
      console.error(
        `routeproof: warning — ${unknown.length} intent(s) expect a tool this server doesn't advertise: ` +
          unknown.map((u) => `${u.id} → '${u.expect}'`).join(", ") +
          `. They can never pass; check for a typo against the server's tool names.`,
      );
    }
  }

  const provider = new AnthropicProvider(args.model);

  // In fuzz mode, generate the intents from the tool descriptions themselves —
  // one generation call per tool, run together — then evaluate them normally.
  let intents = suiteIntents;
  if (args.fuzz) {
    const generated = await mapWithConcurrency(tools, args.concurrency, (t) =>
      generateIntentsForTool(provider, tools, t, args.fuzzPerTool),
    );
    intents = generated.flat();
    if (intents.length === 0) throw new Error("fuzz generated no usable queries — try a different model");
    console.error(
      `routeproof: fuzz generated ${intents.length} queries across ${tools.length} tools (${args.fuzzPerTool}/tool) — routing them now.`,
    );
  }

  const results: IntentResult[] = await mapWithConcurrency(
    intents,
    args.concurrency,
    (intent) => evalIntent(provider, tools, intent, args.samples),
  );

  // A pass below the confidence threshold is flaky — it routes wrong a real
  // fraction of the time, which a single-sample test would miss entirely.
  for (const r of results) {
    if (r.pass && r.confidence < args.minConfidence) r.flaky = true;
  }

  // Tag misroutes that crossed a capability boundary (read query → write/destructive
  // tool, or a should-route-nowhere query that grabbed any tool). A no-op when the
  // suite declares no `tiers`. Fuzz mode has no suite, so it carries no tiers.
  annotateEscalations(results, suiteTiers);

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
    tiers: suiteTiers,
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
      console.log(args.json ? JSON.stringify({ report, comparison: cmp }, null, 2) : regressionMarkdown(cmp, { failOnCoverageDrop: args.failOnCoverageDrop, failOnEscalation: args.failOnEscalation, results }));
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

    console.log(args.json ? JSON.stringify({ report, comparison: cmp }, null, 2) : regressionMarkdown(cmp, { failOnCoverageDrop: args.failOnCoverageDrop, failOnEscalation: args.failOnEscalation, results }));
    // Routing regressions always gate. A coverage drop (intents dropped from the
    // suite the baseline pinned) gates only when the caller opts in — removing a
    // tool legitimately drops its intents, but an accidental shrink is the
    // failure that otherwise passes every test. A privilege escalation in this
    // run gates on opt-in too, independent of drift: a query that routes to a
    // write/destructive tool is a safety failure even if it's not a *new* one.
    const fail =
      cmp.hasRegression ||
      (args.failOnCoverageDrop && cmp.hasCoverageDrop) ||
      (args.failOnEscalation && results.some((r) => r.escalation));
    process.exit(fail ? 1 : 0);
  }

  console.log(args.json ? JSON.stringify(report, null, 2) : toMarkdown(report));
  process.exit(report.score.passed === report.score.total ? 0 : 1);
}

main().catch((e: unknown) => {
  console.error(`routeproof: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
});
