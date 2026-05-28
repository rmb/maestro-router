// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { computeSummary, computeTrend } from "./stats.js";
import type { TelemetryEvent } from "../core/types.js";

function makeDecision(
  opts: {
    classifier?: string;
    cls?: TelemetryEvent extends { type: "decision"; decision: { class: infer C } } ? C : never;
    outputTokens?: number;
    durationApiMs?: number;
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
            durationApiMs: opts.durationApiMs ?? 400,
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

describe("C1: decision events without cost are counted in totalRequests", () => {
  test("totalRequests includes events without cost field", () => {
    const events: TelemetryEvent[] = [
      makeDecision(), // no cost field — e.g., error/interrupt/budget-cap
      makeDecision({ outputTokens: 200 }), // with cost
    ];
    const summary = computeSummary(events, 7);
    expect(summary.totalRequests).toBe(2);
    // Token-derived cost for sonnet: 100 input × $3/Mtok + 200 output × $15/Mtok = $0.0033
    expect(summary.totalCostUsd).toBeCloseTo(0.0033, 4);
  });

  test("totalRequests === 1, totalCostUsd === 0 for single decision without cost", () => {
    const events: TelemetryEvent[] = [
      makeDecision(), // no cost field
    ];
    const summary = computeSummary(events, 7);
    expect(summary.totalRequests).toBe(1);
    expect(summary.totalCostUsd).toBe(0);
  });
});

describe("outputTokensP90ByClass", () => {
  test("p90 of 10 values is the 9th when sorted", () => {
    // 10 standard decisions with outputTokens: 100, 200, ..., 1000
    // sorted ascending: [100, 200, ..., 1000]
    // idx = ceil(10 * 0.9) - 1 = ceil(9) - 1 = 8 → arr[8] = 900
    const events: TelemetryEvent[] = Array.from({ length: 10 }, (_, i) =>
      makeDecision({ cls: "standard", outputTokens: (i + 1) * 100 }),
    );
    const summary = computeSummary(events, 7);
    // ceil(10 * 0.9) - 1 = 8, arr[8] = 900
    expect(summary.outputTokensP90ByClass["standard"]).toBe(900);
  });

  test("returns undefined for class with no output token data", () => {
    const events: TelemetryEvent[] = [
      makeDecision({ cls: "standard" }), // no cost field → no outputTokens
    ];
    const summary = computeSummary(events, 7);
    expect(summary.outputTokensP90ByClass["standard"]).toBeUndefined();
  });

  test("does not include class with no events at all", () => {
    const summary = computeSummary([], 7);
    expect(summary.outputTokensP90ByClass["trivial"]).toBeUndefined();
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
    expect(summary.outputTokensP90ByClass["simple"]).toBeUndefined();
  });
});

describe("1M variant baseline pricing", () => {
  test("has1mVariant is false when no events have is1mVariant", () => {
    const events: TelemetryEvent[] = [makeDecision({ outputTokens: 100 })];
    const summary = computeSummary(events, 7);
    expect(summary.has1mVariant).toBe(false);
    expect(summary.count1mVariant).toBe(0);
  });

  test("has1mVariant is true when any event has is1mVariant=true", () => {
    const event: TelemetryEvent = {
      type: "decision",
      ts: "2026-05-21T10:00:00.000Z",
      decision: {
        class: "standard",
        classifier: "heuristic",
        confidence: 0.9,
        spec: { model: "opus", effort: "medium", maxBudgetUsd: 0.5 },
        latencyMs: 10,
        diagnostics: [],
      },
      cost: {
        totalCostUsd: 0.05,
        inputTokens: 1000,
        outputTokens: 200,
        cacheCreationInputTokens: 40000,
        cacheReadInputTokens: 0,
        durationMs: 5000,
        durationApiMs: 4800,
        stopReason: "end_turn",
        modelUsed: "claude-opus-4-7",
        serviceTier: "default",
        is1mVariant: true,
      },
    };
    const summary = computeSummary([event], 7);
    expect(summary.has1mVariant).toBe(true);
    expect(summary.count1mVariant).toBe(1);
  });

  test("1M variant baseline uses 2× cache_creation rate, so baseline >= actual when all turns are 1M", () => {
    // 1M variant: actual spend = real cost; baseline = 1M Opus repriced.
    // When Claude uses claude-opus-4-7[1m], actual ≈ baseline (same pricing tier).
    // Savings > 0 means Maestro routed some turns cheaper (haiku/sonnet) than 1M Opus.
    const opusTurn: TelemetryEvent = {
      type: "decision",
      ts: "2026-05-21T10:00:00.000Z",
      decision: {
        class: "standard",
        classifier: "heuristic",
        confidence: 0.9,
        spec: { model: "opus", effort: "medium", maxBudgetUsd: 0.5 },
        latencyMs: 10,
        diagnostics: [],
      },
      cost: {
        totalCostUsd: 1.5,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 40000,
        cacheReadInputTokens: 0,
        durationMs: 5000,
        durationApiMs: 4800,
        stopReason: "end_turn",
        modelUsed: "claude-opus-4-7",
        serviceTier: "default",
        is1mVariant: true,
      },
    };
    const haikuTurn: TelemetryEvent = {
      type: "decision",
      ts: "2026-05-21T10:01:00.000Z",
      decision: {
        class: "trivial",
        classifier: "heuristic",
        confidence: 0.95,
        spec: { model: "haiku", effort: "low", maxBudgetUsd: 0.05 },
        latencyMs: 10,
        diagnostics: [],
      },
      cost: {
        totalCostUsd: 0.0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 40000,
        durationMs: 500,
        durationApiMs: 400,
        stopReason: "end_turn",
        modelUsed: "claude-haiku-4-5",
        serviceTier: "default",
        is1mVariant: true,
      },
    };
    const summary = computeSummary([opusTurn, haikuTurn], 7);
    // Baseline should account for 1M pricing on both turns.
    // cacheCreationTokens1m=40000 → baseline cacheCreate = 40000 * 37.5/1M = 1.5
    // cacheReadTokens1m=40000 → baseline cacheRead = 40000 * 3.0/1M = 0.12
    // Total baseline ≈ 1.62, actual = 1.5 → savings ≈ 7.4%
    expect(summary.baselineOpusEverywhereUsd).toBeGreaterThan(summary.totalCostUsd);
    expect(summary.savingsRatio).toBeGreaterThan(0);
  });
});

describe("cacheReadCostUsd", () => {
  test("computes cache_read cost for haiku model (0.10/1M tokens)", () => {
    const event: TelemetryEvent = {
      type: "decision",
      ts: "2026-05-21T10:00:00.000Z",
      decision: {
        class: "trivial",
        classifier: "heuristic",
        confidence: 0.95,
        spec: { model: "haiku", effort: "low", maxBudgetUsd: 0.05 },
        latencyMs: 5,
        diagnostics: [],
      },
      cost: {
        totalCostUsd: 0.001,
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 1_000_000,
        durationMs: 300,
        durationApiMs: 250,
        stopReason: "end_turn",
        modelUsed: "claude-haiku-4-5",
        serviceTier: "default",
      },
    };
    const summary = computeSummary([event], 7);
    // 1_000_000 * (0.10 / 1_000_000) = 0.10
    expect(summary.cacheReadCostUsd).toBeCloseTo(0.10, 4);
  });

  test("computes cache_read cost for sonnet model (0.30/1M tokens)", () => {
    const event: TelemetryEvent = {
      type: "decision",
      ts: "2026-05-21T10:00:00.000Z",
      decision: {
        class: "standard",
        classifier: "heuristic",
        confidence: 0.9,
        spec: { model: "sonnet", effort: "medium", maxBudgetUsd: 0.1 },
        latencyMs: 10,
        diagnostics: [],
      },
      cost: {
        totalCostUsd: 0.005,
        inputTokens: 200,
        outputTokens: 100,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 1_000_000,
        durationMs: 500,
        durationApiMs: 450,
        stopReason: "end_turn",
        modelUsed: "claude-sonnet-4-6",
        serviceTier: "default",
      },
    };
    const summary = computeSummary([event], 7);
    // 1_000_000 * (0.30 / 1_000_000) = 0.30
    expect(summary.cacheReadCostUsd).toBeCloseTo(0.30, 4);
  });

  test("cacheReadCostUsd is 0 when no cache_read tokens", () => {
    const summary = computeSummary([makeDecision({ outputTokens: 100 })], 7);
    expect(summary.cacheReadCostUsd).toBe(0);
  });

  test("accumulates cache_read cost across multiple turns", () => {
    const makeCacheRead = (model: string, tokens: number): TelemetryEvent => ({
      type: "decision",
      ts: "2026-05-21T10:00:00.000Z",
      decision: {
        class: "standard",
        classifier: "heuristic",
        confidence: 0.9,
        spec: { model, effort: "medium", maxBudgetUsd: 0.1 },
        latencyMs: 10,
        diagnostics: [],
      },
      cost: {
        totalCostUsd: 0.001,
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: tokens,
        durationMs: 300,
        durationApiMs: 250,
        stopReason: "end_turn",
        modelUsed: `claude-${model}-latest`,
        serviceTier: "default",
      },
    });
    // haiku: 1M * 0.10/1M = 0.10; sonnet: 1M * 0.30/1M = 0.30 → total 0.40
    const events: TelemetryEvent[] = [
      makeCacheRead("haiku", 1_000_000),
      makeCacheRead("sonnet", 1_000_000),
    ];
    const summary = computeSummary(events, 7);
    expect(summary.cacheReadCostUsd).toBeCloseTo(0.40, 4);
  });
});

describe("freshSessionRate", () => {
  test("counts isNewSession=true events as fresh sessions", () => {
    const fresh: TelemetryEvent = {
      ...makeDecision({ outputTokens: 100 }) as Extract<TelemetryEvent, { type: "decision" }>,
      isNewSession: true,
    };
    const reused: TelemetryEvent = {
      ...makeDecision({ outputTokens: 100 }) as Extract<TelemetryEvent, { type: "decision" }>,
      isNewSession: false,
    };
    const summary = computeSummary([fresh, reused, fresh], 7);
    // 2 fresh out of 3 = 0.6667
    expect(summary.freshSessionRate).toBeCloseTo(2 / 3, 3);
  });

  test("events missing isNewSession do not count as fresh", () => {
    const events: TelemetryEvent[] = [
      makeDecision({ outputTokens: 100 }), // undefined isNewSession
      makeDecision({ outputTokens: 100 }),
    ];
    const summary = computeSummary(events, 7);
    expect(summary.freshSessionRate).toBe(0);
  });

  test("freshSessionRate is 0 with no events", () => {
    const summary = computeSummary([], 7);
    expect(summary.freshSessionRate).toBe(0);
  });

  test("freshSessionRate is 1 when all turns are fresh sessions", () => {
    const events: TelemetryEvent[] = [
      { ...makeDecision({ outputTokens: 100 }) as Extract<TelemetryEvent, { type: "decision" }>, isNewSession: true },
      { ...makeDecision({ outputTokens: 100 }) as Extract<TelemetryEvent, { type: "decision" }>, isNewSession: true },
    ];
    const summary = computeSummary(events, 7);
    expect(summary.freshSessionRate).toBe(1);
  });

  test("isNewSession=false does not count as fresh", () => {
    const events: TelemetryEvent[] = [
      { ...makeDecision({ outputTokens: 100 }) as Extract<TelemetryEvent, { type: "decision" }>, isNewSession: false },
      { ...makeDecision({ outputTokens: 100 }) as Extract<TelemetryEvent, { type: "decision" }>, isNewSession: true },
    ];
    const summary = computeSummary(events, 7);
    expect(summary.freshSessionRate).toBeCloseTo(0.5, 3);
  });

  test("freshSessionCount is the raw integer count of fresh sessions", () => {
    const fresh: TelemetryEvent = {
      ...makeDecision({ outputTokens: 100 }) as Extract<TelemetryEvent, { type: "decision" }>,
      isNewSession: true,
    };
    const reused: TelemetryEvent = {
      ...makeDecision({ outputTokens: 100 }) as Extract<TelemetryEvent, { type: "decision" }>,
      isNewSession: false,
    };
    const summary = computeSummary([fresh, reused, fresh, fresh], 7);
    expect(summary.freshSessionCount).toBe(3);
  });

  test("freshSessionCount is 0 with no events", () => {
    const summary = computeSummary([], 7);
    expect(summary.freshSessionCount).toBe(0);
  });

  test("freshSessionCount is 0 when no events have isNewSession=true", () => {
    const events: TelemetryEvent[] = [
      makeDecision({ outputTokens: 100 }),
      makeDecision({ outputTokens: 100 }),
    ];
    const summary = computeSummary(events, 7);
    expect(summary.freshSessionCount).toBe(0);
  });
});

describe("autoCompactCount", () => {
  test("returns 0 when no compact events", () => {
    const events: TelemetryEvent[] = [makeDecision(), makeDecision({ outputTokens: 100 })];
    const summary = computeSummary(events, 7);
    expect(summary.autoCompactCount).toBe(0);
  });

  test("returns 0 with no events", () => {
    const summary = computeSummary([], 7);
    expect(summary.autoCompactCount).toBe(0);
  });

  test("counts compact events correctly", () => {
    const compact: TelemetryEvent = {
      type: "compact",
      ts: "2026-05-21T10:00:00.000Z",
      sessionId: "sess-abc",
      priorCacheReadTokens: 350_000,
    };
    const events: TelemetryEvent[] = [makeDecision(), compact, compact];
    const summary = computeSummary(events, 7);
    expect(summary.autoCompactCount).toBe(2);
  });

  test("compact events do not affect totalRequests", () => {
    const compact: TelemetryEvent = {
      type: "compact",
      ts: "2026-05-21T10:00:00.000Z",
      sessionId: "sess-abc",
      priorCacheReadTokens: 350_000,
    };
    const events: TelemetryEvent[] = [makeDecision({ outputTokens: 100 }), compact];
    const summary = computeSummary(events, 7);
    expect(summary.totalRequests).toBe(1);
    expect(summary.autoCompactCount).toBe(1);
  });

  test("compact events do not affect totalCostUsd or cacheHitRate", () => {
    const compact: TelemetryEvent = {
      type: "compact",
      ts: "2026-05-21T10:00:00.000Z",
      sessionId: "sess-abc",
      priorCacheReadTokens: 400_000,
    };
    const events: TelemetryEvent[] = [compact, compact, compact];
    const summary = computeSummary(events, 7);
    expect(summary.totalCostUsd).toBe(0);
    expect(summary.cacheHitRate).toBe(0);
    expect(summary.autoCompactCount).toBe(3);
  });
});

describe("durationApiMsP90ByClass", () => {
  test("p90 of 10 values is at index 8", () => {
    // 10 standard decisions with durationApiMs: 100, 200, ..., 1000
    // sorted ascending: [100, 200, ..., 1000]
    // idx = ceil(10 * 0.9) - 1 = 8, arr[8] = 900
    const events: TelemetryEvent[] = Array.from({ length: 10 }, (_, i) =>
      makeDecision({
        cls: "standard",
        outputTokens: 100,
        durationApiMs: (i + 1) * 100,
      }),
    );
    const summary = computeSummary(events, 7);
    expect(summary.durationApiMsP90ByClass["standard"]).toBe(900);
  });

  test("returns undefined for class with no duration data", () => {
    const events: TelemetryEvent[] = [
      makeDecision({ cls: "standard" }), // no cost field → no durationApiMs
    ];
    const summary = computeSummary(events, 7);
    expect(summary.durationApiMsP90ByClass["standard"]).toBeUndefined();
  });

  test("does not include class with no events at all", () => {
    const summary = computeSummary([], 7);
    expect(summary.durationApiMsP90ByClass["trivial"]).toBeUndefined();
  });

  test("p90 of single value returns that value", () => {
    const events: TelemetryEvent[] = [
      makeDecision({ cls: "hard", outputTokens: 100, durationApiMs: 250 }),
    ];
    const summary = computeSummary(events, 7);
    expect(summary.durationApiMsP90ByClass["hard"]).toBe(250);
  });

  test("tracks duration per class independently", () => {
    const events: TelemetryEvent[] = [
      makeDecision({ cls: "trivial", outputTokens: 50, durationApiMs: 150 }),
      makeDecision({ cls: "trivial", outputTokens: 50, durationApiMs: 200 }),
      makeDecision({ cls: "standard", outputTokens: 100, durationApiMs: 500 }),
    ];
    const summary = computeSummary(events, 7);
    expect(summary.durationApiMsP90ByClass["trivial"]).toBe(200);
    expect(summary.durationApiMsP90ByClass["standard"]).toBe(500);
    expect(summary.durationApiMsP90ByClass["simple"]).toBeUndefined();
  });

  test("p90 of 100 values is at index 89", () => {
    const events: TelemetryEvent[] = Array.from({ length: 100 }, (_, i) =>
      makeDecision({
        cls: "hard",
        outputTokens: 100,
        durationApiMs: i + 1,
      }),
    );
    const summary = computeSummary(events, 7);
    // sorted: [1, 2, ..., 100], idx = ceil(100 * 0.9) - 1 = 89, arr[89] = 90
    expect(summary.durationApiMsP90ByClass["hard"]).toBe(90);
  });
});

describe("computeTrend", () => {
  test("0 events → windowDays buckets all zero/null", () => {
    const buckets = computeTrend([], 7);
    expect(buckets).toHaveLength(7);
    for (const b of buckets) {
      expect(b.requests).toBe(0);
      expect(b.costUsd).toBe(0);
      expect(b.baselineUsd).toBe(0);
      expect(b.savingsRatio).toBeNull();
      expect(b.topModel).toBeNull();
      expect(b.topModelCount).toBe(0);
    }
  });

  test("buckets are sorted by date ascending", () => {
    const buckets = computeTrend([], 5);
    expect(buckets).toHaveLength(5);
    for (let i = 1; i < buckets.length; i++) {
      expect(buckets[i]!.date > buckets[i - 1]!.date).toBe(true);
    }
  });

  test("events on specific dates are bucketed correctly", () => {
    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);
    const event: TelemetryEvent = {
      type: "decision",
      ts: todayStr + "T12:00:00.000Z",
      decision: {
        class: "standard",
        classifier: "heuristic",
        confidence: 0.9,
        spec: { model: "sonnet", effort: "medium", maxBudgetUsd: 0.1 },
        latencyMs: 10,
        diagnostics: [],
      },
      cost: {
        totalCostUsd: 0.001,
        inputTokens: 100,
        outputTokens: 200,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        durationMs: 500,
        durationApiMs: 400,
        stopReason: "end_turn",
        modelUsed: "claude-sonnet-4-6",
        serviceTier: "default",
      },
    };
    const buckets = computeTrend([event], 7);
    expect(buckets).toHaveLength(7);
    const todayBucket = buckets.find((b) => b.date === todayStr);
    expect(todayBucket).toBeDefined();
    expect(todayBucket!.requests).toBe(1);
    expect(todayBucket!.topModel).toBe("sonnet");
    expect(todayBucket!.topModelCount).toBe(1);
    expect(todayBucket!.savingsRatio).not.toBeNull();
  });

  test("events outside the window are not included", () => {
    // Use a date 30 days ago — outside a 7-day window
    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const event: TelemetryEvent = {
      type: "decision",
      ts: oldDate + "T12:00:00.000Z",
      decision: {
        class: "standard",
        classifier: "heuristic",
        confidence: 0.9,
        spec: { model: "haiku", effort: "low", maxBudgetUsd: 0.05 },
        latencyMs: 5,
        diagnostics: [],
      },
      cost: {
        totalCostUsd: 0.0001,
        inputTokens: 50,
        outputTokens: 100,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        durationMs: 200,
        durationApiMs: 180,
        stopReason: "end_turn",
        modelUsed: "claude-haiku-4-5",
        serviceTier: "default",
      },
    };
    const buckets = computeTrend([event], 7);
    expect(buckets.every((b) => b.requests === 0)).toBe(true);
  });

  test("mixed-day events are grouped into separate buckets", () => {
    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);
    const yesterdayStr = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const makeEvent = (dateStr: string, model: string): TelemetryEvent => ({
      type: "decision",
      ts: dateStr + "T10:00:00.000Z",
      decision: {
        class: "trivial",
        classifier: "heuristic",
        confidence: 0.95,
        spec: { model, effort: "low", maxBudgetUsd: 0.05 },
        latencyMs: 5,
        diagnostics: [],
      },
      cost: {
        totalCostUsd: 0.0001,
        inputTokens: 50,
        outputTokens: 100,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        durationMs: 200,
        durationApiMs: 180,
        stopReason: "end_turn",
        modelUsed: model === "haiku" ? "claude-haiku-4-5" : "claude-sonnet-4-6",
        serviceTier: "default",
      },
    });

    const events: TelemetryEvent[] = [
      makeEvent(todayStr, "haiku"),
      makeEvent(todayStr, "haiku"),
      makeEvent(yesterdayStr, "sonnet"),
    ];
    const buckets = computeTrend(events, 7);
    const todayBucket = buckets.find((b) => b.date === todayStr);
    const yestBucket = buckets.find((b) => b.date === yesterdayStr);
    expect(todayBucket?.requests).toBe(2);
    expect(todayBucket?.topModel).toBe("haiku");
    expect(yestBucket?.requests).toBe(1);
    expect(yestBucket?.topModel).toBe("sonnet");
  });
});
