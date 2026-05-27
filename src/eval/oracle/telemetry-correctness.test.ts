// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import type { TelemetryEvent } from "../../core/types.js";
import {
  checkCacheHitRateAccuracy,
  checkCostReconciliation,
  checkFallbackRateAccuracy,
  checkOutcomeLinkage,
  runTelemetryCorrectness,
  type StatsSummary,
} from "./telemetry-correctness.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDecision(opts: {
  tsMs?: number;
  totalCostUsd?: number;
  classifier?: string;
  cacheHit?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
}): Extract<TelemetryEvent, { type: "decision" }> {
  return {
    type: "decision",
    ts: new Date(opts.tsMs ?? Date.now()).toISOString(),
    decision: {
      class: "standard",
      classifier: opts.classifier ?? "heuristic",
      confidence: 0.8,
      spec: { model: "sonnet", effort: "medium", maxBudgetUsd: 0.1 },
      latencyMs: 5,
      diagnostics: [],
      cacheHit: opts.cacheHit,
    },
    cost: {
      totalCostUsd: opts.totalCostUsd ?? 0,
      inputTokens: opts.inputTokens ?? 100,
      outputTokens: opts.outputTokens ?? 50,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: opts.cacheReadInputTokens ?? 0,
      durationMs: 200,
      durationApiMs: 180,
      stopReason: "end_turn",
      modelUsed: "claude-haiku-4-5",
      serviceTier: "standard",
    },
  };
}

function makeOutcome(
  tsMs: number,
  sessionId: string,
): Extract<TelemetryEvent, { type: "outcome" }> {
  return {
    type: "outcome",
    ts: new Date(tsMs).toISOString(),
    sessionId,
    decidedClass: "standard",
    stopReason: "end_turn",
    outputTokens: 100,
    cacheCreationTokens: 0,
    totalCostUsd: 0.001,
    durationApiMs: 1200,
  };
}

const emptySummary: StatsSummary = {
  totalCostUsd: 0,
  fallbackRate: 0,
  cacheHitRate: 0,
};

// ---------------------------------------------------------------------------
// checkCostReconciliation
// ---------------------------------------------------------------------------

describe("checkCostReconciliation", () => {
  test("passes when event sum matches stats exactly", () => {
    // haiku input rate $1/Mtok; 1M tokens = $1.00, 500k tokens = $0.50
    const events: TelemetryEvent[] = [
      makeDecision({ inputTokens: 1_000_000, outputTokens: 0 }),
      makeDecision({ inputTokens: 500_000, outputTokens: 0 }),
    ];
    const summary: StatsSummary = { ...emptySummary, totalCostUsd: 1.5 };
    const result = checkCostReconciliation(events, summary);
    expect(result.pass).toBe(true);
    expect(result.value).toBe("$1.500");
    expect(result.detail).toBeUndefined();
  });

  test("passes when event sum is within 1% of stats", () => {
    // haiku 1M input = $1.00; threshold = $0.01; stats = $1.005 → diff = $0.005 < $0.01
    const events: TelemetryEvent[] = [
      makeDecision({ inputTokens: 1_000_000, outputTokens: 0 }),
    ];
    const summary: StatsSummary = { ...emptySummary, totalCostUsd: 1.005 };
    const result = checkCostReconciliation(events, summary);
    expect(result.pass).toBe(true);
  });

  test("fails when sum exceeds 1% threshold", () => {
    const events: TelemetryEvent[] = [
      makeDecision({ totalCostUsd: 1.0 }),
    ];
    const summary: StatsSummary = { ...emptySummary, totalCostUsd: 3.589 };
    const result = checkCostReconciliation(events, summary);
    expect(result.pass).toBe(false);
    expect(result.detail).toContain("Computed");
    expect(result.detail).toContain("stats reports");
    expect(result.detail).toContain("aggregation bug");
  });

  test("passes when no events and stats is 0 (0 == 0)", () => {
    const result = checkCostReconciliation([], emptySummary);
    expect(result.pass).toBe(true);
    expect(result.value).toBe("$0.000");
  });

  test("non-decision events are not counted", () => {
    // haiku 1M input = $1.00; outcome event should be ignored in cost sum
    const events: TelemetryEvent[] = [
      makeDecision({ inputTokens: 1_000_000, outputTokens: 0 }),
      makeOutcome(Date.now(), "sid-1"),
    ];
    const summary: StatsSummary = { ...emptySummary, totalCostUsd: 1.0 };
    const result = checkCostReconciliation(events, summary);
    expect(result.pass).toBe(true);
  });

  test("gate label is ±1%", () => {
    const result = checkCostReconciliation([], emptySummary);
    expect(result.gate).toBe("±1%");
  });

  test("decision events without cost field count as $0", () => {
    const event: Extract<TelemetryEvent, { type: "decision" }> = {
      type: "decision",
      ts: new Date().toISOString(),
      decision: {
        class: "trivial",
        classifier: "heuristic",
        confidence: 0.9,
        spec: { model: "haiku", effort: "low", maxBudgetUsd: 0.01 },
        latencyMs: 3,
        diagnostics: [],
      },
      // no cost field
    };
    const summary: StatsSummary = { ...emptySummary, totalCostUsd: 0 };
    const result = checkCostReconciliation([event], summary);
    expect(result.pass).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkFallbackRateAccuracy
// ---------------------------------------------------------------------------

describe("checkFallbackRateAccuracy", () => {
  test("passes when computed rate matches stats", () => {
    const events: TelemetryEvent[] = [
      makeDecision({ classifier: "forced.standard" }),
      makeDecision({ classifier: "heuristic" }),
      makeDecision({ classifier: "heuristic" }),
      makeDecision({ classifier: "heuristic" }),
    ];
    // 1 fallback / 4 total = 0.25
    const summary: StatsSummary = { ...emptySummary, fallbackRate: 0.25 };
    const result = checkFallbackRateAccuracy(events, summary);
    expect(result.pass).toBe(true);
    expect(result.value).toBe("25.0%");
    expect(result.detail).toBeUndefined();
  });

  test("fails when computed rate differs by more than 0.01", () => {
    const events: TelemetryEvent[] = [
      makeDecision({ classifier: "forced.standard" }),
      makeDecision({ classifier: "heuristic" }),
    ];
    // 1/2 = 0.50, but stats says 0.10
    const summary: StatsSummary = { ...emptySummary, fallbackRate: 0.10 };
    const result = checkFallbackRateAccuracy(events, summary);
    expect(result.pass).toBe(false);
    expect(result.detail).toContain("fallbacks");
    expect(result.detail).toContain("stats reports");
  });

  test("legacy 'default' classifier is counted as fallback", () => {
    const events: TelemetryEvent[] = [
      makeDecision({ classifier: "default" }),
      makeDecision({ classifier: "default" }),
      makeDecision({ classifier: "heuristic" }),
    ];
    // 2/3 ≈ 0.667
    const summary: StatsSummary = {
      ...emptySummary,
      fallbackRate: 2 / 3,
    };
    const result = checkFallbackRateAccuracy(events, summary);
    expect(result.pass).toBe(true);
  });

  test("passes trivially with no events (0 = 0)", () => {
    const summary: StatsSummary = { ...emptySummary, fallbackRate: 0 };
    const result = checkFallbackRateAccuracy([], summary);
    expect(result.pass).toBe(true);
    expect(result.value).toBe("0.0%");
  });

  test("gate label is ±0.01", () => {
    const result = checkFallbackRateAccuracy([], emptySummary);
    expect(result.gate).toBe("±0.01");
  });

  test("passes within 0.01 tolerance", () => {
    const events: TelemetryEvent[] = Array.from({ length: 100 }, (_, i) =>
      makeDecision({ classifier: i < 5 ? "forced.standard" : "heuristic" }),
    );
    // 5/100 = 0.05; stats says 0.059 — diff = 0.009 < 0.01
    const summary: StatsSummary = { ...emptySummary, fallbackRate: 0.059 };
    const result = checkFallbackRateAccuracy(events, summary);
    expect(result.pass).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkCacheHitRateAccuracy
// ---------------------------------------------------------------------------

describe("checkCacheHitRateAccuracy", () => {
  test("passes when cacheHit flag rate matches stats", () => {
    const events: TelemetryEvent[] = [
      makeDecision({ cacheHit: true, cacheReadInputTokens: 500 }),
      makeDecision({ cacheHit: true, cacheReadInputTokens: 300 }),
      makeDecision({ cacheHit: false, cacheReadInputTokens: 0 }),
      makeDecision({ cacheHit: false, cacheReadInputTokens: 0 }),
    ];
    // 2/4 = 0.50
    const summary: StatsSummary = { ...emptySummary, cacheHitRate: 0.5 };
    const result = checkCacheHitRateAccuracy(events, summary);
    expect(result.pass).toBe(true);
    expect(result.value).toBe("50.0%");
  });

  test("fails when flag rate differs from stats by more than 0.01", () => {
    const events: TelemetryEvent[] = [
      makeDecision({ cacheHit: true }),
      makeDecision({ cacheHit: false }),
      makeDecision({ cacheHit: false }),
      makeDecision({ cacheHit: false }),
    ];
    // 1/4 = 0.25, stats says 0.80
    const summary: StatsSummary = { ...emptySummary, cacheHitRate: 0.80 };
    const result = checkCacheHitRateAccuracy(events, summary);
    expect(result.pass).toBe(false);
    expect(result.detail).toContain("cache-hit rate");
  });

  test("emits detail warning when cacheHit flag count diverges from cacheReadInputTokens count by >5%", () => {
    // 10 events: cacheHit=true on 8, but cacheReadInputTokens>0 on only 1
    // divergence: |8-1| / 10 = 70% >> 5%
    const events: TelemetryEvent[] = [
      ...Array.from({ length: 8 }, () =>
        makeDecision({ cacheHit: true, cacheReadInputTokens: 0 }),
      ),
      makeDecision({ cacheHit: false, cacheReadInputTokens: 500 }),
      makeDecision({ cacheHit: false, cacheReadInputTokens: 0 }),
    ];
    // 8/10 = 0.80; stats matches so gate passes
    const summary: StatsSummary = { ...emptySummary, cacheHitRate: 0.80 };
    const result = checkCacheHitRateAccuracy(events, summary);
    expect(result.pass).toBe(true);
    expect(result.detail).toBeDefined();
    expect(result.detail).toContain("diverges");
    expect(result.detail).toContain("output.ts");
  });

  test("no detail warning when flag count and token count agree", () => {
    const events: TelemetryEvent[] = [
      makeDecision({ cacheHit: true, cacheReadInputTokens: 400 }),
      makeDecision({ cacheHit: false, cacheReadInputTokens: 0 }),
    ];
    const summary: StatsSummary = { ...emptySummary, cacheHitRate: 0.5 };
    const result = checkCacheHitRateAccuracy(events, summary);
    expect(result.pass).toBe(true);
    expect(result.detail).toBeUndefined();
  });

  test("passes trivially with no events (0 = 0)", () => {
    const result = checkCacheHitRateAccuracy([], emptySummary);
    expect(result.pass).toBe(true);
    expect(result.value).toBe("0.0%");
  });

  test("gate label is ±0.01", () => {
    const result = checkCacheHitRateAccuracy([], emptySummary);
    expect(result.gate).toBe("±0.01");
  });
});

// ---------------------------------------------------------------------------
// checkOutcomeLinkage
// ---------------------------------------------------------------------------

describe("checkOutcomeLinkage", () => {
  function makePair(
    tsMs: number,
    sessionId: string,
  ): {
    decision: Extract<TelemetryEvent, { type: "decision" }>;
    outcome: Extract<TelemetryEvent, { type: "outcome" }>;
  } {
    return {
      decision: makeDecision({ tsMs }),
      outcome: makeOutcome(tsMs + 500, sessionId),
    };
  }

  test("passes when all outcomes are linked (100%)", () => {
    const now = Date.now();
    const sid = "sid-all";
    const events: TelemetryEvent[] = [
      makeDecision({ tsMs: now }),
      makeOutcome(now + 500, sid),
    ];
    const pairs = [makePair(now, sid)];
    const result = checkOutcomeLinkage(events, pairs);
    expect(result.pass).toBe(true);
    expect(result.value).toBe("100.0%");
    expect(result.detail).toBeUndefined();
  });

  test("passes at exactly 90% linkage rate", () => {
    const now = Date.now();
    const events: TelemetryEvent[] = Array.from({ length: 10 }, (_, i) =>
      makeOutcome(now + i * 1000, `sid-${i}`),
    );
    // Pair 9 out of 10 outcomes
    const pairs = Array.from({ length: 9 }, (_, i) =>
      makePair(now + i * 1000, `sid-${i}`),
    );
    const result = checkOutcomeLinkage(events, pairs);
    expect(result.pass).toBe(true);
    expect(result.value).toBe("90.0%");
  });

  test("fails when linkage rate is below 90%", () => {
    const now = Date.now();
    // 7 outcomes, 5 paired → 5/7 ≈ 71.4%
    const events: TelemetryEvent[] = Array.from({ length: 7 }, (_, i) =>
      makeOutcome(now + i * 1000, `sid-${i}`),
    );
    const pairs = Array.from({ length: 5 }, (_, i) =>
      makePair(now + i * 1000, `sid-${i}`),
    );
    const result = checkOutcomeLinkage(events, pairs);
    expect(result.pass).toBe(false);
    expect(result.detail).toContain("unlinked");
    expect(result.detail).toContain("Stop-hook");
    expect(result.detail).toContain("bypass paths");
  });

  test("fails at 85% linkage (below 90% gate)", () => {
    const now = Date.now();
    // 20 outcomes, 17 paired → 85%
    const events: TelemetryEvent[] = Array.from({ length: 20 }, (_, i) =>
      makeOutcome(now + i * 1000, `sid-${i}`),
    );
    const pairs = Array.from({ length: 17 }, (_, i) =>
      makePair(now + i * 1000, `sid-${i}`),
    );
    const result = checkOutcomeLinkage(events, pairs);
    expect(result.pass).toBe(false);
    expect(result.value).toBe("85.0%");
  });

  test("passes trivially with 0 outcomes", () => {
    const events: TelemetryEvent[] = [makeDecision({})];
    const result = checkOutcomeLinkage(events, []);
    expect(result.pass).toBe(true);
    expect(result.value).toBe("100.0%");
    expect(result.detail).toBeUndefined();
  });

  test("gate label is ≥90%", () => {
    const result = checkOutcomeLinkage([], []);
    expect(result.gate).toBe("≥90%");
  });
});

// ---------------------------------------------------------------------------
// runTelemetryCorrectness
// ---------------------------------------------------------------------------

describe("runTelemetryCorrectness", () => {
  test("dimension is 'telemetry'", () => {
    const result = runTelemetryCorrectness([], [], emptySummary);
    expect(result.dimension).toBe("telemetry");
  });

  test("returns 4 checks", () => {
    const result = runTelemetryCorrectness([], [], emptySummary);
    expect(result.checks).toHaveLength(4);
  });

  test("pass is true when all checks pass", () => {
    const now = Date.now();
    const events: TelemetryEvent[] = [
      makeDecision({ totalCostUsd: 1.0, classifier: "heuristic", cacheHit: true, cacheReadInputTokens: 300 }),
      makeDecision({ totalCostUsd: 1.0, classifier: "heuristic", cacheHit: false, cacheReadInputTokens: 0 }),
      makeOutcome(now, "sid-1"),
    ];
    const pairs = [
      {
        decision: makeDecision({ tsMs: now, totalCostUsd: 1.0 }),
        outcome: makeOutcome(now + 500, "sid-1"),
      },
    ];
    const summary: StatsSummary = {
      // event1: haiku 100 in + 50 out + 300 cacheRead = $0.00038; event2: $0.00035; sum = $0.00073
      totalCostUsd: 0.00073,
      fallbackRate: 0,
      cacheHitRate: 0.5,
    };
    const result = runTelemetryCorrectness(events, pairs, summary);
    expect(result.pass).toBe(true);
    expect(result.checks.every((c) => c.pass)).toBe(true);
  });

  test("pass is false when one check fails", () => {
    const now = Date.now();
    // Cost mismatch: events sum $0, stats $99
    const events: TelemetryEvent[] = [
      makeOutcome(now, "sid-fail"),
    ];
    const summary: StatsSummary = {
      totalCostUsd: 99,
      fallbackRate: 0,
      cacheHitRate: 0,
    };
    const result = runTelemetryCorrectness(events, [], summary);
    expect(result.pass).toBe(false);
    const failedChecks = result.checks.filter((c) => !c.pass);
    expect(failedChecks.length).toBeGreaterThanOrEqual(1);
  });

  test("check names are as expected", () => {
    const result = runTelemetryCorrectness([], [], emptySummary);
    const names = result.checks.map((c) => c.name);
    expect(names).toContain("cost-reconciliation");
    expect(names).toContain("fallback-rate-accuracy");
    expect(names).toContain("cache-hit-rate-accuracy");
    expect(names).toContain("outcome-linkage");
  });
});
