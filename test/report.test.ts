import { describe, expect, test } from "bun:test";
import { summarize, toMarkdown } from "../src/report.ts";
import type { EvalReport, IntentResult } from "../src/types.ts";

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

  test("lists a Misroutes section with the model's reasoning", () => {
    expect(md).toContain("## Misroutes (1)");
    expect(md).toContain("which wallets");
    expect(md).toContain("triggers said 'exchanges', not 'wallets'");
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
