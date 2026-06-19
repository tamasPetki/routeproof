// Load and validate an intent suite (.json or .yaml).
// An intent suite is the contract: "these are the things users ask, and the
// tool each one SHOULD route to." routeproof checks reality against it.

import { readFileSync } from "node:fs";
import type { IntentSuite, Intent } from "./types.ts";

export async function loadIntentSuite(path: string): Promise<IntentSuite> {
  const raw = readFileSync(path, "utf8");
  const data =
    path.endsWith(".yaml") || path.endsWith(".yml")
      ? await parseYaml(raw)
      : JSON.parse(raw);
  return validateSuite(data, path);
}

async function parseYaml(raw: string): Promise<unknown> {
  try {
    const { parse } = await import("yaml");
    return parse(raw);
  } catch {
    throw new Error(
      "YAML intent files need the optional `yaml` package — run `npm i yaml`, or use a .json suite.",
    );
  }
}

/** Pure validator — exported so it can be unit-tested without touching disk. */
export function validateSuite(data: unknown, source = "<intents>"): IntentSuite {
  if (!data || typeof data !== "object") {
    throw new Error(`${source}: intent file is not an object`);
  }
  const obj = data as Record<string, unknown>;
  if (!Array.isArray(obj.intents) || obj.intents.length === 0) {
    throw new Error(`${source}: missing a non-empty 'intents' array`);
  }
  const seen = new Set<string>();
  const intents: Intent[] = obj.intents.map((raw, i) => {
    const it = (raw ?? {}) as Record<string, unknown>;
    if (typeof it.query !== "string" || !it.query.trim()) {
      throw new Error(`${source}: intent #${i + 1} is missing a 'query' string`);
    }
    if (typeof it.expect !== "string" || !it.expect.trim()) {
      throw new Error(
        `${source}: intent #${i + 1} ("${it.query}") is missing an 'expect' tool name`,
      );
    }
    const id =
      typeof it.id === "string" && it.id.trim() ? it.id.trim() : `intent-${i + 1}`;
    if (seen.has(id)) throw new Error(`${source}: duplicate intent id '${id}'`);
    seen.add(id);
    return {
      id,
      query: it.query,
      expect: it.expect,
      note: typeof it.note === "string" ? it.note : undefined,
    };
  });
  return {
    server: typeof obj.server === "string" ? obj.server : undefined,
    intents,
  };
}
