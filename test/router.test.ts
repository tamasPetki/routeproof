import { describe, expect, test } from "bun:test";
import { aggregate, evalIntent } from "../src/router.ts";
import type { Provider } from "../src/providers/types.ts";
import type { ToolSpec, RouteSample } from "../src/types.ts";

const TOOLS: ToolSpec[] = [
  { name: "get_holdings", description: "what you own", inputSchema: {} },
  { name: "list_accounts", description: "which venues", inputSchema: {} },
];

/** A deterministic fake provider that replays a fixed script of samples. */
function fakeProvider(script: RouteSample[]): Provider {
  let i = 0;
  return {
    model: "fake",
    async route() {
      return script[i++ % script.length]!;
    },
  };
}

describe("aggregate", () => {
  test("returns majority pick and its confidence", () => {
    const r = aggregate([
      { picked: "a", reason: "" },
      { picked: "a", reason: "" },
      { picked: "b", reason: "" },
    ]);
    expect(r.pick).toBe("a");
    expect(r.confidence).toBeCloseTo(2 / 3);
  });

  test("null picks aggregate as 'no tool' without colliding with a real tool", () => {
    const r = aggregate([
      { picked: null, reason: "" },
      { picked: null, reason: "" },
      { picked: "x", reason: "" },
    ]);
    expect(r.pick).toBeNull();
    expect(r.confidence).toBeCloseTo(2 / 3);
  });

  test("empty samples → null pick, zero confidence", () => {
    expect(aggregate([])).toEqual({ pick: null, confidence: 0 });
  });
});

describe("evalIntent", () => {
  test("passes when the majority pick matches expect", async () => {
    const p = fakeProvider([
      { picked: "get_holdings", reason: "" },
      { picked: "get_holdings", reason: "" },
      { picked: "list_accounts", reason: "" },
    ]);
    const r = await evalIntent(p, TOOLS, { id: "i", query: "what do I own", expect: "get_holdings" }, 3);
    expect(r.pass).toBe(true);
    expect(r.pick).toBe("get_holdings");
  });

  test("fails when the majority pick is the wrong tool", async () => {
    const p = fakeProvider([{ picked: "list_accounts", reason: "matched 'venues'" }]);
    const r = await evalIntent(p, TOOLS, { id: "i", query: "what do I own", expect: "get_holdings" }, 2);
    expect(r.pass).toBe(false);
    expect(r.pick).toBe("list_accounts");
  });

  test("expect:'none' passes only when the model calls no tool", async () => {
    const p = fakeProvider([{ picked: null, reason: "no tool fits" }]);
    const r = await evalIntent(p, TOOLS, { id: "i", query: "tell a joke", expect: "none" }, 2);
    expect(r.pass).toBe(true);
    expect(r.pick).toBeNull();
  });
});
