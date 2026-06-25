import { describe, expect, test } from "bun:test";
import {
  validateSuite,
  validateTiers,
  validateMode,
  unknownExpectations,
  noneExpectationsUnderSelect,
} from "../src/intents.ts";
import type { Intent } from "../src/types.ts";

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

  test("parses an optional tiers map", () => {
    const s = validateSuite({
      tiers: { remove_account: "destructive", get_holdings: "read" },
      intents: [{ query: "a", expect: "get_holdings" }],
    });
    expect(s.tiers).toEqual({ remove_account: "destructive", get_holdings: "read" });
  });

  test("a suite with no tiers leaves it undefined", () => {
    const s = validateSuite({ intents: [{ query: "a", expect: "t" }] });
    expect(s.tiers).toBeUndefined();
  });

  test("parses an optional mode", () => {
    const s = validateSuite({ mode: "select", intents: [{ query: "a", expect: "t" }] });
    expect(s.mode).toBe("select");
  });

  test("a suite with no mode leaves it undefined (host is the default at use)", () => {
    const s = validateSuite({ intents: [{ query: "a", expect: "t" }] });
    expect(s.mode).toBeUndefined();
  });

  test("rejects an unknown mode", () => {
    expect(() => validateSuite({ mode: "classify", intents: [{ query: "a", expect: "t" }] })).toThrow(
      /must be one of/,
    );
  });
});

describe("validateMode", () => {
  test("accepts host and select", () => {
    expect(validateMode("host")).toBe("host");
    expect(validateMode("select")).toBe("select");
  });

  test("returns undefined for missing", () => {
    expect(validateMode(undefined)).toBeUndefined();
    expect(validateMode(null)).toBeUndefined();
  });

  test("rejects anything else", () => {
    expect(() => validateMode("auto")).toThrow(/must be one of/);
    expect(() => validateMode(2)).toThrow(/must be one of/);
  });
});

describe("noneExpectationsUnderSelect", () => {
  const intents: Intent[] = [
    { id: "a", query: "x", expect: "web_researcher" },
    { id: "b", query: "y", expect: "none" },
    { id: "c", query: "z", expect: "none" },
  ];

  test("flags none-expectations in select mode (a forced pick can't decline)", () => {
    expect(noneExpectationsUnderSelect(intents, "select")).toEqual(["b", "c"]);
  });

  test("never flags in host mode (none is valid there)", () => {
    expect(noneExpectationsUnderSelect(intents, "host")).toEqual([]);
  });
});

describe("validateTiers", () => {
  test("accepts valid levels and globs", () => {
    expect(validateTiers({ a: "read", "b_*": "write" })).toEqual({ a: "read", "b_*": "write" });
  });

  test("returns undefined for missing/empty maps", () => {
    expect(validateTiers(undefined)).toBeUndefined();
    expect(validateTiers({})).toBeUndefined();
  });

  test("rejects an unknown tier", () => {
    expect(() => validateTiers({ a: "admin" })).toThrow(/must be one of/);
  });

  test("rejects a non-object", () => {
    expect(() => validateTiers(["read"])).toThrow(/must be a map/);
  });
});

describe("unknownExpectations", () => {
  const intents: Intent[] = [
    { id: "ok", query: "a", expect: "get_holdings" },
    { id: "typo", query: "b", expect: "get_holdigns" }, // misspelled
    { id: "nowhere", query: "c", expect: "none" }, // sentinel, always allowed
  ];
  const tools = ["get_holdings", "list_accounts"];

  test("flags an intent expecting a tool the server doesn't expose", () => {
    expect(unknownExpectations(intents, tools)).toEqual([{ id: "typo", expect: "get_holdigns" }]);
  });

  test("never flags the `none` sentinel", () => {
    expect(unknownExpectations([{ id: "x", query: "q", expect: "none" }], [])).toEqual([]);
  });

  test("empty when every expectation matches a real tool", () => {
    expect(unknownExpectations([{ id: "x", query: "q", expect: "list_accounts" }], tools)).toEqual([]);
  });
});
