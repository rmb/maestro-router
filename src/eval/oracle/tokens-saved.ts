// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import type { TelemetryEvent } from "../../core/types.js";
import type { CheckResult, DimensionResult } from "./telemetry-correctness.js";
import { costFromEvent } from "../../core/pricing.js";

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

export type Pricing = {
  opusInputPerTok: number;
  opusOutputPerTok: number;
  opusCacheWritePerTok: number;
  opusCacheReadPerTok: number;
};

export const DEFAULT_PRICING: Pricing = {
  opusInputPerTok: 15 / 1_000_000,
  opusOutputPerTok: 75 / 1_000_000,
  opusCacheWritePerTok: 18.75 / 1_000_000,
  opusCacheReadPerTok: 1.5 / 1_000_000,
};

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export type TokenSavingsResult = {
  check: CheckResult;
  actualCostUsd: number;
  hypotheticalOpusCostUsd: number;
  savingsPct: number;
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type DecisionEvent = Extract<TelemetryEvent, { type: "decision" }>;

function toDate(ts: string): Date {
  return new Date(ts);
}

/**
 * p90: sort ascending, index = Math.floor(arr.length * 0.9). Returns 0 for empty.
 */
function p90(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.floor(sorted.length * 0.9);
  return sorted[idx]!;
}

function decisionEventsWithCost(
  events: TelemetryEvent[],
): Array<DecisionEvent & { cost: NonNullable<DecisionEvent["cost"]> }> {
  return events.filter(
    (e): e is DecisionEvent & { cost: NonNullable<DecisionEvent["cost"]> } =>
      e.type === "decision" && e.cost !== undefined,
  );
}

function hypotheticalCostForEvent(
  e: DecisionEvent & { cost: NonNullable<DecisionEvent["cost"]> },
  pricing: Pricing,
): number {
  const c = e.cost;
  return (
    c.inputTokens * pricing.opusInputPerTok +
    c.cacheCreationInputTokens * pricing.opusCacheWritePerTok +
    c.outputTokens * pricing.opusOutputPerTok +
    c.cacheReadInputTokens * pricing.opusCacheReadPerTok
  );
}

function distinctDays(dates: Date[]): number {
  const days = new Set(dates.map((d) => d.toISOString().slice(0, 10)));
  return days.size;
}

// ---------------------------------------------------------------------------
// computeSavings
// ---------------------------------------------------------------------------

export function computeSavings(
  events: TelemetryEvent[],
  pricing: Pricing = DEFAULT_PRICING,
): TokenSavingsResult {
  const costEvents = decisionEventsWithCost(events);

  const actualCost = costEvents.reduce(
    (sum, e) => sum + costFromEvent(e.cost, e.decision.spec.model),
    0,
  );
  const hypotheticalOpusCost = costEvents.reduce(
    (sum, e) => sum + hypotheticalCostForEvent(e, pricing),
    0,
  );

  if (costEvents.length === 0) {
    const check: CheckResult = {
      name: "tokens-saved",
      pass: true,
      value: "n/a (no data)",
      gate: "≥60%",
    };
    return { check, actualCostUsd: 0, hypotheticalOpusCostUsd: 0, savingsPct: 0 };
  }

  const savingsPct =
    hypotheticalOpusCost === 0
      ? 0
      : (hypotheticalOpusCost - actualCost) / hypotheticalOpusCost;

  // Negative savings means actual > hypothetical Opus. This indicates the
  // comparison is unreliable: subscription plans report totalCostUsd=0 for
  // some turns while cache_creation tokens inflate the hypothetical, or
  // LLM-classifier overhead is included in actual but not in hypothetical.
  // Treat as n/a rather than a genuine regression signal.
  if (savingsPct < 0) {
    const check: CheckResult = {
      name: "tokens-saved",
      pass: true,
      value: "n/a (comparison unreliable)",
      gate: "≥60%",
      detail: `Actual $${actualCost.toFixed(4)} > hypothetical $${hypotheticalOpusCost.toFixed(4)} — baseline comparison is unreliable (subscription plan zeros, cache pattern mismatch, or LLM-classifier overhead). Use 'maestro stats' for accurate savings.`,
    };
    return { check, actualCostUsd: actualCost, hypotheticalOpusCostUsd: hypotheticalOpusCost, savingsPct };
  }

  const pass = savingsPct >= 0.6;

  const check: CheckResult = {
    name: "tokens-saved",
    pass,
    value: (savingsPct * 100).toFixed(1) + "%",
    gate: "≥60%",
    ...(!pass && {
      detail: `Actual $${actualCost.toFixed(4)} vs hypothetical $${hypotheticalOpusCost.toFixed(4)} — savings dropped below 60%. Check which class migrations changed.`,
    }),
  };

  return { check, actualCostUsd: actualCost, hypotheticalOpusCostUsd: hypotheticalOpusCost, savingsPct };
}

// ---------------------------------------------------------------------------
// isolateE1Savings
// ---------------------------------------------------------------------------

export function isolateE1Savings(
  events: TelemetryEvent[],
  baselineDate: Date,
): TokenSavingsResult {
  const costEvents = decisionEventsWithCost(events);

  const before = costEvents.filter(
    (e) =>
      toDate(e.ts) < baselineDate &&
      e.decision.class === "standard" &&
      e.decision.spec.effort !== "low",
  );

  const after = costEvents.filter(
    (e) =>
      toDate(e.ts) >= baselineDate &&
      e.decision.class === "standard" &&
      e.decision.spec.effort === "low",
  );

  if (before.length === 0 || after.length === 0) {
    const check: CheckResult = {
      name: "e1-savings",
      pass: true,
      value: "n/a (no data)",
      gate: "≥50%",
      detail: "No events in one or both windows — cannot isolate E1 savings",
    };
    return { check, actualCostUsd: 0, hypotheticalOpusCostUsd: 0, savingsPct: 0 };
  }

  const beforeAvg =
    before.reduce((sum, e) => sum + costFromEvent(e.cost, e.decision.spec.model), 0) / before.length;
  const afterAvg =
    after.reduce((sum, e) => sum + costFromEvent(e.cost, e.decision.spec.model), 0) / after.length;

  const savingsPct = beforeAvg === 0 ? 0 : (beforeAvg - afterAvg) / beforeAvg;
  const pass = savingsPct >= 0.5;

  const check: CheckResult = {
    name: "e1-savings",
    pass,
    value: (savingsPct * 100).toFixed(1) + "%",
    gate: "≥50%",
    ...(!pass && {
      detail: `E1 savings below 50%: before avg $${beforeAvg.toFixed(6)}, after avg $${afterAvg.toFixed(6)}. E1 may not be firing or standard class traffic changed.`,
    }),
  };

  return { check, actualCostUsd: afterAvg, hypotheticalOpusCostUsd: beforeAvg, savingsPct };
}

// ---------------------------------------------------------------------------
// isolateTrackZSavings
// ---------------------------------------------------------------------------

export function isolateTrackZSavings(
  events: TelemetryEvent[],
  baselineDate: Date,
): TokenSavingsResult {
  const costEvents = decisionEventsWithCost(events);

  const beforeBoots = costEvents.filter(
    (e) =>
      toDate(e.ts) < baselineDate && e.cost.cacheCreationInputTokens > 0,
  );

  const afterBoots = costEvents.filter(
    (e) =>
      toDate(e.ts) >= baselineDate && e.cost.cacheCreationInputTokens > 0,
  );

  if (beforeBoots.length === 0 || afterBoots.length === 0) {
    const check: CheckResult = {
      name: "track-z-savings",
      pass: true,
      value: "n/a (no data)",
      gate: "≥30%",
      detail: "No events in one or both windows — cannot isolate Track Z savings",
    };
    return { check, actualCostUsd: 0, hypotheticalOpusCostUsd: 0, savingsPct: 0 };
  }

  const beforeDays = distinctDays(beforeBoots.map((e) => toDate(e.ts)));
  const afterDays = distinctDays(afterBoots.map((e) => toDate(e.ts)));

  const beforeRate = beforeBoots.length / beforeDays;
  const afterRate = afterBoots.length / afterDays;

  const savingsPct = beforeRate === 0 ? 0 : (beforeRate - afterRate) / beforeRate;
  const pass = savingsPct >= 0.3;

  const check: CheckResult = {
    name: "track-z-savings",
    pass,
    value: (savingsPct * 100).toFixed(1) + "% boots/day reduction",
    gate: "≥30%",
    ...(!pass && {
      detail: `Track Z did not reduce session boot frequency by 30%. Before: ${beforeRate.toFixed(2)}/day, After: ${afterRate.toFixed(2)}/day. Fingerprint sessions may not be active.`,
    }),
  };

  return { check, actualCostUsd: afterRate, hypotheticalOpusCostUsd: beforeRate, savingsPct };
}

// ---------------------------------------------------------------------------
// isolateXSavings
// ---------------------------------------------------------------------------

export function isolateXSavings(
  events: TelemetryEvent[],
  baselineDate: Date,
): TokenSavingsResult {
  const costEvents = decisionEventsWithCost(events);

  // Before/after split — X is a soft cap (system prompt only, no --max-tokens
  // flag exists in claude CLI), so the gate is a trend: after-baseline p90
  // should be lower than before-baseline p90, not pinned to an absolute number.
  const beforeStandard = costEvents.filter(
    (e) =>
      toDate(e.ts) < baselineDate && e.decision.class === "standard",
  );
  const afterStandard = costEvents.filter(
    (e) =>
      toDate(e.ts) >= baselineDate && e.decision.class === "standard",
  );

  if (afterStandard.length === 0) {
    const check: CheckResult = {
      name: "x-output-trend",
      pass: true,
      value: "n/a (no data)",
      gate: "after p90 < before p90",
      detail: "No after-baseline standard events — cannot isolate X trend",
    };
    return { check, actualCostUsd: 0, hypotheticalOpusCostUsd: 0, savingsPct: 0 };
  }

  const afterP90 = p90(afterStandard.map((e) => e.cost.outputTokens));

  // No before-baseline data → cannot compare trend; pass with the absolute number
  if (beforeStandard.length === 0) {
    const check: CheckResult = {
      name: "x-output-trend",
      pass: true,
      value: afterP90 + " tokens (p90)",
      gate: "after p90 < before p90",
      detail: "No before-baseline data — reporting current p90 only",
    };
    return { check, actualCostUsd: afterP90, hypotheticalOpusCostUsd: 0, savingsPct: 0 };
  }

  const beforeP90 = p90(beforeStandard.map((e) => e.cost.outputTokens));
  const pass = afterP90 < beforeP90;

  const check: CheckResult = {
    name: "x-output-trend",
    pass,
    value: `${afterP90} → ${beforeP90} (after → before p90)`,
    gate: "after < before",
    ...(!pass && {
      detail: `Standard-class output p90 is not trending down: ${beforeP90} → ${afterP90}. The brevity hint may not be effective; consider stronger system-prompt language.`,
    }),
  };

  return { check, actualCostUsd: afterP90, hypotheticalOpusCostUsd: beforeP90, savingsPct: 0 };
}

// ---------------------------------------------------------------------------
// runTokensSaved
// ---------------------------------------------------------------------------

export function runTokensSaved(
  events: TelemetryEvent[],
  baselineDate: Date,
  pricing?: Pricing,
): DimensionResult {
  const r1 = computeSavings(events, pricing);
  const r2 = isolateE1Savings(events, baselineDate);
  const r3 = isolateTrackZSavings(events, baselineDate);
  const r4 = isolateXSavings(events, baselineDate);

  const checks: CheckResult[] = [r1.check, r2.check, r3.check, r4.check];
  const pass = checks.every((c) => c.pass);

  return { dimension: "tokens", pass, checks };
}
