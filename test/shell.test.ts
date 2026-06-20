import { describe, expect, test } from "bun:test";
import { tokenize } from "../src/shell.ts";

describe("tokenize", () => {
  test("splits a plain command on whitespace", () => {
    expect(tokenize("npx headless-tracker")).toEqual(["npx", "headless-tracker"]);
  });

  test("collapses runs of whitespace and trims edges", () => {
    expect(tokenize("  node   server.js  ")).toEqual(["node", "server.js"]);
  });

  test("keeps a double-quoted argument with spaces as one token", () => {
    expect(tokenize('npx server --flag "a b c"')).toEqual(["npx", "server", "--flag", "a b c"]);
  });

  test("keeps a single-quoted argument with spaces as one token", () => {
    expect(tokenize("server --json '{\"k\": 1}'")).toEqual(["server", "--json", '{"k": 1}']);
  });

  test("handles escaped quotes inside double quotes", () => {
    expect(tokenize('server "a \\"b\\" c"')).toEqual(["server", 'a "b" c']);
  });

  test("preserves an explicitly empty quoted token", () => {
    expect(tokenize('server ""')).toEqual(["server", ""]);
  });

  test("throws on an unbalanced quote", () => {
    expect(() => tokenize('server "oops')).toThrow(/[Uu]nbalanced/);
  });
});
