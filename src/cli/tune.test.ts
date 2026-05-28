// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { computeSuggestions } from "./tune.js";
import type { TelemetryEvent } from "../core/types.js";

describe("computeSuggestions with override events (PostHog-shaped input)", () => {
  test("mines pattern from 5+ matching override events", () => {
    const overrides: TelemetryEvent[] = Array.from({ length: 6 }, (_, i) => ({
      type: "override" as const,
      ts: new Date().toISOString(),
      from: "hard" as const,
      to: "max" as const,
      prompt: `production is down check the frobnicate logs ${i}`,
    }));

    const result = computeSuggestions(overrides, { learnOnly: true });
    const patterns = result.learnedHeuristics.map((r) => r.pattern);
    expect(patterns.some((p) => p.includes("frobnicate"))).toBe(true);
  });

  test("does not suggest pattern with fewer than 5 occurrences", () => {
    const overrides: TelemetryEvent[] = Array.from({ length: 3 }, () => ({
      type: "override" as const,
      ts: new Date().toISOString(),
      from: "hard" as const,
      to: "max" as const,
      prompt: "rareword something here",
    }));

    const result = computeSuggestions(overrides, { learnOnly: true });
    const patterns = result.learnedHeuristics.map((r) => r.pattern);
    expect(patterns.some((p) => p.includes("rareword"))).toBe(false);
  });

  test("ignores non-fallback decision events — only forced.standard decisions feed mining", () => {
    const events: TelemetryEvent[] = Array.from({ length: 10 }, () => ({
      type: "decision" as const,
      ts: new Date().toISOString(),
      decision: {
        class: "hard" as const,
        classifier: "heuristic",
        confidence: 0.8,
        spec: { model: "sonnet" as const, effort: "high" as const, maxBudgetUsd: 3.0 },
        latencyMs: 0,
        diagnostics: [],
      },
      prompt: "uniquetoken something here",
    }));

    const result = computeSuggestions(events, { learnOnly: true });
    expect(result.learnedHeuristics).toHaveLength(0);
  });

  test("returns sorted by matchedCount descending", () => {
    const make = (word: string, count: number): TelemetryEvent[] =>
      Array.from({ length: count }, () => ({
        type: "override" as const,
        ts: new Date().toISOString(),
        from: "hard" as const,
        to: "max" as const,
        prompt: `${word} some context words that are long`,
      }));

    const events = [...make("zebra", 8), ...make("alpha", 5)];
    const result = computeSuggestions(events, { learnOnly: true });
    const matches = result.learnedHeuristics.filter((r) => r.pattern.includes("zebra") || r.pattern.includes("alpha"));
    expect(matches[0]!.matchedCount).toBeGreaterThanOrEqual(matches[matches.length - 1]!.matchedCount);
  });
});

describe("computeSuggestions with correction events (implicit mis-classification signal)", () => {
  test("correction events contribute to pattern learning with higher weight than overrides", () => {
    // 4 corrections (weight 1.5 each = 6.0 effective) + 0 overrides → above MIN_PATTERN_OCCURRENCES=5
    const corrections: TelemetryEvent[] = Array.from({ length: 4 }, () => ({
      type: "correction" as const,
      ts: new Date().toISOString(),
      sessionId: "sess-1",
      prevClass: "standard" as const,
      correctedToClass: "hard" as const,
      hint: "deep",
      prevPrompt: "refactor authentication middleware layer xyzzy",
    }));

    const result = computeSuggestions(corrections, { learnOnly: true });
    const patterns = result.learnedHeuristics.map((r) => r.pattern);
    expect(patterns.some((p) => p.includes("xyzzy"))).toBe(true);
  });

  test("correction events targeting a class set the correct class on the learned rule", () => {
    const corrections: TelemetryEvent[] = Array.from({ length: 6 }, () => ({
      type: "correction" as const,
      ts: new Date().toISOString(),
      sessionId: "sess-1",
      prevClass: "standard" as const,
      correctedToClass: "reasoning" as const,
      hint: "deep",
      prevPrompt: "why is the quuxinator failing under concurrent load abcde",
    }));

    const result = computeSuggestions(corrections, { learnOnly: true });
    const quux = result.learnedHeuristics.find((r) => r.pattern.includes("quuxinator"));
    expect(quux).toBeDefined();
    expect(quux!.class).toBe("reasoning");
  });

  test("correction confidence is derived from class purity, not hardcoded", () => {
    // 6 corrections → max, 1 correction → hard: precision ≈ 6/7 → high confidence
    const dominant: TelemetryEvent[] = Array.from({ length: 6 }, () => ({
      type: "correction" as const,
      ts: new Date().toISOString(),
      sessionId: "s",
      prevClass: "standard" as const,
      correctedToClass: "max" as const,
      hint: "deep",
      prevPrompt: "uniquetoken222 context here now",
    }));
    const minority: TelemetryEvent = {
      type: "correction" as const,
      ts: new Date().toISOString(),
      sessionId: "s",
      prevClass: "max" as const,
      correctedToClass: "hard" as const,
      hint: "fast",
      prevPrompt: "uniquetoken222 other context",
    };
    const result = computeSuggestions([...dominant, minority], { learnOnly: true });
    const r = result.learnedHeuristics.find((h) => h.pattern.includes("uniquetoken222"));
    expect(r).toBeDefined();
    // precision = (6*1.5 + α) / (6*1.5 + 1.0*1.5 + α*n) — should be well above 0.6
    expect(r!.confidence).toBeGreaterThan(0.6);
    // but not fixed at 0.85
    expect(r!.class).toBe("max");
  });

  test("mixed override and correction events combine their weights", () => {
    // 3 overrides (weight 1.0 each = 3.0) + 2 corrections (weight 1.5 each = 3.0) = 6.0 ≥ 5
    const overrides: TelemetryEvent[] = Array.from({ length: 3 }, () => ({
      type: "override" as const,
      ts: new Date().toISOString(),
      from: "standard" as const,
      to: "hard" as const,
      prompt: "deploy zorbiflex production cluster",
    }));
    const corrections: TelemetryEvent[] = Array.from({ length: 2 }, () => ({
      type: "correction" as const,
      ts: new Date().toISOString(),
      sessionId: "s",
      prevClass: "standard" as const,
      correctedToClass: "hard" as const,
      hint: "deep",
      prevPrompt: "deploy zorbiflex to staging environment",
    }));
    const result = computeSuggestions([...overrides, ...corrections], { learnOnly: true });
    const patterns = result.learnedHeuristics.map((r) => r.pattern);
    expect(patterns.some((p) => p.includes("zorbiflex"))).toBe(true);
  });
});

describe("computeSuggestions with forced.standard decision events (fallback mining)", () => {
  const makeFallback = (prompt: string): TelemetryEvent => ({
    type: "decision" as const,
    ts: new Date().toISOString(),
    decision: {
      class: "standard" as const,
      classifier: "forced.standard",
      confidence: 0.1,
      spec: { model: "sonnet" as const, effort: "medium" as const, maxBudgetUsd: 3.0 },
      latencyMs: 0,
      diagnostics: [{ severity: "warning" as const, code: "fallback.forced_standard", message: "" }],
    },
    prompt,
  });

  test("mines pattern from 5+ forced.standard decision events", () => {
    const events: TelemetryEvent[] = Array.from({ length: 6 }, (_, i) =>
      makeFallback(`prismatic ${i} some context here`),
    );

    const result = computeSuggestions(events, { learnOnly: true });
    const patterns = result.learnedHeuristics.map((r) => r.pattern);
    expect(patterns.some((p) => p.includes("prismatic"))).toBe(true);
  });

  test("defaults fallback class to 'simple' when no token-affinity signal exists", () => {
    const events: TelemetryEvent[] = Array.from({ length: 6 }, () =>
      makeFallback("unmappedfoo unmappedbar"),
    );

    const result = computeSuggestions(events, { learnOnly: true });
    const r = result.learnedHeuristics.find((h) => h.pattern.includes("unmappedfoo"));
    expect(r).toBeDefined();
    expect(r!.class).toBe("simple");
  });

  test("resolves fallback class from token-affinity built on successful decisions", () => {
    // Successful decisions associate "frobnicate" with "hard"
    const successful: TelemetryEvent[] = Array.from({ length: 8 }, () => ({
      type: "decision" as const,
      ts: new Date().toISOString(),
      decision: {
        class: "hard" as const,
        classifier: "heuristic",
        confidence: 0.8,
        spec: { model: "sonnet" as const, effort: "high" as const, maxBudgetUsd: 3.0 },
        latencyMs: 0,
        diagnostics: [],
      },
      prompt: "refactor frobnicate config carefully",
    }));
    // Fallback prompts also containing "frobnicate" should be classified as "hard"
    const fallbacks: TelemetryEvent[] = Array.from({ length: 6 }, () =>
      makeFallback("frobnicate signinator something"),
    );

    const result = computeSuggestions([...successful, ...fallbacks], { learnOnly: true });
    const r = result.learnedHeuristics.find((h) => h.pattern.includes("signinator"));
    expect(r).toBeDefined();
    expect(r!.class).toBe("hard");
  });

  test("low-confidence successful decisions do not contribute to affinity", () => {
    // Low-confidence (< 0.6) decisions are ignored when building affinity.
    const lowConf: TelemetryEvent[] = Array.from({ length: 10 }, () => ({
      type: "decision" as const,
      ts: new Date().toISOString(),
      decision: {
        class: "max" as const,
        classifier: "heuristic",
        confidence: 0.3,
        spec: { model: "opus" as const, effort: "max" as const, maxBudgetUsd: 10.0 },
        latencyMs: 0,
        diagnostics: [],
      },
      prompt: "shouldnotleak across",
    }));
    const fallbacks: TelemetryEvent[] = Array.from({ length: 6 }, () =>
      makeFallback("shouldnotleak fallbackmarker"),
    );

    const result = computeSuggestions([...lowConf, ...fallbacks], { learnOnly: true });
    const r = result.learnedHeuristics.find((h) => h.pattern.includes("fallbackmarker"));
    expect(r).toBeDefined();
    // Affinity for "shouldnotleak" should be empty → defaults to "simple", not "max"
    expect(r!.class).toBe("simple");
  });
});
