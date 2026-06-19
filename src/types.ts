// Core types for routeproof — MCP tool-routing evaluation.

/** A tool exactly as an AI host sees it: name, description, input schema. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: unknown;
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
  intents: Intent[];
}

/** One model sample for one intent — what the host's-eye model decided. */
export interface RouteSample {
  /** Tool name the model chose, or null for "no tool fits". */
  picked: string | null;
  /** The model's stated reason (why none, or — later — why this one). */
  reason: string;
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
}

export interface EvalReport {
  server: string;
  model: string;
  samplesPerIntent: number;
  tools: ToolSpec[];
  results: IntentResult[];
  score: { passed: number; total: number };
}
