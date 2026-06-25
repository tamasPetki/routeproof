// Regression mode: pin the current routing as a baseline, then fail CI when a
// later run drifts away from it. The whole reason this mode exists: every
// description edit can silently re-route queries you weren't thinking about,
// and nobody writes a test for "does the model still pick the right tool?"
//
// Routing is nondeterministic, so "drift" can NOT mean "a number changed" —
// that would trip on sample noise every run. It means one of two real things:
//   1. a route that used to PASS now FAILS               (broke)
//   2. a still-passing route's confidence fell past a band (destabilized)
// A pre-existing failure you knowingly baselined is NOT drift — the gate fires
// only when reality gets worse than the line you pinned.

import type { EvalReport, IntentResult, RouteMode } from "./types.ts";
import { escalationSection } from "./report.ts";

/** One intent's pinned routing outcome. */
export interface BaselineEntry {
  expect: string;
  pick: string | null;
  pass: boolean;
  confidence: number;
}

export interface Baseline {
  /** Format version, so a later change can migrate old baseline files. */
  version: 1;
  /** The model the baseline was pinned on — comparing across models is meaningless. */
  model: string;
  /** Routing mode the baseline was pinned in — a select pin vs a host run is noise. */
  mode: RouteMode;
  samplesPerIntent: number;
  minConfidence: number;
  /** intent.id -> pinned outcome */
  intents: Record<string, BaselineEntry>;
}

export type DriftKind =
  | "broke" // was pass, now fail — hard regression
  | "destabilized" // still pass, confidence dropped past tolerance — soft regression
  | "fixed" // was fail, now pass — improvement
  | "stabilized" // still pass, confidence rose past tolerance — improvement
  | "added" // intent not present in the baseline
  | "removed" // intent in the baseline, gone from the current suite
  | "unchanged";

export interface IntentDrift {
  id: string;
  kind: DriftKind;
  before?: BaselineEntry;
  after?: { pick: string | null; pass: boolean; confidence: number; expect: string };
}

export interface RegressionReport {
  drifts: IntentDrift[];
  /** broke + destabilized — these fail the gate. */
  regressions: IntentDrift[];
  /** fixed + stabilized — good news, never fails the gate. */
  improvements: IntentDrift[];
  added: IntentDrift[];
  removed: IntentDrift[];
  /** Intents whose `expect` changed since the baseline — the pin is stale for them. */
  respecified: IntentDrift[];
  /** How many current intents had a baseline entry to compare against. */
  compared: number;
  /** True iff there is at least one regression. The CI exit condition. */
  hasRegression: boolean;
  /**
   * True iff the current suite dropped intents the baseline carried (`removed`).
   * A *coverage* regression, distinct from a routing one: routing can now
   * silently re-route on those intents undetected, because they aren't tested
   * anymore. Gated only when the caller opts in (`--fail-on-coverage-drop`),
   * since deleting a tool legitimately removes its intents.
   */
  hasCoverageDrop: boolean;
  /** Set when the baseline was pinned on a different model than this run. */
  modelMismatch?: { baseline: string; current: string };
  /** Set when the baseline was pinned in a different routing mode than this run. */
  modeMismatch?: { baseline: RouteMode; current: RouteMode };
}

function round(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Snapshot an eval report into a pinned baseline. Pure. */
export function toBaseline(report: EvalReport): Baseline {
  const intents: Record<string, BaselineEntry> = {};
  for (const r of report.results) {
    intents[r.intent.id] = {
      expect: r.intent.expect,
      pick: r.pick,
      pass: r.pass,
      confidence: round(r.confidence),
    };
  }
  return {
    version: 1,
    model: report.model,
    mode: report.mode ?? "host",
    samplesPerIntent: report.samplesPerIntent,
    minConfidence: report.minConfidence ?? 0.8,
    intents,
  };
}

/** Validate an unknown blob (parsed JSON) into a Baseline. Pure — unit-testable. */
export function parseBaseline(data: unknown, source = "<baseline>"): Baseline {
  if (!data || typeof data !== "object") {
    throw new Error(`${source}: baseline is not an object`);
  }
  const obj = data as Record<string, unknown>;
  if (obj.version !== 1) {
    throw new Error(`${source}: unsupported baseline version ${String(obj.version)} (expected 1)`);
  }
  if (!obj.intents || typeof obj.intents !== "object") {
    throw new Error(`${source}: baseline is missing an 'intents' map`);
  }
  const intents: Record<string, BaselineEntry> = {};
  for (const [id, raw] of Object.entries(obj.intents as Record<string, unknown>)) {
    const e = (raw ?? {}) as Record<string, unknown>;
    if (typeof e.pass !== "boolean" || typeof e.confidence !== "number") {
      throw new Error(`${source}: baseline intent '${id}' is malformed (need pass + confidence)`);
    }
    intents[id] = {
      expect: typeof e.expect === "string" ? e.expect : "",
      pick: typeof e.pick === "string" ? e.pick : null,
      pass: e.pass,
      confidence: e.confidence,
    };
  }
  return {
    version: 1,
    model: typeof obj.model === "string" ? obj.model : "unknown",
    // Baselines pinned before `mode` existed were all host-mode — default to it.
    mode: obj.mode === "select" ? "select" : "host",
    samplesPerIntent: typeof obj.samplesPerIntent === "number" ? obj.samplesPerIntent : 0,
    minConfidence: typeof obj.minConfidence === "number" ? obj.minConfidence : 0.8,
    intents,
  };
}

/**
 * Compare a fresh run against a pinned baseline. `tolerance` is the confidence
 * band (default 0.2) that sample noise is allowed to wander inside without
 * counting as drift — only a drop bigger than this destabilizes a route.
 */
export function compareToBaseline(
  baseline: Baseline,
  report: EvalReport,
  tolerance = 0.2,
): RegressionReport {
  const drifts: IntentDrift[] = [];
  const respecified: IntentDrift[] = [];
  const seen = new Set<string>();
  let compared = 0;

  for (const r of report.results) {
    seen.add(r.intent.id);
    const before = baseline.intents[r.intent.id];
    const after = { pick: r.pick, pass: r.pass, confidence: round(r.confidence), expect: r.intent.expect };
    if (!before) {
      drifts.push({ id: r.intent.id, kind: "added", after });
      continue;
    }
    compared++;
    // The intent's expected tool was edited since the pin — the baseline no
    // longer describes the same assertion, so a pass/pass "unchanged" would be
    // misleading. Surface it (informational, never gates) so the user re-pins.
    if (before.expect !== after.expect) {
      respecified.push({ id: r.intent.id, kind: "unchanged", before, after });
    }
    let kind: DriftKind = "unchanged";
    if (before.pass && !after.pass) kind = "broke";
    else if (!before.pass && after.pass) kind = "fixed";
    else if (before.pass && after.pass) {
      // Tolerance is a band noise may wander inside; only a drop STRICTLY bigger
      // than it is drift. With 5 samples a 1.0->0.8 wobble is exactly the band.
      const delta = after.confidence - before.confidence;
      if (delta < -tolerance) kind = "destabilized";
      else if (delta > tolerance) kind = "stabilized";
    }
    drifts.push({ id: r.intent.id, kind, before, after });
  }

  for (const [id, before] of Object.entries(baseline.intents)) {
    if (!seen.has(id)) drifts.push({ id, kind: "removed", before });
  }

  const regressions = drifts.filter((d) => d.kind === "broke" || d.kind === "destabilized");
  const improvements = drifts.filter((d) => d.kind === "fixed" || d.kind === "stabilized");
  const added = drifts.filter((d) => d.kind === "added");
  const removed = drifts.filter((d) => d.kind === "removed");

  const report_: RegressionReport = {
    drifts,
    regressions,
    improvements,
    added,
    removed,
    respecified,
    compared,
    hasRegression: regressions.length > 0,
    hasCoverageDrop: removed.length > 0,
  };
  if (baseline.model !== report.model) {
    report_.modelMismatch = { baseline: baseline.model, current: report.model };
  }
  const currentMode: RouteMode = report.mode ?? "host";
  if (baseline.mode !== currentMode) {
    report_.modeMismatch = { baseline: baseline.mode, current: currentMode };
  }
  return report_;
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/** Render the regression comparison as CI-friendly markdown. */
export function regressionMarkdown(
  cmp: RegressionReport,
  opts: { failOnCoverageDrop?: boolean; failOnEscalation?: boolean; results?: IntentResult[] } = {},
): string {
  const lines: string[] = [];
  lines.push(`# routeproof — regression check`, "");

  if (cmp.modelMismatch) {
    lines.push(
      `> ⚠️ **Model mismatch:** baseline pinned on \`${cmp.modelMismatch.baseline}\`, this run used \`${cmp.modelMismatch.current}\`. Routing differs by model — re-pin the baseline on the same model you gate with, or this comparison is noise.`,
      "",
    );
  }

  if (cmp.modeMismatch) {
    lines.push(
      `> ⚠️ **Mode mismatch:** baseline pinned in \`${cmp.modeMismatch.baseline}\` mode, this run used \`${cmp.modeMismatch.current}\`. Forced-pick (select) and decline-allowed (host) routing aren't comparable — re-pin in the mode you gate with.`,
      "",
    );
  }

  // Coverage drop gates only when the caller opted in; otherwise it's a warning.
  const coverageGated = !!opts.failOnCoverageDrop && cmp.hasCoverageDrop;
  // A privilege escalation in the CURRENT run is a property of this run, not the
  // baseline diff — so it gates independent of drift, when opted in. Always shown.
  const escalations = (opts.results ?? []).filter((r) => r.escalation);
  const escalationGated = !!opts.failOnEscalation && escalations.length > 0;

  if (!cmp.hasRegression && !coverageGated && !escalationGated) {
    lines.push(`**✅ No routing regressions vs baseline.**`);
  } else {
    const parts: string[] = [];
    if (cmp.regressions.length) parts.push(`${cmp.regressions.length} routing regression(s)`);
    if (escalationGated) parts.push(`${escalations.length} privilege-escalating misroute(s)`);
    if (coverageGated) parts.push(`${cmp.removed.length} intent(s) dropped from coverage`);
    lines.push(`**❌ ${parts.join(" + ")} vs baseline.**`);
  }
  lines.push("");

  // Lead with escalations — the highest-severity finding, shown whether or not
  // it gates (a privilege-crossing route is worth seeing even if not opted into).
  const escLines = escalationSection(opts.results ?? []);
  if (escLines.length) {
    if (!escalationGated) {
      lines.push(
        `> ⚠️ A privilege-escalating misroute is present below. Pass \`--fail-on-escalation\` to gate CI on it (independent of drift).`,
        "",
      );
    }
    lines.push(...escLines, "");
  }

  if (cmp.regressions.length) {
    lines.push(`## Regressions (${cmp.regressions.length})`, "");
    for (const d of cmp.regressions) {
      const b = d.before!;
      const a = d.after!;
      if (d.kind === "broke") {
        lines.push(
          `- ❌ **${d.id}** broke — was routing to \`${b.pick ?? "none"}\` (${pct(b.confidence)}, passing), now \`${a.pick ?? "none"}\` (${pct(a.confidence)}). Expected \`${a.expect}\`.`,
        );
      } else {
        lines.push(
          `- ⚠️ **${d.id}** destabilized — still routes to \`${a.pick ?? "none"}\`, but confidence fell ${pct(b.confidence)} → ${pct(a.confidence)}.`,
        );
      }
    }
    lines.push("");
  }

  if (cmp.improvements.length) {
    lines.push(`## Improvements (${cmp.improvements.length})`, "");
    for (const d of cmp.improvements) {
      const b = d.before!;
      const a = d.after!;
      if (d.kind === "fixed") {
        lines.push(
          `- ✅ **${d.id}** fixed — now routes to \`${a.pick ?? "none"}\` (${pct(a.confidence)}), was failing (\`${b.pick ?? "none"}\`).`,
        );
      } else {
        lines.push(
          `- ✅ **${d.id}** stabilized — confidence rose ${pct(b.confidence)} → ${pct(a.confidence)}.`,
        );
      }
    }
    lines.push("");
  }

  // Coverage drop — promoted from a buried footnote to a real section. A
  // shrinking intent set is "the failure that passes every test": routing can
  // silently re-route on a dropped intent because nothing tests it anymore.
  if (cmp.removed.length) {
    const icon = coverageGated ? "❌" : "⚠️";
    lines.push(`## ${icon} Coverage drop (${cmp.removed.length})`, "");
    lines.push(
      coverageGated
        ? `These intents were in the baseline but are gone from the current suite. A shrinking intent set silently narrows what regression mode can catch — the failure that passes every other test — so it is gated here.`
        : `These intents were in the baseline but are gone from the current suite, so routing can now silently regress on them with nothing to catch it. Pass \`--fail-on-coverage-drop\` to gate this (skip it when you removed a tool on purpose).`,
      "",
    );
    for (const d of cmp.removed) {
      lines.push(`- ${icon} **${d.id}** — pinned (expected \`${d.before?.expect ?? "?"}\`), no longer in the suite.`);
    }
    lines.push("");
  }

  if (cmp.added.length) {
    lines.push(`_${cmp.added.length} new intent(s) not in baseline: ${cmp.added.map((d) => d.id).join(", ")} (run with \`--save-baseline\` to pin them)._`, "");
  }
  if (cmp.respecified.length) {
    lines.push(`_${cmp.respecified.length} intent(s) changed their expected tool since the baseline: ${cmp.respecified.map((d) => d.id).join(", ")} — re-pin to compare against the new expectation._`, "");
  }

  return lines.join("\n") + "\n";
}
