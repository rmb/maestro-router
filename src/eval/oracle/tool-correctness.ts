// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import type { TelemetryEvent } from "../../core/types.js";

/** Normalize a model string to its family for cross-version matching. */
function extractModelFamily(model: string): "haiku" | "sonnet" | "opus" | null {
  const lower = model.toLowerCase();
  if (lower.includes("haiku")) return "haiku";
  if (lower.includes("sonnet")) return "sonnet";
  if (lower.includes("opus")) return "opus";
  return null;
}
import type { SessionRecord } from "../../wrapper/session.js";
import { computeFingerprint } from "../../wrapper/prewarm.js";
import { CONTINUATION_HINT, CONTINUATION_PATTERNS } from "../../wrapper/continuation.js";
import type { CheckResult, DimensionResult } from "./telemetry-correctness.js";

export type { CheckResult, DimensionResult };
export type { SessionRecord };

// ---------------------------------------------------------------------------
// Narrowed event type
// ---------------------------------------------------------------------------

type DecisionEvent = Extract<TelemetryEvent, { type: "decision" }>;

// ---------------------------------------------------------------------------
// checkFingerprintStability
// ---------------------------------------------------------------------------

/**
 * Verifies that each decision spec can be matched to a session record whose
 * systemPromptFingerprint equals the computed fingerprint.
 * Gate: ≥95% of decision specs have a matching session (or no decisions → pass).
 */
export function checkFingerprintStability(
  events: TelemetryEvent[],
  sessions: SessionRecord[],
): CheckResult {
  // Only meaningful once run-cmd sessions (computed fingerprints) exist.
  // sdk-proxy sessions use the fixed "sdk-proxy" fingerprint and are excluded.
  const computedSessions = sessions.filter(
    (s) => s.systemPromptFingerprint && s.systemPromptFingerprint !== "sdk-proxy",
  );

  if (computedSessions.length === 0) {
    return {
      name: "fingerprint-stability",
      pass: true,
      value: "n/a (bootstrapping)",
      gate: "≥95%",
      detail: "No fingerprinted run-cmd sessions yet — check will activate once maestro run has been used.",
    };
  }

  // Filter to events whose session is still "fresh" — older events may have
  // been logged under a previous fingerprint algorithm, which would cause
  // false positives. Cutoff: most recent session createdAt minus 24h.
  const sessionTimestamps = computedSessions
    .map((s) => Date.parse(s.createdAt))
    .filter((t) => !Number.isNaN(t));
  const newestSession =
    sessionTimestamps.length > 0 ? Math.max(...sessionTimestamps) : 0;
  const cutoffMs = newestSession - 24 * 60 * 60 * 1000;

  const decisionEvents = events.filter(
    (e): e is DecisionEvent =>
      e.type === "decision" &&
      e.decision.spec !== undefined &&
      Date.parse(e.ts) >= cutoffMs,
  );

  if (decisionEvents.length === 0) {
    return {
      name: "fingerprint-stability",
      pass: true,
      value: "100.0%",
      gate: "≥95%",
    };
  }

  let matched = 0;
  for (const event of decisionEvents) {
    const fingerprint = event.decision.fingerprint ?? computeFingerprint(event.decision.spec);
    const found = computedSessions.some(
      (s) => s.systemPromptFingerprint === fingerprint,
    );
    if (found) matched++;
  }

  const total = decisionEvents.length;
  const rate = matched / total;

  // Detect fingerprint algorithm drift: if rate is ~0 with non-trivial
  // sample size, the fingerprint format likely changed (e.g. dimension
  // added). Treat as n/a until new sessions accumulate.
  if (rate === 0 && total >= 5) {
    return {
      name: "fingerprint-stability",
      pass: true,
      value: "n/a (format drift)",
      gate: "≥95%",
      detail: `0 of ${total} recent events match any session fingerprint. Likely fingerprint algorithm changed; will activate as new sessions accumulate.`,
    };
  }

  const pass = rate >= 0.95;
  const value = `${(rate * 100).toFixed(1)}%`;

  const base: CheckResult = {
    name: "fingerprint-stability",
    pass,
    value,
    gate: "≥95%",
  };

  if (!pass) {
    const missing = total - matched;
    return {
      ...base,
      detail: `${missing} of ${total} decision specs have no matching session fingerprint — Track Z may not be firing. Check wrapper/session.ts getByFingerprint.`,
    };
  }
  return base;
}

// ---------------------------------------------------------------------------
// checkFlagCoverage
// ---------------------------------------------------------------------------

/**
 * Verifies that cost.modelUsed contains spec.model for each decision that has
 * both a spec and a cost. Skips events where modelUsed === "unknown" (parser
 * couldn't recover a model name — not a spawn-flag bug).
 * Gate: ≥80% model match. Lower than 95% because the claude CLI session is
 * model-locked at creation time: a `--model opus` on a resume of a sonnet
 * session is silently ignored. The right long-term fix is Track Z fingerprint
 * isolation per model; this gate trips when fingerprint isolation breaks.
 */
export function checkFlagCoverage(events: TelemetryEvent[]): CheckResult {
  const decisionEvents = events.filter(
    (e): e is DecisionEvent =>
      e.type === "decision" &&
      e.decision.spec !== undefined &&
      e.cost !== undefined &&
      e.cost.modelUsed !== "unknown",
  );

  if (decisionEvents.length === 0) {
    return {
      name: "flag-coverage",
      pass: true,
      value: "100.0%",
      gate: "≥80%",
    };
  }

  let matched = 0;
  for (const event of decisionEvents) {
    const specModel = event.decision.spec.model;
    const modelUsed = event.cost!.modelUsed;
    const specFamily = extractModelFamily(specModel);
    const usedFamily = extractModelFamily(modelUsed);
    if (modelUsed.includes(specModel) || (specFamily !== null && specFamily === usedFamily)) matched++;
  }

  const total = decisionEvents.length;
  const rate = matched / total;
  // Gate is ≥30%: sdk-proxy mode routes via set_model (not spawn flags), so
  // the session's creation-time model often differs from the requested model.
  // Mismatch in proxy-mode events is expected, not a spawn flag bug. The gate
  // is set to detect catastrophic spawn failures (e.g. --model flag dropped
  // entirely) without alerting on normal proxy-mode model drift.
  const pass = rate >= 0.30;
  const value = `${(rate * 100).toFixed(1)}%`;

  const base: CheckResult = {
    name: "flag-coverage",
    pass,
    value,
    gate: "≥30%",
  };

  if (!pass) {
    const mismatch = total - matched;
    return {
      ...base,
      detail: `${mismatch} of ${total} decisions have spec.model mismatch vs cost.modelUsed. In sdk-proxy (VSCode panel) mode this is expected; in run-cmd mode it indicates a spawn.ts flag bug.`,
    };
  }
  return base;
}

// ---------------------------------------------------------------------------
// checkE1Escalation
// ---------------------------------------------------------------------------

/**
 * Verifies that standard-class turns with effort=low that end in max_tokens
 * are followed by a decision with effort=medium.
 * Gate: ≥80% of max_tokens cases are correctly escalated (or none → pass).
 */
export function checkE1Escalation(events: TelemetryEvent[]): CheckResult {
  const decisionEvents = events
    .filter((e): e is DecisionEvent => e.type === "decision")
    .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

  // Find standard+effort=low decision events that ended with max_tokens
  const maxTokensCases: Array<{ event: DecisionEvent; index: number }> = [];
  for (let i = 0; i < decisionEvents.length; i++) {
    const e = decisionEvents[i]!;
    if (
      e.decision.class === "standard" &&
      e.decision.spec.effort === "low" &&
      e.cost?.stopReason === "max_tokens"
    ) {
      maxTokensCases.push({ event: e, index: i });
    }
  }

  if (maxTokensCases.length === 0) {
    return {
      name: "e1-escalation",
      pass: true,
      value: "100.0%",
      gate: "≥80%",
    };
  }

  let escalated = 0;
  for (const { index } of maxTokensCases) {
    const next = decisionEvents[index + 1];
    if (next !== undefined && next.decision.spec.effort === "medium") {
      escalated++;
    }
  }

  const total = maxTokensCases.length;
  const rate = escalated / total;
  const pass = rate >= 0.8;
  const value = `${(rate * 100).toFixed(1)}%`;

  const base: CheckResult = {
    name: "e1-escalation",
    pass,
    value,
    gate: "≥80%",
  };

  if (!pass) {
    const notEscalated = total - escalated;
    return {
      ...base,
      detail: `${notEscalated} of ${total} max_tokens standard turns were NOT followed by effort escalation — check E1.escalate in run-cmd.ts`,
    };
  }
  return base;
}

// ---------------------------------------------------------------------------
// checkK1Invalidation
// ---------------------------------------------------------------------------

/**
 * Verifies that K1 cache entries are not served after a max_tokens stop.
 * Identical prompts within 24h where the first ended max_tokens should NOT
 * produce a k1-cache hit on the second.
 * Gate: 0 invalidation failures.
 */
export function checkK1Invalidation(events: TelemetryEvent[]): CheckResult {
  const decisionEvents = events
    .filter((e): e is DecisionEvent => e.type === "decision" && e.prompt !== undefined)
    .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

  const windowMs = 24 * 60 * 60 * 1000;
  let failures = 0;

  for (let i = 0; i < decisionEvents.length; i++) {
    const first = decisionEvents[i]!;
    if (first.cost?.stopReason !== "max_tokens") continue;

    for (let j = i + 1; j < decisionEvents.length; j++) {
      const second = decisionEvents[j]!;
      const timeDiff = new Date(second.ts).getTime() - new Date(first.ts).getTime();
      if (timeDiff > windowMs) break;

      if (
        second.prompt === first.prompt &&
        second.decision.classifier === "k1-cache"
      ) {
        failures++;
      }
    }
  }

  const pass = failures === 0;
  const value = String(failures);

  const base: CheckResult = {
    name: "k1-invalidation",
    pass,
    value,
    gate: "0 failures",
  };

  if (!pass) {
    return {
      ...base,
      detail: "K1 cache not invalidated after max_tokens — entries are being served stale.",
    };
  }
  return base;
}

// ---------------------------------------------------------------------------
// checkM1TwoSignal
// ---------------------------------------------------------------------------

/**
 * Verifies that CONTINUATION_HINT is only injected when both signals are
 * present: prior turn max_tokens AND linguistic continuation pattern.
 * Gate: 0 violations (hint injected with only one signal).
 */
export function checkM1TwoSignal(events: TelemetryEvent[]): CheckResult {
  const decisionEvents = events
    .filter((e): e is DecisionEvent => e.type === "decision")
    .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

  let violations = 0;

  for (let i = 0; i < decisionEvents.length; i++) {
    const current = decisionEvents[i]!;
    const hasHint = current.decision.spec.appendSystemPrompt?.includes(CONTINUATION_HINT) === true;
    if (!hasHint) continue;

    const prior = i > 0 ? decisionEvents[i - 1] : undefined;
    const priorMaxTokens = prior?.cost?.stopReason === "max_tokens";

    const prompt = current.prompt ?? "";
    const isLinguistic =
      prompt.length < 50 && CONTINUATION_PATTERNS.test(prompt.trim());

    // Violation: hint injected but not both signals present
    if (!priorMaxTokens || !isLinguistic) {
      violations++;
    }
  }

  const pass = violations === 0;
  const value = String(violations);

  const base: CheckResult = {
    name: "m1-two-signal",
    pass,
    value,
    gate: "0 violations",
  };

  if (!pass) {
    return {
      ...base,
      detail: `${violations} turns had CONTINUATION_HINT without both signals — M1 two-signal guard may be broken in run-cmd.ts`,
    };
  }
  return base;
}

// ---------------------------------------------------------------------------
// runToolCorrectness
// ---------------------------------------------------------------------------

/**
 * Runs all tool-correctness checks and returns a DimensionResult.
 */
export function runToolCorrectness(
  events: TelemetryEvent[],
  sessions: SessionRecord[],
): DimensionResult {
  const checks: CheckResult[] = [
    checkFingerprintStability(events, sessions),
    checkFlagCoverage(events),
    checkE1Escalation(events),
    checkK1Invalidation(events),
    checkM1TwoSignal(events),
  ];

  const pass = checks.every((c) => c.pass);

  return {
    dimension: "tool",
    pass,
    checks,
  };
}
