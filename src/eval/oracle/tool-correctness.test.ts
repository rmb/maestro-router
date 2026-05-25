// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import type { TelemetryEvent } from "../../core/types.js";
import type { SessionRecord } from "../../wrapper/session.js";
import { computeFingerprint } from "../../wrapper/prewarm.js";
import { CONTINUATION_HINT } from "../../wrapper/continuation.js";
import {
  checkE1Escalation,
  checkFingerprintStability,
  checkFlagCoverage,
  checkK1Invalidation,
  checkM1TwoSignal,
  runToolCorrectness,
} from "./tool-correctness.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDecision(opts: {
  tsMs?: number;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  cls?: Extract<TelemetryEvent, { type: "decision" }>["decision"]["class"];
  classifier?: string;
  stopReason?: string;
  modelUsed?: string;
  prompt?: string;
  appendSystemPrompt?: string;
  tools?: string;
  mcpConfig?: string;
  bare?: boolean;
  excludeDynamicSections?: boolean;
  noCost?: boolean;
}): Extract<TelemetryEvent, { type: "decision" }> {
  const model = opts.model ?? "sonnet";
  const effort = opts.effort ?? "medium";
  const spec = {
    model,
    effort,
    maxBudgetUsd: 0.1,
    ...(opts.appendSystemPrompt !== undefined ? { appendSystemPrompt: opts.appendSystemPrompt } : {}),
    ...(opts.tools !== undefined ? { tools: opts.tools } : {}),
    ...(opts.mcpConfig !== undefined ? { mcpConfig: opts.mcpConfig } : {}),
    ...(opts.bare !== undefined ? { bare: opts.bare } : {}),
    ...(opts.excludeDynamicSections !== undefined ? { excludeDynamicSections: opts.excludeDynamicSections } : {}),
  };

  const costField = opts.noCost
    ? {}
    : {
        cost: {
          totalCostUsd: 0.01,
          inputTokens: 100,
          outputTokens: 50,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          durationMs: 200,
          durationApiMs: 180,
          stopReason: opts.stopReason ?? "end_turn",
          modelUsed: opts.modelUsed ?? `claude-${model}-4-5`,
          serviceTier: "standard",
        },
      };

  return {
    type: "decision",
    ts: new Date(opts.tsMs ?? Date.now()).toISOString(),
    decision: {
      class: opts.cls ?? "standard",
      classifier: opts.classifier ?? "heuristic",
      confidence: 0.8,
      spec,
      latencyMs: 5,
      diagnostics: [],
    },
    ...(opts.prompt !== undefined ? { prompt: opts.prompt } : {}),
    ...costField,
  };
}

function makeSession(opts: {
  model?: string;
  fingerprint?: string;
  cwd?: string;
}): SessionRecord {
  return {
    sessionId: "sess-" + Math.random().toString(36).slice(2),
    cwd: opts.cwd ?? "/home/user/project",
    modelTier: opts.model,
    systemPromptFingerprint: opts.fingerprint,
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// checkFingerprintStability
// ---------------------------------------------------------------------------

describe("checkFingerprintStability", () => {
  test("passes when all decision specs have matching sessions", () => {
    const spec = { model: "sonnet", effort: "medium" as const, maxBudgetUsd: 0.1 };
    const fp = computeFingerprint(spec);
    const events: TelemetryEvent[] = [
      makeDecision({ model: "sonnet" }),
      makeDecision({ model: "sonnet" }),
    ];
    const sessions: SessionRecord[] = [makeSession({ fingerprint: fp })];
    const result = checkFingerprintStability(events, sessions);
    expect(result.pass).toBe(true);
    expect(result.value).toBe("100.0%");
    expect(result.detail).toBeUndefined();
  });

  test("fails when some decision specs have no matching session", () => {
    // Events use model "opus" but sessions only have "sonnet" fingerprint
    const sonetSpec = { model: "sonnet", effort: "medium" as const, maxBudgetUsd: 0.1 };
    const sonetFp = computeFingerprint(sonetSpec);

    const events: TelemetryEvent[] = [
      // 2 decisions use "sonnet" (will match) and 18 use "opus" (no match)
      ...Array.from({ length: 2 }, () => makeDecision({ model: "sonnet" })),
      ...Array.from({ length: 18 }, () => makeDecision({ model: "opus" })),
    ];
    const sessions: SessionRecord[] = [
      makeSession({ fingerprint: sonetFp, model: "sonnet" }),
    ];
    const result = checkFingerprintStability(events, sessions);
    expect(result.pass).toBe(false);
    expect(result.detail).toContain("Track Z");
    expect(result.detail).toContain("getByFingerprint");
  });

  test("passes trivially with empty events and no sessions (bootstrapping)", () => {
    const result = checkFingerprintStability([], []);
    expect(result.pass).toBe(true);
    expect(result.value).toBe("n/a (bootstrapping)");
  });

  test("passes trivially with empty events but computed sessions present", () => {
    const session = { sessionId: "s1", cwd: "/x", systemPromptFingerprint: "abc123", createdAt: "2026-01-01T00:00:00Z", lastUsedAt: "2026-01-01T00:00:00Z" };
    const result = checkFingerprintStability([], [session]);
    expect(result.pass).toBe(true);
    expect(result.value).toBe("100.0%");
  });

  test("gate label is ≥95%", () => {
    const session = { sessionId: "s1", cwd: "/x", systemPromptFingerprint: "abc123", createdAt: "2026-01-01T00:00:00Z", lastUsedAt: "2026-01-01T00:00:00Z" };
    const result = checkFingerprintStability([], [session]);
    expect(result.gate).toBe("≥95%");
  });
});

// ---------------------------------------------------------------------------
// checkFlagCoverage
// ---------------------------------------------------------------------------

describe("checkFlagCoverage", () => {
  test("passes when model matches in all decisions", () => {
    const events: TelemetryEvent[] = [
      makeDecision({ model: "sonnet", modelUsed: "claude-sonnet-4-5" }),
      makeDecision({ model: "haiku", modelUsed: "claude-haiku-3-5" }),
    ];
    const result = checkFlagCoverage(events);
    expect(result.pass).toBe(true);
    expect(result.value).toBe("100.0%");
    expect(result.detail).toBeUndefined();
  });

  test("fails when model does not match", () => {
    // Build 20 events where most have mismatching models
    const events: TelemetryEvent[] = [
      ...Array.from({ length: 18 }, () =>
        makeDecision({ model: "opus", modelUsed: "claude-haiku-4-5" }),
      ),
      makeDecision({ model: "sonnet", modelUsed: "claude-sonnet-4-5" }),
      makeDecision({ model: "haiku", modelUsed: "claude-haiku-4-5" }),
    ];
    const result = checkFlagCoverage(events);
    expect(result.pass).toBe(false);
    expect(result.detail).toContain("spec.model mismatch");
    expect(result.detail).toContain("spawn.ts");
  });

  test("skips decisions without a cost field", () => {
    // Only the noCost decision exists — considered trivially passing
    const events: TelemetryEvent[] = [
      makeDecision({ noCost: true }),
    ];
    const result = checkFlagCoverage(events);
    expect(result.pass).toBe(true);
    expect(result.value).toBe("100.0%");
  });

  test("passes trivially with empty events", () => {
    const result = checkFlagCoverage([]);
    expect(result.pass).toBe(true);
  });

  test("gate label is ≥80%", () => {
    const result = checkFlagCoverage([]);
    expect(result.gate).toBe("≥80%");
  });
});

// ---------------------------------------------------------------------------
// checkE1Escalation
// ---------------------------------------------------------------------------

describe("checkE1Escalation", () => {
  test("passes when max_tokens is followed by effort=medium", () => {
    const now = Date.now();
    const events: TelemetryEvent[] = [
      makeDecision({ tsMs: now, cls: "standard", effort: "low", stopReason: "max_tokens" }),
      makeDecision({ tsMs: now + 1000, cls: "standard", effort: "medium" }),
    ];
    const result = checkE1Escalation(events);
    expect(result.pass).toBe(true);
    expect(result.value).toBe("100.0%");
    expect(result.detail).toBeUndefined();
  });

  test("fails when max_tokens is NOT followed by effort escalation", () => {
    const now = Date.now();
    // 5 max_tokens cases, none escalated
    const events: TelemetryEvent[] = Array.from({ length: 10 }, (_, i) =>
      makeDecision({
        tsMs: now + i * 1000,
        cls: "standard",
        effort: "low",
        stopReason: i % 2 === 0 ? "max_tokens" : "end_turn",
      }),
    );
    const result = checkE1Escalation(events);
    expect(result.pass).toBe(false);
    expect(result.detail).toContain("max_tokens standard turns were NOT followed by effort escalation");
    expect(result.detail).toContain("E1.escalate");
  });

  test("passes trivially when no max_tokens cases exist", () => {
    const now = Date.now();
    const events: TelemetryEvent[] = [
      makeDecision({ tsMs: now, cls: "standard", effort: "low", stopReason: "end_turn" }),
      makeDecision({ tsMs: now + 1000, cls: "standard", effort: "low", stopReason: "end_turn" }),
    ];
    const result = checkE1Escalation(events);
    expect(result.pass).toBe(true);
    expect(result.value).toBe("100.0%");
  });

  test("passes trivially with empty events", () => {
    const result = checkE1Escalation([]);
    expect(result.pass).toBe(true);
  });

  test("gate label is ≥80%", () => {
    const result = checkE1Escalation([]);
    expect(result.gate).toBe("≥80%");
  });

  test("escalation check only targets standard class with effort=low", () => {
    const now = Date.now();
    // hard class with max_tokens should be ignored
    const events: TelemetryEvent[] = [
      makeDecision({ tsMs: now, cls: "hard", effort: "high", stopReason: "max_tokens" }),
      makeDecision({ tsMs: now + 1000, cls: "hard", effort: "high" }),
    ];
    const result = checkE1Escalation(events);
    // No standard+low cases → trivially pass
    expect(result.pass).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkK1Invalidation
// ---------------------------------------------------------------------------

describe("checkK1Invalidation", () => {
  test("passes when no duplicate prompts exist", () => {
    const now = Date.now();
    const events: TelemetryEvent[] = [
      makeDecision({ tsMs: now, prompt: "prompt A", stopReason: "end_turn" }),
      makeDecision({ tsMs: now + 1000, prompt: "prompt B", stopReason: "end_turn" }),
    ];
    const result = checkK1Invalidation(events);
    expect(result.pass).toBe(true);
    expect(result.value).toBe("0");
  });

  test("passes when duplicate with max_tokens is correctly reclassified (not k1-cache)", () => {
    const now = Date.now();
    const events: TelemetryEvent[] = [
      makeDecision({ tsMs: now, prompt: "same prompt", classifier: "heuristic", stopReason: "max_tokens" }),
      makeDecision({ tsMs: now + 1000, prompt: "same prompt", classifier: "heuristic", stopReason: "end_turn" }),
    ];
    const result = checkK1Invalidation(events);
    expect(result.pass).toBe(true);
    expect(result.value).toBe("0");
  });

  test("fails when duplicate with max_tokens gets k1-cache hit", () => {
    const now = Date.now();
    const events: TelemetryEvent[] = [
      makeDecision({ tsMs: now, prompt: "cached prompt", classifier: "heuristic", stopReason: "max_tokens" }),
      makeDecision({ tsMs: now + 1000, prompt: "cached prompt", classifier: "k1-cache", stopReason: "end_turn" }),
    ];
    const result = checkK1Invalidation(events);
    expect(result.pass).toBe(false);
    expect(result.value).toBe("1");
    expect(result.detail).toContain("K1 cache not invalidated after max_tokens");
  });

  test("does not flag duplicates beyond 24h window", () => {
    const now = Date.now();
    const twentyFiveHoursMs = 25 * 60 * 60 * 1000;
    const events: TelemetryEvent[] = [
      makeDecision({ tsMs: now, prompt: "old prompt", stopReason: "max_tokens" }),
      makeDecision({ tsMs: now + twentyFiveHoursMs, prompt: "old prompt", classifier: "k1-cache" }),
    ];
    const result = checkK1Invalidation(events);
    // Beyond window — not a violation
    expect(result.pass).toBe(true);
  });

  test("gate label is 0 failures", () => {
    const result = checkK1Invalidation([]);
    expect(result.gate).toBe("0 failures");
  });
});

// ---------------------------------------------------------------------------
// checkM1TwoSignal
// ---------------------------------------------------------------------------

describe("checkM1TwoSignal", () => {
  test("passes when hint is injected with both signals", () => {
    const now = Date.now();
    const events: TelemetryEvent[] = [
      // prior turn ended max_tokens
      makeDecision({ tsMs: now, stopReason: "max_tokens" }),
      // current turn: short continuation prompt + hint injected
      makeDecision({
        tsMs: now + 1000,
        prompt: "continue",
        appendSystemPrompt: CONTINUATION_HINT,
      }),
    ];
    const result = checkM1TwoSignal(events);
    expect(result.pass).toBe(true);
    expect(result.value).toBe("0");
    expect(result.detail).toBeUndefined();
  });

  test("fails when hint is injected without prior max_tokens", () => {
    const now = Date.now();
    const events: TelemetryEvent[] = [
      // prior turn ended normally
      makeDecision({ tsMs: now, stopReason: "end_turn" }),
      // current turn: continuation prompt + hint, but no prior max_tokens
      makeDecision({
        tsMs: now + 1000,
        prompt: "continue",
        appendSystemPrompt: CONTINUATION_HINT,
      }),
    ];
    const result = checkM1TwoSignal(events);
    expect(result.pass).toBe(false);
    expect(result.value).toBe("1");
    expect(result.detail).toContain("CONTINUATION_HINT without both signals");
    expect(result.detail).toContain("M1 two-signal guard");
  });

  test("fails when hint is injected without linguistic signal (long prompt)", () => {
    const now = Date.now();
    const longPrompt = "Please write me a long essay about the history of computing and how it has shaped modern society in many different ways.";
    const events: TelemetryEvent[] = [
      makeDecision({ tsMs: now, stopReason: "max_tokens" }),
      makeDecision({
        tsMs: now + 1000,
        prompt: longPrompt,
        appendSystemPrompt: CONTINUATION_HINT,
      }),
    ];
    const result = checkM1TwoSignal(events);
    // long prompt is not linguistic — violation
    expect(result.pass).toBe(false);
    expect(result.value).toBe("1");
  });

  test("passes trivially when no continuation hint is used", () => {
    const now = Date.now();
    const events: TelemetryEvent[] = [
      makeDecision({ tsMs: now, stopReason: "end_turn" }),
      makeDecision({ tsMs: now + 1000, prompt: "tell me more" }),
    ];
    const result = checkM1TwoSignal(events);
    expect(result.pass).toBe(true);
    expect(result.value).toBe("0");
  });

  test("passes trivially with empty events", () => {
    const result = checkM1TwoSignal([]);
    expect(result.pass).toBe(true);
  });

  test("gate label is 0 violations", () => {
    const result = checkM1TwoSignal([]);
    expect(result.gate).toBe("0 violations");
  });
});

// ---------------------------------------------------------------------------
// runToolCorrectness
// ---------------------------------------------------------------------------

describe("runToolCorrectness", () => {
  test("dimension is 'tool'", () => {
    const result = runToolCorrectness([], []);
    expect(result.dimension).toBe("tool");
  });

  test("returns 5 checks", () => {
    const result = runToolCorrectness([], []);
    expect(result.checks).toHaveLength(5);
  });

  test("pass is true when all checks pass (empty inputs)", () => {
    const result = runToolCorrectness([], []);
    expect(result.pass).toBe(true);
    expect(result.checks.every((c) => c.pass)).toBe(true);
  });

  test("pass is false when one check fails", () => {
    const now = Date.now();
    // Trigger a k1-invalidation failure
    const events: TelemetryEvent[] = [
      makeDecision({ tsMs: now, prompt: "dup prompt", classifier: "heuristic", stopReason: "max_tokens" }),
      makeDecision({ tsMs: now + 1000, prompt: "dup prompt", classifier: "k1-cache", stopReason: "end_turn" }),
    ];
    const result = runToolCorrectness(events, []);
    expect(result.pass).toBe(false);
    const failed = result.checks.filter((c) => !c.pass);
    expect(failed.length).toBeGreaterThanOrEqual(1);
  });

  test("check names are as expected", () => {
    const result = runToolCorrectness([], []);
    const names = result.checks.map((c) => c.name);
    expect(names).toContain("fingerprint-stability");
    expect(names).toContain("flag-coverage");
    expect(names).toContain("e1-escalation");
    expect(names).toContain("k1-invalidation");
    expect(names).toContain("m1-two-signal");
  });
});
