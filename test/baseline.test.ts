import { describe, expect, test } from "bun:test";
import {
  toBaseline,
  parseBaseline,
  compareToBaseline,
  regressionMarkdown,
  type Baseline,
} from "../src/baseline.ts";
import type { EvalReport, IntentResult } from "../src/types.ts";

// Build a minimal EvalReport from compact rows — only the fields the baseline
// logic reads. Routing samples/diagnosis are irrelevant to regression.
function report(
  rows: Array<{ id: string; expect?: string; pick: string | null; pass: boolean; confidence: number }>,
  model = "claude-haiku-4-5-20251001",
): EvalReport {
  const results: IntentResult[] = rows.map((r) => ({
    intent: { id: r.id, query: r.id, expect: r.expect ?? "t" },
    samples: [],
    pick: r.pick,
    confidence: r.confidence,
    pass: r.pass,
  }));
  return {
    server: "npx demo",
    model,
    samplesPerIntent: 5,
    minConfidence: 0.8,
    tools: [],
    results,
    score: { passed: results.filter((r) => r.pass).length, total: results.length },
  };
}

describe("toBaseline / parseBaseline", () => {
  test("round-trips through JSON", () => {
    const b = toBaseline(report([{ id: "own", expect: "get_holdings", pick: "get_holdings", pass: true, confidence: 1 }]));
    const reparsed = parseBaseline(JSON.parse(JSON.stringify(b)));
    expect(reparsed.intents.own).toEqual({ expect: "get_holdings", pick: "get_holdings", pass: true, confidence: 1 });
    expect(reparsed.model).toBe("claude-haiku-4-5-20251001");
  });

  test("rounds confidence to 2 decimals", () => {
    const b = toBaseline(report([{ id: "x", pick: "t", pass: true, confidence: 0.66666 }]));
    expect(b.intents.x!.confidence).toBe(0.67);
  });

  test("rejects an unsupported version", () => {
    expect(() => parseBaseline({ version: 2, intents: {} })).toThrow(/version/);
  });

  test("rejects a malformed intent entry", () => {
    expect(() => parseBaseline({ version: 1, intents: { x: { pass: "yes" } } })).toThrow(/malformed/);
  });
});

describe("compareToBaseline", () => {
  const base = toBaseline(
    report([
      { id: "solid", pick: "a", pass: true, confidence: 1 },
      { id: "shaky", pick: "b", pass: true, confidence: 0.9 },
      { id: "known-fail", pick: "wrong", pass: false, confidence: 1 },
    ]),
  );

  test("flags a pass that became a fail as a regression (broke)", () => {
    const cmp = compareToBaseline(base, report([
      { id: "solid", pick: "z", pass: false, confidence: 0.8 },
      { id: "shaky", pick: "b", pass: true, confidence: 0.9 },
      { id: "known-fail", pick: "wrong", pass: false, confidence: 1 },
    ]));
    expect(cmp.hasRegression).toBe(true);
    expect(cmp.regressions.map((d) => d.id)).toEqual(["solid"]);
    expect(cmp.regressions[0]!.kind).toBe("broke");
  });

  test("flags a confidence drop past tolerance as a regression (destabilized)", () => {
    const cmp = compareToBaseline(base, report([
      { id: "solid", pick: "a", pass: true, confidence: 1 },
      { id: "shaky", pick: "b", pass: true, confidence: 0.6 }, // 0.9 -> 0.6, drop 0.3 > 0.2
      { id: "known-fail", pick: "wrong", pass: false, confidence: 1 },
    ]));
    expect(cmp.hasRegression).toBe(true);
    expect(cmp.regressions.map((d) => d.id)).toEqual(["shaky"]);
    expect(cmp.regressions[0]!.kind).toBe("destabilized");
  });

  test("does NOT flag confidence noise inside the tolerance band", () => {
    const cmp = compareToBaseline(base, report([
      { id: "solid", pick: "a", pass: true, confidence: 0.85 }, // -0.15, within 0.2
      { id: "shaky", pick: "b", pass: true, confidence: 0.75 }, // -0.15, within 0.2
      { id: "known-fail", pick: "wrong", pass: false, confidence: 1 },
    ]));
    expect(cmp.hasRegression).toBe(false);
    expect(cmp.regressions).toHaveLength(0);
  });

  test("a pre-existing baselined failure does NOT fail the gate", () => {
    const cmp = compareToBaseline(base, report([
      { id: "solid", pick: "a", pass: true, confidence: 1 },
      { id: "shaky", pick: "b", pass: true, confidence: 0.9 },
      { id: "known-fail", pick: "wrong", pass: false, confidence: 1 }, // still failing — knowingly pinned
    ]));
    expect(cmp.hasRegression).toBe(false);
  });

  test("reports fixes and stabilizations as improvements, never as gate failures", () => {
    const cmp = compareToBaseline(base, report([
      { id: "solid", pick: "a", pass: true, confidence: 1 },
      { id: "shaky", pick: "b", pass: true, confidence: 1 }, // 0.9 -> 1.0, +0.1 (< tol, stays unchanged)
      { id: "known-fail", pick: "right", pass: true, confidence: 1 }, // fail -> pass
    ]));
    expect(cmp.hasRegression).toBe(false);
    expect(cmp.improvements.map((d) => d.id)).toContain("known-fail");
    expect(cmp.improvements.find((d) => d.id === "known-fail")!.kind).toBe("fixed");
  });

  test("a big confidence rise counts as stabilized", () => {
    const small = toBaseline(report([{ id: "shaky", pick: "b", pass: true, confidence: 0.6 }]));
    const cmp = compareToBaseline(small, report([{ id: "shaky", pick: "b", pass: true, confidence: 1 }]));
    expect(cmp.improvements[0]!.kind).toBe("stabilized");
  });

  test("classifies added and removed intents as informational, not regressions", () => {
    const cmp = compareToBaseline(base, report([
      { id: "solid", pick: "a", pass: true, confidence: 1 },
      { id: "shaky", pick: "b", pass: true, confidence: 0.9 },
      // known-fail removed; brand-new added
      { id: "brand-new", pick: "c", pass: true, confidence: 1 },
    ]));
    expect(cmp.hasRegression).toBe(false);
    expect(cmp.added.map((d) => d.id)).toEqual(["brand-new"]);
    expect(cmp.removed.map((d) => d.id)).toEqual(["known-fail"]);
  });

  test("detects a model mismatch between baseline and run", () => {
    const cmp = compareToBaseline(base, report([{ id: "solid", pick: "a", pass: true, confidence: 1 }], "claude-sonnet-4-6"));
    expect(cmp.modelMismatch).toEqual({ baseline: "claude-haiku-4-5-20251001", current: "claude-sonnet-4-6" });
  });

  test("a confidence drop of EXACTLY the tolerance is noise, not drift (5-sample 1.0->0.8 wobble)", () => {
    const b = toBaseline(report([{ id: "x", pick: "a", pass: true, confidence: 1 }]));
    const cmp = compareToBaseline(b, report([{ id: "x", pick: "a", pass: true, confidence: 0.8 }]), 0.2);
    expect(cmp.hasRegression).toBe(false); // delta -0.2 == -tolerance, must NOT fire
    expect(cmp.regressions).toHaveLength(0);
  });

  test("a drop just past the tolerance does fire", () => {
    const b = toBaseline(report([{ id: "x", pick: "a", pass: true, confidence: 1 }]));
    const cmp = compareToBaseline(b, report([{ id: "x", pick: "a", pass: true, confidence: 0.79 }]), 0.2);
    expect(cmp.regressions.map((d) => d.id)).toEqual(["x"]);
  });

  test("surfaces a changed expected-tool as informational re-pin, not a regression", () => {
    const b = toBaseline(report([{ id: "x", expect: "tool_a", pick: "tool_a", pass: true, confidence: 1 }]));
    const cmp = compareToBaseline(b, report([{ id: "x", expect: "tool_b", pick: "tool_b", pass: true, confidence: 1 }]));
    expect(cmp.hasRegression).toBe(false);
    expect(cmp.respecified.map((d) => d.id)).toEqual(["x"]);
    expect(cmp.compared).toBe(1);
  });

  test("a baseline with zero overlapping intents compares nothing (compared === 0)", () => {
    const b = toBaseline(report([{ id: "old", pick: "a", pass: true, confidence: 1 }]));
    const cmp = compareToBaseline(b, report([{ id: "totally-new", pick: "b", pass: true, confidence: 1 }]));
    expect(cmp.compared).toBe(0);
    expect(cmp.added.map((d) => d.id)).toEqual(["totally-new"]);
    expect(cmp.removed.map((d) => d.id)).toEqual(["old"]);
  });
});

describe("regressionMarkdown", () => {
  const base: Baseline = toBaseline(report([{ id: "solid", expect: "a", pick: "a", pass: true, confidence: 1 }]));

  test("clean run says no regressions", () => {
    const md = regressionMarkdown(compareToBaseline(base, report([{ id: "solid", expect: "a", pick: "a", pass: true, confidence: 1 }])));
    expect(md).toContain("✅ No routing regressions");
  });

  test("a broken route renders with before -> after and the expected tool", () => {
    const md = regressionMarkdown(
      compareToBaseline(base, report([{ id: "solid", expect: "a", pick: "z", pass: false, confidence: 0.7 }])),
    );
    expect(md).toContain("routing regression(s)");
    expect(md).toContain("**solid** broke");
    expect(md).toContain("`a`"); // expected tool surfaced
  });

  test("warns loudly on a model mismatch", () => {
    const md = regressionMarkdown(
      compareToBaseline(base, report([{ id: "solid", expect: "a", pick: "a", pass: true, confidence: 1 }], "claude-sonnet-4-6")),
    );
    expect(md).toContain("Model mismatch");
  });
});
