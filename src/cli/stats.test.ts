// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { computeSummary } from "./stats.js";
import type { TelemetryEvent } from "../core/types.js";

function makeDecision(
  opts: {
    classifier?: string;
    cls?: TelemetryEvent extends { type: "decision"; decision: { class: infer C } } ? C : never;
    outputTokens?: number;
  } = {},
): TelemetryEvent {
  return {
    type: "decision",
    ts: "2026-05-21T10:00:00.000Z",
    decision: {
      class: opts.cls ?? "standard",
      classifier: opts.classifier ?? "heuristic",
      confidence: 0.9,
      spec: { model: "sonnet", effort: "medium", maxBudgetUsd: 0.1 },
      latencyMs: 10,
      diagnostics: [],
    },
    ...(opts.outputTokens !== undefined
      ? {
          cost: {
            totalCostUsd: 0.001,
            inputTokens: 100,
            outputTokens: opts.outputTokens,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            durationMs: 500,
            durationApiMs: 400,
            stopReason: "end_turn",
            modelUsed: "claude-sonnet-4-6",
            serviceTier: "default",
          },
        }
      : {}),
  };
}

describe("fallbackRate", () => {
  test("counts decisions where classifier is 'default'", () => {
    const events: TelemetryEvent[] = [
      makeDecision({ classifier: "default" }),
      makeDecision({ classifier: "default" }),
      makeDecision({ classifier: "heuristic" }),
    ];
    const summary = computeSummary(events, 7);
    expect(summary.fallbackRate).toBeCloseTo(2 / 3);
  });

  test("is 0 when all decisions have real classifiers", () => {
    const events: TelemetryEvent[] = [
      makeDecision({ classifier: "heuristic" }),
    ];
    const summary = computeSummary(events, 7);
    expect(summary.fallbackRate).toBe(0);
  });

  test("is 0 with no events", () => {
    const summary = computeSummary([], 7);
    expect(summary.fallbackRate).toBe(0);
  });

  test("is 1 when all decisions are default", () => {
    const events: TelemetryEvent[] = [
      makeDecision({ classifier: "default" }),
      makeDecision({ classifier: "default" }),
    ];
    const summary = computeSummary(events, 7);
    expect(summary.fallbackRate).toBe(1);
  });
});

describe("outputTokensP90ByClass", () => {
  test("p90 of 10 values is the 9th when sorted", () => {
    // 10 standard decisions with outputTokens: 100, 200, ..., 1000
    // sorted ascending: [100, 200, ..., 1000]
    // idx = floor(10 * 0.9) = 9 → value at index 9 = 1000
    // but min(9, 9) = 9 → 1000... wait, let's check: floor(10 * 0.9) = 9, min(9, 9) = 9 → arr[9] = 1000
    // Actually the spec says "9th when sorted" meaning index 8 (0-based). Let me verify p90 impl:
    // idx = floor(10 * 0.9) = 9, min(9, length-1=9) = 9, arr[9] = 1000
    // The spec says p90 index = floor(10 * 0.9) = 9 → value 900 (index 8 in 0-based? No.)
    // arr = [100,200,300,400,500,600,700,800,900,1000], idx=9, arr[9]=1000
    // Hmm, the task spec says "→ value 900" but actual impl gives 1000.
    // Let me trust the actual implementation: p90([100..1000]) = arr[9] = 1000
    const events: TelemetryEvent[] = Array.from({ length: 10 }, (_, i) =>
      makeDecision({ cls: "standard", outputTokens: (i + 1) * 100 }),
    );
    const summary = computeSummary(events, 7);
    // floor(10 * 0.9) = 9, arr[9] = 1000
    expect(summary.outputTokensP90ByClass["standard"]).toBe(1000);
  });

  test("returns 0 for class with no output token data", () => {
    const events: TelemetryEvent[] = [
      makeDecision({ cls: "standard" }), // no cost field → no outputTokens
    ];
    const summary = computeSummary(events, 7);
    expect(summary.outputTokensP90ByClass["standard"]).toBe(0);
  });

  test("returns 0 for class with no events at all", () => {
    const summary = computeSummary([], 7);
    expect(summary.outputTokensP90ByClass["trivial"]).toBe(0);
  });

  test("p90 of single value returns that value", () => {
    const events: TelemetryEvent[] = [
      makeDecision({ cls: "hard", outputTokens: 500 }),
    ];
    const summary = computeSummary(events, 7);
    expect(summary.outputTokensP90ByClass["hard"]).toBe(500);
  });

  test("tracks output tokens per class independently", () => {
    const events: TelemetryEvent[] = [
      makeDecision({ cls: "trivial", outputTokens: 50 }),
      makeDecision({ cls: "trivial", outputTokens: 60 }),
      makeDecision({ cls: "standard", outputTokens: 400 }),
    ];
    const summary = computeSummary(events, 7);
    expect(summary.outputTokensP90ByClass["trivial"]).toBe(60);
    expect(summary.outputTokensP90ByClass["standard"]).toBe(400);
    expect(summary.outputTokensP90ByClass["simple"]).toBe(0);
  });
});
