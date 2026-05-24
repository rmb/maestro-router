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

  test("ignores decision events — only override events produce patterns", () => {
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
