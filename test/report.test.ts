import { describe, expect, test } from "bun:test";
import { summarize, toMarkdown, escalationSection } from "../src/report.ts";
import type { EvalReport, IntentResult } from "../src/types.ts";

describe("escalationSection", () => {
  test("is empty when nothing escalated", () => {
    expect(escalationSection([])).toEqual([]);
    expect(
      escalationSection([
        { intent: { id: "x", query: "x", expect: "a" }, samples: [], pick: "b", confidence: 1, pass: false },
      ]),
    ).toEqual([]);
  });

  test("renders a heading + one line per escalation", () => {
    const lines = escalationSection([
      {
        intent: { id: "danger", query: "show balances", expect: "get_holdings" },
        samples: [],
        pick: "remove_account",
        confidence: 1,
        pass: false,
        escalation: { from: "read", to: "destructive" },
      },
    ]);
    const md = lines.join("\n");
    expect(md).toContain("## 🚨 Privilege-escalating misroutes (1)");
    expect(md).toContain("### 🚨 danger");
    expect(md).toContain("expected `get_holdings` (**read**), got `remove_account` (**destructive**)");
  });
});

const results: IntentResult[] = [
  {
    intent: { id: "own", query: "what do I own?", expect: "get_holdings" },
    samples: [{ picked: "get_holdings", reason: "called get_holdings" }],
    pick: "get_holdings",
    confidence: 1,
    pass: true,
  },
  {
    intent: { id: "wallets", query: "which wallets am I tracking?", expect: "list_accounts" },
    samples: [{ picked: "get_holdings", reason: "triggers said 'exchanges', not 'wallets'" }],
    pick: "get_holdings",
    confidence: 1,
    pass: false,
  },
];

describe("summarize", () => {
  test("counts passes vs total", () => {
    expect(summarize(results)).toEqual({ passed: 1, total: 2 });
  });
});

describe("toMarkdown", () => {
  const md = toMarkdown({
    server: "npx demo mcp",
    model: "claude-haiku-4-5-20251001",
    samplesPerIntent: 1,
    tools: [],
    results,
    score: summarize(results),
  } satisfies EvalReport);

  test("shows the headline score", () => {
    expect(md).toContain("Routing score: 1/2 (50%)");
  });

  test("lists an Issues section with the model's reasoning fallback", () => {
    expect(md).toContain("## Issues (1)");
    expect(md).toContain("(misroute)");
    expect(md).toContain("which wallets");
    expect(md).toContain("triggers said 'exchanges', not 'wallets'");
  });

  test("flags a flaky pass (passed below confidence threshold) with its diagnosis", () => {
    const flaky = toMarkdown({
      server: "s",
      model: "m",
      samplesPerIntent: 5,
      minConfidence: 0.8,
      tools: [],
      results: [
        {
          intent: { id: "split", query: "stablecoins vs crypto?", expect: "get_allocations" },
          samples: [{ picked: "get_allocations", reason: "" }],
          pick: "get_allocations",
          confidence: 0.6,
          pass: true,
          flaky: true,
          diagnosis: { why: "overlap with get_holdings", suggestedFix: "clarify get_allocations" },
        },
      ],
      score: { passed: 1, total: 1 },
    });
    expect(flaky).toContain("⚠️ 1 flaky (passed below 80% confidence)");
    expect(flaky).toContain("(flaky)");
    expect(flaky).toContain("only 60% of the time");
    expect(flaky).toContain("**why:** overlap with get_holdings");
  });

  test("renders the diagnosis why + fix when present (instead of the thin reason)", () => {
    const withDiag = toMarkdown({
      server: "s",
      model: "m",
      samplesPerIntent: 1,
      tools: [],
      results: [
        {
          intent: { id: "split", query: "stablecoins vs crypto?", expect: "get_allocations" },
          samples: [{ picked: "get_holdings", reason: "called get_holdings" }],
          pick: "get_holdings",
          confidence: 1,
          pass: false,
          diagnosis: {
            why: "get_allocations never says it handles 'X vs Y' splits",
            suggestedFix: "add 'stablecoins vs crypto' to get_allocations' description",
          },
        },
      ],
      score: { passed: 0, total: 1 },
    });
    expect(withDiag).toContain("**why:** get_allocations never says");
    expect(withDiag).toContain("**fix:** add 'stablecoins vs crypto'");
    expect(withDiag).not.toContain("called get_holdings"); // thin reason suppressed
  });

  test("leads with a privilege-escalating-misroutes section and counts it in the headline", () => {
    const md = toMarkdown({
      server: "s",
      model: "m",
      samplesPerIntent: 3,
      tiers: { get_holdings: "read", remove_account: "destructive" },
      tools: [],
      results: [
        {
          intent: { id: "danger", query: "show my balances", expect: "get_holdings" },
          samples: [{ picked: "remove_account", reason: "" }],
          pick: "remove_account",
          confidence: 1,
          pass: false,
          escalation: { from: "read", to: "destructive" },
        },
      ],
      score: { passed: 0, total: 1 },
    });
    expect(md).toContain("🚨 1 privilege-escalating");
    expect(md).toContain("## 🚨 Privilege-escalating misroutes (1)");
    expect(md).toContain("expected `get_holdings` (**read**), got `remove_account` (**destructive**)");
  });

  test("phrases an expect:none escalation as 'should route to no tool'", () => {
    const md = toMarkdown({
      server: "s",
      model: "m",
      samplesPerIntent: 1,
      tiers: { remove_account: "destructive" },
      tools: [],
      results: [
        {
          intent: { id: "weather", query: "weather in Budapest?", expect: "none" },
          samples: [{ picked: "remove_account", reason: "" }],
          pick: "remove_account",
          confidence: 1,
          pass: false,
          escalation: { from: "none", to: "destructive" },
        },
      ],
      score: { passed: 0, total: 1 },
    });
    expect(md).toContain("should route to **no tool**");
    expect(md).toContain("**destructive**-tier tool `remove_account`");
  });

  test("names the mode only when it's select (host stays byte-identical)", () => {
    expect(md).not.toContain("Mode:"); // default host — header unchanged
    const sel = toMarkdown({
      server: "node adapter.mjs registry.json",
      model: "m",
      mode: "select",
      samplesPerIntent: 1,
      tools: [],
      results,
      score: summarize(results),
    } satisfies EvalReport);
    expect(sel).toContain("**Mode:** select (forced pick)");
  });

  test("escapes pipes so the table can't break", () => {
    const piped = toMarkdown({
      server: "s",
      model: "m",
      samplesPerIntent: 1,
      tools: [],
      results: [
        {
          intent: { id: "x", query: "a | b", expect: "t" },
          samples: [{ picked: "t", reason: "" }],
          pick: "t",
          confidence: 1,
          pass: true,
        },
      ],
      score: { passed: 1, total: 1 },
    });
    expect(piped).toContain("a \\| b");
  });
});
