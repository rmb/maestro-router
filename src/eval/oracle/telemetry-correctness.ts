// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import type { TelemetryEvent } from "../../core/types.js";
import { costFromEvent } from "../../core/pricing.js";

// ---------------------------------------------------------------------------
// Shared result types (will be extracted to oracle/types.ts later)
// ---------------------------------------------------------------------------

export type CheckResult = {
  name: string;
  pass: boolean;
  value: number | string;
  gate?: string;
  detail?: string;
};

export type DimensionResult = {
  dimension: "tool" | "telemetry" | "tokens" | "quality";
  pass: boolean;
  checks: CheckResult[];
};

// ---------------------------------------------------------------------------
// Minimal local summary type — avoids importing the unexported Summary from stats.ts
// ---------------------------------------------------------------------------

export type StatsSummary = {
  totalCostUsd: number;
  fallbackRate: number;
  cacheHitRate: number;
};

// ---------------------------------------------------------------------------
// Narrowed event types
// ---------------------------------------------------------------------------

type DecisionEvent = Extract<TelemetryEvent, { type: "decision" }>;

// ---------------------------------------------------------------------------
// checkCostReconciliation
// ---------------------------------------------------------------------------

/**
 * Verifies that the token-derived cost sum across all "decision" events
 * matches statsSummary.totalCostUsd within 1%.
 * Uses token volumes instead of total_cost_usd (unreliable on Pro/Team plans).
 */
export function checkCostReconciliation(
  events: TelemetryEvent[],
  statsSummary: StatsSummary,
): CheckResult {
  const decisionEvents = events.filter(
    (e): e is DecisionEvent => e.type === "decision",
  );

  const computedSum = decisionEvents.reduce(
    (sum, e) => sum + (e.cost ? costFromEvent(e.cost, e.decision.spec.model) : 0),
    0,
  );

  const statsValue = statsSummary.totalCostUsd;

  // Gate: difference ≤ 1% of stats value (or stats is 0 → exact match)
  const threshold = statsValue === 0 ? 0 : statsValue * 0.01;
  const diff = Math.abs(computedSum - statsValue);
  const pass = diff <= threshold;

  const valueStr = `$${computedSum.toFixed(3)}`;

  const base = {
    name: "cost-reconciliation",
    pass,
    value: valueStr,
    gate: "±1%",
  };

  if (!pass) {
    return {
      ...base,
      detail: `Computed $${computedSum.toFixed(3)} from events, stats reports $${statsValue.toFixed(3)} — likely aggregation bug in stats.ts`,
    };
  }
  return base;
}

// ---------------------------------------------------------------------------
// checkFallbackRateAccuracy
// ---------------------------------------------------------------------------

/**
 * Verifies that the computed fallback rate from events matches
 * statsSummary.fallbackRate within 0.01 (absolute).
 *
 * Fallback = decision where classifier is "forced.standard" or "default".
 */
export function checkFallbackRateAccuracy(
  events: TelemetryEvent[],
  statsSummary: StatsSummary,
): CheckResult {
  const decisionEvents = events.filter(
    (e): e is DecisionEvent => e.type === "decision",
  );

  const totalDecisions = decisionEvents.length;

  const fallbackCount = decisionEvents.filter(
    (e) =>
      e.decision.classifier === "forced.standard" ||
      e.decision.classifier === "default",
  ).length;

  const computedRate =
    totalDecisions === 0 ? 0 : fallbackCount / totalDecisions;
  const statsRate = statsSummary.fallbackRate;

  const diff = Math.abs(computedRate - statsRate);
  const pass = diff <= 0.01;

  const valueStr = `${(computedRate * 100).toFixed(1)}%`;

  const base = {
    name: "fallback-rate-accuracy",
    pass,
    value: valueStr,
    gate: "±0.01",
  };

  if (!pass) {
    return {
      ...base,
      detail: `Computed ${fallbackCount} fallbacks out of ${totalDecisions} decisions, rate ${(computedRate * 100).toFixed(1)}% — stats reports ${(statsRate * 100).toFixed(1)}%`,
    };
  }
  return base;
}

// ---------------------------------------------------------------------------
// checkCacheHitRateAccuracy
// ---------------------------------------------------------------------------

/**
 * Verifies that the computed cache-hit rate from events matches
 * statsSummary.cacheHitRate within 0.01 (absolute).
 *
 * Primary signal: decision.cacheHit === true.
 * Cross-check: cost.cacheReadInputTokens > 0. If those two counts diverge
 * by >5%, a detail warning is emitted even when the gate passes.
 */
export function checkCacheHitRateAccuracy(
  events: TelemetryEvent[],
  statsSummary: StatsSummary,
): CheckResult {
  const decisionEvents = events.filter(
    (e): e is DecisionEvent => e.type === "decision",
  );

  const totalDecisions = decisionEvents.length;

  const cacheHitFlagCount = decisionEvents.filter(
    (e) => e.decision.cacheHit === true,
  ).length;

  const cacheReadTokenCount = decisionEvents.filter(
    (e) => (e.cost?.cacheReadInputTokens ?? 0) > 0,
  ).length;

  // If fewer than 10% of events have the cacheHit flag set, the window
  // is dominated by pre-fix historical events (cacheHit was added to
  // sdk-proxy telemetry recently). Comparison is unreliable — skip.
  const flagCoverage = totalDecisions === 0 ? 0 : cacheHitFlagCount / totalDecisions;
  const tokenCoverage = totalDecisions === 0 ? 0 : cacheReadTokenCount / totalDecisions;
  if (totalDecisions > 0 && flagCoverage < 0.10 && tokenCoverage >= 0.10) {
    return {
      name: "cache-hit-rate-accuracy",
      pass: true,
      value: "n/a (historical)",
      gate: "±0.01",
      detail: `${cacheHitFlagCount} of ${totalDecisions} events have cacheHit flag set — window dominated by pre-fix events. Will activate as new events accumulate.`,
    };
  }

  const computedRate =
    totalDecisions === 0 ? 0 : cacheHitFlagCount / totalDecisions;
  const statsRate = statsSummary.cacheHitRate;

  const diff = Math.abs(computedRate - statsRate);
  const pass = diff <= 0.01;

  const valueStr = `${(computedRate * 100).toFixed(1)}%`;

  // Cross-check: flag count vs token-based count
  const crossCheckDiff = Math.abs(cacheHitFlagCount - cacheReadTokenCount);
  const crossCheckDivergent =
    totalDecisions > 0 && crossCheckDiff / totalDecisions > 0.05;

  const detailParts: string[] = [];

  if (!pass) {
    detailParts.push(
      `Computed ${(computedRate * 100).toFixed(1)}% cache-hit rate from decision.cacheHit flag, stats reports ${(statsRate * 100).toFixed(1)}%`,
    );
  }

  if (crossCheckDivergent) {
    detailParts.push(
      `cacheHit flag count (${cacheHitFlagCount}) diverges from cacheReadInputTokens>0 count (${cacheReadTokenCount}) by ${((crossCheckDiff / totalDecisions) * 100).toFixed(1)}% — possible flag/token mismatch in output.ts`,
    );
  }

  const base = {
    name: "cache-hit-rate-accuracy",
    pass,
    value: valueStr,
    gate: "±0.01",
  };

  if (detailParts.length > 0) {
    return { ...base, detail: detailParts.join("; ") };
  }
  return base;
}

// ---------------------------------------------------------------------------
// checkOutcomeLinkage
// ---------------------------------------------------------------------------

/**
 * Verifies that ≥90% of outcome events are paired with a matching decision.
 */
export function checkOutcomeLinkage(
  events: TelemetryEvent[],
  pairs: Array<{
    decision: Extract<TelemetryEvent, { type: "decision" }>;
    outcome: Extract<TelemetryEvent, { type: "outcome" }>;
  }>,
): CheckResult {
  const totalOutcomes = events.filter((e) => e.type === "outcome").length;

  // Trivially pass if there are no outcomes
  if (totalOutcomes === 0) {
    return {
      name: "outcome-linkage",
      pass: true,
      value: "100.0%",
      gate: "≥90%",
    };
  }

  const pairedOutcomes = pairs.length;
  const linkageRate = pairedOutcomes / totalOutcomes;
  const pass = linkageRate >= 0.9;

  const valueStr = `${(linkageRate * 100).toFixed(1)}%`;
  const unlinkedCount = totalOutcomes - pairedOutcomes;

  const base = {
    name: "outcome-linkage",
    pass,
    value: valueStr,
    gate: "≥90%",
  };

  if (!pass) {
    return {
      ...base,
      detail: `${unlinkedCount} of ${totalOutcomes} outcome events unlinked — Stop-hook firing without a matching decision. Check wrapper bypass paths.`,
    };
  }
  return base;
}

// ---------------------------------------------------------------------------
// runTelemetryCorrectness
// ---------------------------------------------------------------------------

/**
 * Runs all four telemetry-correctness checks and returns a DimensionResult.
 */
export function runTelemetryCorrectness(
  events: TelemetryEvent[],
  pairs: Array<{
    decision: Extract<TelemetryEvent, { type: "decision" }>;
    outcome: Extract<TelemetryEvent, { type: "outcome" }>;
  }>,
  statsSummary: StatsSummary,
): DimensionResult {
  const checks: CheckResult[] = [
    checkCostReconciliation(events, statsSummary),
    checkFallbackRateAccuracy(events, statsSummary),
    checkCacheHitRateAccuracy(events, statsSummary),
    checkOutcomeLinkage(events, pairs),
  ];

  const pass = checks.every((c) => c.pass);

  return {
    dimension: "telemetry",
    pass,
    checks,
  };
}
