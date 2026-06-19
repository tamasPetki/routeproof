import { describe, expect, test } from "bun:test";
import { validateSuite } from "../src/intents.ts";

describe("validateSuite", () => {
  test("accepts a well-formed suite and fills ids", () => {
    const s = validateSuite({
      server: "npx foo mcp",
      intents: [
        { query: "what do I own?", expect: "get_holdings" },
        { id: "wallets", query: "which wallets?", expect: "list_accounts" },
      ],
    });
    expect(s.server).toBe("npx foo mcp");
    expect(s.intents).toHaveLength(2);
    expect(s.intents[0]!.id).toBe("intent-1"); // auto-assigned
    expect(s.intents[1]!.id).toBe("wallets"); // explicit kept
  });

  test("rejects a non-object", () => {
    expect(() => validateSuite(null)).toThrow(/not an object/);
    expect(() => validateSuite("nope")).toThrow(/not an object/);
  });

  test("rejects an empty or missing intents array", () => {
    expect(() => validateSuite({})).toThrow(/non-empty 'intents'/);
    expect(() => validateSuite({ intents: [] })).toThrow(/non-empty 'intents'/);
  });

  test("rejects an intent without a query", () => {
    expect(() => validateSuite({ intents: [{ expect: "x" }] })).toThrow(/missing a 'query'/);
  });

  test("rejects an intent without expect", () => {
    expect(() => validateSuite({ intents: [{ query: "hi" }] })).toThrow(/missing an 'expect'/);
  });

  test("rejects duplicate ids", () => {
    expect(() =>
      validateSuite({
        intents: [
          { id: "dup", query: "a", expect: "t" },
          { id: "dup", query: "b", expect: "t" },
        ],
      }),
    ).toThrow(/duplicate intent id/);
  });

  test("'none' is a valid expectation (asserts no tool should be called)", () => {
    const s = validateSuite({ intents: [{ query: "tell me a joke", expect: "none" }] });
    expect(s.intents[0]!.expect).toBe("none");
  });
});
