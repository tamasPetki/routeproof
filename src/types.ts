// Core types for routeproof — MCP tool-routing evaluation.

/** A tool exactly as an AI host sees it: name, description, input schema. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: unknown;
}

/**
 * Capability level of a tool, used to score a misroute's *severity*, not just
 * count it. A query that should read but grabs a write/destructive tool is a
 * worse failure than a read→read mix-up: a perfect-looking routing score can
 * still hide a privilege escalation. `read` < `write` < `destructive`.
 */
export type Tier = "read" | "write" | "destructive";

/** A misroute that crossed a capability boundary: expected `from`, got `to`. */
export interface Escalation {
  /** Expected tier, or "none" when the intent asserted no tool should answer. */
  from: Tier | "none";
  /** Tier of the tool the model actually grabbed (always higher than `from`). */
  to: Tier;
}

/** One thing a user might ask, and the tool that should handle it. */
export interface Intent {
  id: string;
  query: string;
  /** Expected tool name. Use "none" to assert that NO tool should be called. */
  expect: string;
  /** Optional human note; ignored by the evaluator. */
  note?: string;
}

export interface IntentSuite {
  /** Optional default server command, overridable on the CLI. */
  server?: string;
  /**
   * Optional map of tool name (or `*` glob, e.g. `portfolio_write_*`) → tier.
   * Tools left unlisted default to `read`. Used to flag privilege-escalating
   * misroutes — a read query that grabbed a write/destructive tool.
   */
  tiers?: Record<string, Tier>;
  intents: Intent[];
}

/** One model sample for one intent — what the host's-eye model decided. */
export interface RouteSample {
  /** Tool name the model chose, or null for "no tool fits". */
  picked: string | null;
  /** The model's stated reason (why none, or — later — why this one). */
  reason: string;
}

/** Why a misroute happened, and the concrete edit that would fix it. */
export interface Diagnosis {
  why: string;
  suggestedFix: string;
}

/** Aggregated result for one intent across N samples. */
export interface IntentResult {
  intent: Intent;
  samples: RouteSample[];
  /** Most frequent pick across samples. */
  pick: string | null;
  /** Fraction of samples that chose `pick` (0..1). */
  confidence: number;
  /** True if the majority pick matches intent.expect. */
  pass: boolean;
  /** Passed, but below the confidence threshold — routing is a coin flip. */
  flaky?: boolean;
  /** Populated for misroutes AND flaky passes: why it went wrong + how to fix it. */
  diagnosis?: Diagnosis;
  /** Set when this misroute grabbed a higher-privilege tool than expected. */
  escalation?: Escalation;
}

export interface EvalReport {
  server: string;
  model: string;
  samplesPerIntent: number;
  /** Confidence below which a passing intent is flagged as flaky (0..1). */
  minConfidence?: number;
  /** Tool→tier map in effect, so the report can name the capability boundaries. */
  tiers?: Record<string, Tier>;
  tools: ToolSpec[];
  results: IntentResult[];
  score: { passed: number; total: number };
}
