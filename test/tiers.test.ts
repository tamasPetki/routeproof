import { describe, expect, test } from "bun:test";
import { rank, resolveTier, annotateEscalations } from "../src/tiers.ts";
import type { IntentResult, Tier } from "../src/types.ts";

describe("rank", () => {
  test("orders none < read < write < destructive", () => {
    expect(rank("none")).toBeLessThan(rank("read"));
    expect(rank("read")).toBeLessThan(rank("write"));
    expect(rank("write")).toBeLessThan(rank("destructive"));
  });
});

describe("resolveTier", () => {
  const tiers: Record<string, Tier> = {
    get_holdings: "read",
    remove_account: "destructive",
    "portfolio_write_*": "write",
    "*_token": "write",
  };

  test("exact match wins", () => {
    expect(resolveTier("remove_account", tiers)).toBe("destructive");
  });

  test("defaults unlisted tools to read (the safe assumption)", () => {
    expect(resolveTier("get_allocations", tiers)).toBe("read");
    expect(resolveTier("anything", {})).toBe("read");
  });

  test("matches a * glob", () => {
    expect(resolveTier("portfolio_write_order", tiers)).toBe("write");
    expect(resolveTier("add_token", tiers)).toBe("write");
  });

  test("exact match beats a glob", () => {
    // remove_account is exact-destructive even though no glob would catch it
    expect(resolveTier("remove_account", { ...tiers, "remove_*": "write" })).toBe("destructive");
  });

  test("most specific glob wins on overlap", () => {
    const t: Record<string, Tier> = { "remove_*": "write", "remove_account_*": "destructive" };
    expect(resolveTier("remove_account_hard", t)).toBe("destructive");
  });
});

function misroute(id: string, expect_: string, pick: string | null): IntentResult {
  return {
    intent: { id, query: id, expect: expect_ },
    samples: [],
    pick,
    confidence: 1,
    pass: false,
  };
}

describe("annotateEscalations", () => {
  const tiers: Record<string, Tier> = {
    get_holdings: "read",
    get_allocations: "read",
    setup_connector: "write",
    remove_account: "destructive",
  };

  test("flags a read query that grabbed a destructive tool", () => {
    const r = misroute("x", "get_holdings", "remove_account");
    const out = annotateEscalations([r], tiers);
    expect(out).toHaveLength(1);
    expect(r.escalation).toEqual({ from: "read", to: "destructive" });
  });

  test("a lateral read→read misroute is NOT an escalation", () => {
    const r = misroute("x", "get_holdings", "get_allocations");
    expect(annotateEscalations([r], tiers)).toHaveLength(0);
    expect(r.escalation).toBeUndefined();
  });

  test("a write→read misroute (de-escalation) is NOT flagged", () => {
    const r = misroute("x", "setup_connector", "get_holdings");
    expect(annotateEscalations([r], tiers)).toHaveLength(0);
  });

  test("expect:none grabbing ANY tool escalates", () => {
    const r = misroute("x", "none", "get_holdings");
    annotateEscalations([r], tiers);
    expect(r.escalation).toEqual({ from: "none", to: "read" });
  });

  test("a deferral (pick=null) never escalates — declining is the safe direction", () => {
    const r = misroute("x", "setup_connector", null);
    expect(annotateEscalations([r], tiers)).toHaveLength(0);
    expect(r.escalation).toBeUndefined();
  });

  test("a pass is never an escalation, and stale escalation is cleared", () => {
    const r: IntentResult = {
      intent: { id: "p", query: "p", expect: "get_holdings" },
      samples: [],
      pick: "get_holdings",
      confidence: 1,
      pass: true,
      escalation: { from: "read", to: "destructive" }, // stale
    };
    annotateEscalations([r], tiers);
    expect(r.escalation).toBeUndefined();
  });

  test("sorts loudest-first (destructive before write)", () => {
    const a = misroute("a", "get_holdings", "setup_connector"); // read→write
    const b = misroute("b", "get_holdings", "remove_account"); // read→destructive
    const out = annotateEscalations([a, b], tiers);
    expect(out.map((r) => r.intent.id)).toEqual(["b", "a"]);
  });

  test("no tiers map → nothing escalates", () => {
    const r = misroute("x", "get_holdings", "remove_account");
    expect(annotateEscalations([r])).toHaveLength(0);
  });
});
