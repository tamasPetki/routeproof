import { describe, expect, test } from "bun:test";
import {
  toBaseline,
  parseBaseline,
  compareToBaseline,
  regressionMarkdown,
  type Baseline,
} from "../src/baseline.ts";
import type { EvalReport, IntentResult, RouteMode } from "../src/types.ts";

// Build a minimal EvalReport from compact rows — only the fields the baseline
// logic reads. Routing samples/diagnosis are irrelevant to regression.
function report(
  rows: Array<{ id: string; expect?: string; pick: string | null; pass: boolean; confidence: number }>,
  model = "claude-haiku-4-5-20251001",
  mode?: RouteMode,
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
    mode,
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

  test("records the routing mode (defaults to host, carries select)", () => {
    expect(toBaseline(report([{ id: "x", pick: "t", pass: true, confidence: 1 }])).mode).toBe("host");
    expect(toBaseline(report([{ id: "x", pick: "t", pass: true, confidence: 1 }], "m", "select")).mode).toBe("select");
  });

  test("a legacy baseline with no mode field parses as host (back-compat)", () => {
    expect(parseBaseline({ version: 1, intents: {} }).mode).toBe("host");
    expect(parseBaseline({ version: 1, mode: "select", intents: {} }).mode).toBe("select");
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

  test("detects a mode mismatch (host baseline vs select run)", () => {
    // `base` was pinned with no mode → host. Run it in select mode.
    const cmp = compareToBaseline(base, report([{ id: "solid", pick: "a", pass: true, confidence: 1 }], "claude-haiku-4-5-20251001", "select"));
    expect(cmp.modeMismatch).toEqual({ baseline: "host", current: "select" });
  });

  test("no mode mismatch when both are host (undefined run mode defaults to host)", () => {
    const cmp = compareToBaseline(base, report([{ id: "solid", pick: "a", pass: true, confidence: 1 }]));
    expect(cmp.modeMismatch).toBeUndefined();
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

  test("warns loudly on a mode mismatch", () => {
    const md = regressionMarkdown(
      compareToBaseline(base, report([{ id: "solid", expect: "a", pick: "a", pass: true, confidence: 1 }], "claude-haiku-4-5-20251001", "select")),
    );
    expect(md).toContain("Mode mismatch");
  });
});

describe("coverage drop (forgeloop's intent-set diff)", () => {
  // baseline pins {a, b}; a run that only carries {a} has silently dropped b.
  const base = toBaseline(
    report([
      { id: "a", expect: "t", pick: "t", pass: true, confidence: 1 },
      { id: "b", expect: "t", pick: "t", pass: true, confidence: 1 },
    ]),
  );

  test("a shrunk suite sets hasCoverageDrop but NOT hasRegression (distinct axes)", () => {
    const cmp = compareToBaseline(base, report([{ id: "a", pick: "t", pass: true, confidence: 1 }]));
    expect(cmp.hasCoverageDrop).toBe(true);
    expect(cmp.hasRegression).toBe(false);
    expect(cmp.removed.map((d) => d.id)).toEqual(["b"]);
  });

  test("no drop when the suite still carries every baselined intent", () => {
    const cmp = compareToBaseline(
      base,
      report([
        { id: "a", pick: "t", pass: true, confidence: 1 },
        { id: "b", pick: "t", pass: true, confidence: 1 },
      ]),
    );
    expect(cmp.hasCoverageDrop).toBe(false);
  });

  test("markdown warns (not gates) by default, and names the opt-in flag", () => {
    const cmp = compareToBaseline(base, report([{ id: "a", pick: "t", pass: true, confidence: 1 }]));
    const md = regressionMarkdown(cmp);
    expect(md).toContain("Coverage drop (1)");
    expect(md).toContain("⚠️");
    expect(md).toContain("--fail-on-coverage-drop");
    expect(md).toContain("**b**");
    // routing axis is independently clean
    expect(md).toContain("✅ No routing regressions");
  });

  test("markdown gates the drop when opted in", () => {
    const cmp = compareToBaseline(base, report([{ id: "a", pick: "t", pass: true, confidence: 1 }]));
    const md = regressionMarkdown(cmp, { failOnCoverageDrop: true });
    expect(md).toContain("❌");
    expect(md).toContain("dropped from coverage");
    expect(md).not.toContain("✅ No routing regressions");
  });

  test("gated headline combines a routing regression and a coverage drop", () => {
    // 'a' broke (was passing, now fails) AND 'b' dropped from the suite.
    const cmp = compareToBaseline(base, report([{ id: "a", pick: "other", pass: false, confidence: 1 }]));
    expect(cmp.hasRegression).toBe(true);
    expect(cmp.hasCoverageDrop).toBe(true);
    const md = regressionMarkdown(cmp, { failOnCoverageDrop: true });
    expect(md).toContain("routing regression(s) + 1 intent(s) dropped from coverage");
  });
});

describe("escalation gating in regression mode (TheClawAbides' safety axis)", () => {
  // A clean drift comparison, but the current run carries a privilege escalation:
  // a "show balances" read query that routed to the destructive remove_account.
  const base: Baseline = toBaseline(report([{ id: "balances", expect: "get_holdings", pick: "get_holdings", pass: true, confidence: 1 }]));
  const escalatingResults: IntentResult[] = [
    {
      intent: { id: "balances", query: "show my balances", expect: "get_holdings" },
      samples: [],
      pick: "remove_account",
      confidence: 1,
      pass: false,
      escalation: { from: "read", to: "destructive" },
    },
  ];
  // The comparison the markdown renders alongside — here, no *drift* axis fires.
  const cleanCmp = compareToBaseline(base, report([{ id: "balances", expect: "get_holdings", pick: "get_holdings", pass: true, confidence: 1 }]));

  test("shows the escalation and points to the opt-in flag, but does NOT gate by default", () => {
    const md = regressionMarkdown(cleanCmp, { results: escalatingResults });
    expect(md).toContain("🚨 Privilege-escalating misroutes (1)");
    expect(md).toContain("--fail-on-escalation");
    expect(md).toContain("✅ No routing regressions"); // routing axis still clean
  });

  test("gates (❌ headline, no ✅) when --fail-on-escalation is set, independent of drift", () => {
    const md = regressionMarkdown(cleanCmp, { results: escalatingResults, failOnEscalation: true });
    expect(md).toContain("1 privilege-escalating misroute(s)");
    expect(md).not.toContain("✅ No routing regressions");
    expect(md).not.toContain("Pass `--fail-on-escalation`"); // the opt-in nudge is gone once opted in
  });

  test("no escalation in the run → flag is a no-op, clean headline", () => {
    const md = regressionMarkdown(cleanCmp, { results: report([{ id: "balances", pick: "get_holdings", pass: true, confidence: 1 }]).results, failOnEscalation: true });
    expect(md).toContain("✅ No routing regressions");
    expect(md).not.toContain("privilege-escalating");
  });

  test("the gate predicate (results carry an escalation) matches what the CLI exits on", () => {
    expect(escalatingResults.some((r) => r.escalation)).toBe(true);
    expect(report([{ id: "x", pick: "t", pass: false, confidence: 1 }]).results.some((r) => r.escalation)).toBe(false);
  });
});
