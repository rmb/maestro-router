// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  computeSavings,
  DEFAULT_PRICING,
  isolateE1Savings,
  isolateTrackZSavings,
  isolateXSavings,
  runTokensSaved,
} from "./tokens-saved.js";
import type { TelemetryEvent } from "../../core/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDecision(
  ts: string,
  opts: {
    cls?: "trivial" | "simple" | "standard" | "hard" | "reasoning" | "max";
    effort?: "low" | "medium" | "high" | "xhigh" | "max";
    totalCostUsd?: number;
    modelUsed?: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
  } = {},
): TelemetryEvent {
  return {
    type: "decision",
    ts,
    decision: {
      class: opts.cls ?? "standard",
      classifier: "heuristic",
      confidence: 0.8,
      spec: {
        model: "haiku",
        effort: opts.effort ?? "medium",
        maxBudgetUsd: 0.1,
      },
      latencyMs: 10,
      diagnostics: [],
    },
    cost: {
      totalCostUsd: opts.totalCostUsd ?? 0.001,
      inputTokens: opts.inputTokens ?? 1000,
      outputTokens: opts.outputTokens ?? 500,
      cacheCreationInputTokens: opts.cacheCreationInputTokens ?? 0,
      cacheReadInputTokens: opts.cacheReadInputTokens ?? 0,
      durationMs: 100,
      durationApiMs: 90,
      stopReason: "end_turn",
      modelUsed: opts.modelUsed ?? "claude-haiku",
      serviceTier: "standard",
    },
  } as TelemetryEvent;
}

// ---------------------------------------------------------------------------
// computeSavings
// ---------------------------------------------------------------------------

describe("computeSavings", () => {
  it("passes when savings ≥ 60%", () => {
    // Haiku is ~$0.001 actual, but at Opus pricing the same tokens cost much more
    // 1000 input + 500 output at Opus = 1000 * 15e-6 + 500 * 75e-6 = 0.015 + 0.0375 = 0.0525
    const events: TelemetryEvent[] = [
      makeDecision("2026-01-01T10:00:00Z", {
        totalCostUsd: 0.001,
        inputTokens: 1000,
        outputTokens: 500,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      }),
    ];

    const result = computeSavings(events, DEFAULT_PRICING);

    // hypothetical = 1000 * 15e-6 + 500 * 75e-6 = 0.015 + 0.0375 = 0.0525
    // savings = (0.0525 - 0.001) / 0.0525 ≈ 0.981 (98.1%)
    expect(result.check.pass).toBe(true);
    expect(result.savingsPct).toBeGreaterThanOrEqual(0.6);
    expect(result.check.gate).toBe("≥60%");
    expect(result.actualCostUsd).toBeCloseTo(0.001);
    expect(result.hypotheticalOpusCostUsd).toBeCloseTo(0.0525);
  });

  it("fails when savings < 60%", () => {
    // Use opus model so actual cost ≈ hypothetical Opus baseline → savings ≈ 0%
    const events: TelemetryEvent[] = [
      makeDecision("2026-01-01T10:00:00Z", {
        modelUsed: "claude-opus",
        inputTokens: 1000,
        outputTokens: 500,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      }),
    ];

    const result = computeSavings(events, DEFAULT_PRICING);

    expect(result.check.pass).toBe(false);
    expect(result.savingsPct).toBeLessThan(0.6);
    expect(result.check.detail).toBeDefined();
    expect(result.check.detail).toContain("savings dropped below 60%");
  });

  it("passes with 0/0 when there are no events with cost", () => {
    const events: TelemetryEvent[] = [
      {
        type: "decision",
        ts: "2026-01-01T10:00:00Z",
        decision: {
          class: "standard",
          classifier: "heuristic",
          confidence: 0.8,
          spec: { model: "haiku", effort: "medium", maxBudgetUsd: 0.1 },
          latencyMs: 10,
          diagnostics: [],
        },
        // no cost field
      } as TelemetryEvent,
    ];

    const result = computeSavings(events, DEFAULT_PRICING);

    expect(result.check.pass).toBe(true);
    expect(result.savingsPct).toBe(0);
    expect(result.actualCostUsd).toBe(0);
    expect(result.hypotheticalOpusCostUsd).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// isolateE1Savings
// ---------------------------------------------------------------------------

describe("isolateE1Savings", () => {
  const baseline = new Date("2026-03-01T00:00:00Z");

  it("passes when before avg > after avg and ≥50% reduction", () => {
    const events: TelemetryEvent[] = [
      // before: standard, effort=medium, routed to opus (expensive)
      makeDecision("2026-02-01T10:00:00Z", {
        cls: "standard",
        effort: "medium",
        modelUsed: "claude-opus",
      }),
      makeDecision("2026-02-10T10:00:00Z", {
        cls: "standard",
        effort: "medium",
        modelUsed: "claude-opus",
      }),
      // after: standard, effort=low (E1), routed to haiku (cheap)
      makeDecision("2026-03-05T10:00:00Z", {
        cls: "standard",
        effort: "low",
        modelUsed: "claude-haiku",
      }),
      makeDecision("2026-03-06T10:00:00Z", {
        cls: "standard",
        effort: "low",
        modelUsed: "claude-haiku",
      }),
    ];

    const result = isolateE1Savings(events, baseline);

    // beforeAvg = opus 1k in + 500 out = $0.0525; afterAvg = haiku = $0.0035
    // savings = ($0.0525 - $0.0035) / $0.0525 ≈ 93% ≥ 50%
    expect(result.check.pass).toBe(true);
    expect(result.savingsPct).toBeGreaterThanOrEqual(0.5);
  });

  it("fails when before avg ≈ after avg (< 50% reduction)", () => {
    const events: TelemetryEvent[] = [
      makeDecision("2026-02-01T10:00:00Z", {
        cls: "standard",
        effort: "medium",
        totalCostUsd: 0.04,
      }),
      makeDecision("2026-03-05T10:00:00Z", {
        cls: "standard",
        effort: "low",
        totalCostUsd: 0.035, // only ~12.5% reduction
      }),
    ];

    const result = isolateE1Savings(events, baseline);

    expect(result.check.pass).toBe(false);
    expect(result.savingsPct).toBeLessThan(0.5);
    expect(result.check.detail).toContain("E1 savings below 50%");
  });

  it("returns pass with n/a when there is no before data", () => {
    const events: TelemetryEvent[] = [
      makeDecision("2026-03-05T10:00:00Z", {
        cls: "standard",
        effort: "low",
        totalCostUsd: 0.005,
      }),
    ];

    const result = isolateE1Savings(events, baseline);

    expect(result.check.pass).toBe(true);
    expect(result.check.value).toBe("n/a (no data)");
    expect(result.check.detail).toContain("cannot isolate E1 savings");
  });
});

// ---------------------------------------------------------------------------
// isolateTrackZSavings
// ---------------------------------------------------------------------------

describe("isolateTrackZSavings", () => {
  const baseline = new Date("2026-03-01T00:00:00Z");

  it("passes when boots/day reduced ≥ 30%", () => {
    // Before: 6 boot events over 1 day = 6/day
    // After: 3 boot events over 1 day = 3/day
    // Reduction = (6 - 3) / 6 = 50%
    const events: TelemetryEvent[] = [
      makeDecision("2026-02-01T01:00:00Z", { cacheCreationInputTokens: 37000 }),
      makeDecision("2026-02-01T02:00:00Z", { cacheCreationInputTokens: 37000 }),
      makeDecision("2026-02-01T03:00:00Z", { cacheCreationInputTokens: 37000 }),
      makeDecision("2026-02-01T04:00:00Z", { cacheCreationInputTokens: 37000 }),
      makeDecision("2026-02-01T05:00:00Z", { cacheCreationInputTokens: 37000 }),
      makeDecision("2026-02-01T06:00:00Z", { cacheCreationInputTokens: 37000 }),
      makeDecision("2026-03-05T01:00:00Z", { cacheCreationInputTokens: 37000 }),
      makeDecision("2026-03-05T08:00:00Z", { cacheCreationInputTokens: 37000 }),
      makeDecision("2026-03-05T14:00:00Z", { cacheCreationInputTokens: 37000 }),
    ];

    const result = isolateTrackZSavings(events, baseline);

    expect(result.check.pass).toBe(true);
    expect(result.savingsPct).toBeGreaterThanOrEqual(0.3);
    expect(result.check.gate).toBe("≥30%");
  });

  it("fails when boots/day reduced < 30%", () => {
    // Before: 6 boot events over 1 day = 6/day
    // After: 5 boot events over 1 day = 5/day
    // Reduction = (6 - 5) / 6 ≈ 16.7%
    const events: TelemetryEvent[] = [
      makeDecision("2026-02-01T01:00:00Z", { cacheCreationInputTokens: 37000 }),
      makeDecision("2026-02-01T02:00:00Z", { cacheCreationInputTokens: 37000 }),
      makeDecision("2026-02-01T03:00:00Z", { cacheCreationInputTokens: 37000 }),
      makeDecision("2026-02-01T04:00:00Z", { cacheCreationInputTokens: 37000 }),
      makeDecision("2026-02-01T05:00:00Z", { cacheCreationInputTokens: 37000 }),
      makeDecision("2026-02-01T06:00:00Z", { cacheCreationInputTokens: 37000 }),
      makeDecision("2026-03-05T01:00:00Z", { cacheCreationInputTokens: 37000 }),
      makeDecision("2026-03-05T02:00:00Z", { cacheCreationInputTokens: 37000 }),
      makeDecision("2026-03-05T03:00:00Z", { cacheCreationInputTokens: 37000 }),
      makeDecision("2026-03-05T04:00:00Z", { cacheCreationInputTokens: 37000 }),
      makeDecision("2026-03-05T05:00:00Z", { cacheCreationInputTokens: 37000 }),
    ];

    const result = isolateTrackZSavings(events, baseline);

    expect(result.check.pass).toBe(false);
    expect(result.savingsPct).toBeLessThan(0.3);
    expect(result.check.detail).toContain("Fingerprint sessions may not be active");
  });

  it("returns pass with n/a when there is no data in either window", () => {
    // No boot events at all
    const events: TelemetryEvent[] = [
      makeDecision("2026-02-01T10:00:00Z", { cacheCreationInputTokens: 0 }),
    ];

    const result = isolateTrackZSavings(events, baseline);

    expect(result.check.pass).toBe(true);
    expect(result.check.value).toBe("n/a (no data)");
  });
});

// ---------------------------------------------------------------------------
// isolateXSavings
// ---------------------------------------------------------------------------

describe("isolateXSavings", () => {
  const baseline = new Date("2026-03-01T00:00:00Z");

  it("passes when after p90 is lower than before p90", () => {
    const before: TelemetryEvent[] = Array.from({ length: 10 }, (_, i) =>
      makeDecision(`2026-02-${String(i + 10).padStart(2, "0")}T10:00:00Z`, {
        cls: "standard",
        outputTokens: 10000 + i * 200,
      }),
    );
    const after: TelemetryEvent[] = Array.from({ length: 10 }, (_, i) =>
      makeDecision(`2026-03-${String(i + 2).padStart(2, "0")}T10:00:00Z`, {
        cls: "standard",
        outputTokens: 4000 + i * 200,
      }),
    );

    const result = isolateXSavings([...before, ...after], baseline);

    expect(result.check.pass).toBe(true);
    expect(result.check.name).toBe("x-output-trend");
  });

  it("fails when after p90 is NOT lower than before p90", () => {
    const before: TelemetryEvent[] = Array.from({ length: 10 }, (_, i) =>
      makeDecision(`2026-02-${String(i + 10).padStart(2, "0")}T10:00:00Z`, {
        cls: "standard",
        outputTokens: 4000 + i * 100,
      }),
    );
    const after: TelemetryEvent[] = Array.from({ length: 10 }, (_, i) =>
      makeDecision(`2026-03-${String(i + 2).padStart(2, "0")}T10:00:00Z`, {
        cls: "standard",
        outputTokens: 10000 + i * 100,
      }),
    );

    const result = isolateXSavings([...before, ...after], baseline);

    expect(result.check.pass).toBe(false);
    expect(result.check.detail).toContain("not trending down");
  });

  it("returns pass with n/a when there is no after data", () => {
    const events: TelemetryEvent[] = [
      makeDecision("2026-02-01T10:00:00Z", { cls: "standard", outputTokens: 500 }),
    ];

    const result = isolateXSavings(events, baseline);

    expect(result.check.pass).toBe(true);
    expect(result.check.value).toBe("n/a (no data)");
  });

  it("passes when after data exists but no before data (reports current only)", () => {
    const events: TelemetryEvent[] = Array.from({ length: 10 }, (_, i) =>
      makeDecision(`2026-03-${String(i + 2).padStart(2, "0")}T10:00:00Z`, {
        cls: "standard",
        outputTokens: 5000 + i * 100,
      }),
    );

    const result = isolateXSavings(events, baseline);

    expect(result.check.pass).toBe(true);
    expect(result.check.detail).toContain("No before-baseline data");
  });
});

// ---------------------------------------------------------------------------
// runTokensSaved
// ---------------------------------------------------------------------------

describe("runTokensSaved", () => {
  const baseline = new Date("2026-03-01T00:00:00Z");

  it("returns dimension pass when all checks pass", () => {
    // computeSavings: high savings (actual much cheaper than opus)
    // isolateE1: no data → pass n/a
    // isolateTrackZ: no boot events → pass n/a
    // isolateX: no after-standard events → pass n/a
    const events: TelemetryEvent[] = [
      makeDecision("2026-02-01T10:00:00Z", {
        totalCostUsd: 0.001,
        inputTokens: 1000,
        outputTokens: 500,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      }),
    ];

    const result = runTokensSaved(events, baseline, DEFAULT_PRICING);

    expect(result.dimension).toBe("tokens");
    expect(result.pass).toBe(true);
    expect(result.checks).toHaveLength(4);
  });

  it("returns dimension fail when at least one check fails", () => {
    // computeSavings will fail: opus model → actual ≈ hypothetical Opus cost → savings ≈ 0%
    const events: TelemetryEvent[] = [
      makeDecision("2026-02-01T10:00:00Z", {
        modelUsed: "claude-opus",
        inputTokens: 1000,
        outputTokens: 500,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      }),
    ];

    const result = runTokensSaved(events, baseline, DEFAULT_PRICING);

    expect(result.dimension).toBe("tokens");
    expect(result.pass).toBe(false);
    expect(result.checks.some((c) => !c.pass)).toBe(true);
  });
});
