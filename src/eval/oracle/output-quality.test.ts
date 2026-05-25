// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import type { TelemetryEvent } from "../../core/types.js";
import {
  checkBenchAccuracy,
  checkE1QualityProbe,
  checkTruncationRate,
  runOutputQuality,
  type SpawnFn,
} from "./output-quality.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStandardDecision(opts: {
  outputTokens: number;
  maxOutputTokens?: number;
  hasCost?: boolean;
}): Extract<TelemetryEvent, { type: "decision" }> {
  const { outputTokens, maxOutputTokens, hasCost = true } = opts;
  return {
    type: "decision",
    ts: new Date().toISOString(),
    decision: {
      class: "standard",
      classifier: "heuristic",
      confidence: 0.8,
      spec: {
        model: "sonnet",
        effort: "medium",
        maxBudgetUsd: 0.1,
        ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      },
      latencyMs: 5,
      diagnostics: [],
    },
    ...(hasCost
      ? {
          cost: {
            totalCostUsd: 0.001,
            inputTokens: 500,
            outputTokens,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            durationMs: 200,
            durationApiMs: 180,
            stopReason: "end_turn",
            modelUsed: "claude-sonnet-4-5",
            serviceTier: "standard",
          },
        }
      : {}),
  };
}

function makeNonStandardDecision(): Extract<TelemetryEvent, { type: "decision" }> {
  return {
    type: "decision",
    ts: new Date().toISOString(),
    decision: {
      class: "max",
      classifier: "override",
      confidence: 1.0,
      spec: { model: "opus", effort: "high", maxBudgetUsd: 1.0, maxOutputTokens: 16000 },
      latencyMs: 2,
      diagnostics: [],
    },
    cost: {
      totalCostUsd: 0.05,
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      durationMs: 400,
      durationApiMs: 380,
      stopReason: "end_turn",
      modelUsed: "claude-opus-4-5",
      serviceTier: "standard",
    },
  };
}

const noopSpawn: SpawnFn = async () => ({ stdout: "", exitCode: null });

// ---------------------------------------------------------------------------
// checkTruncationRate
// ---------------------------------------------------------------------------

describe("checkTruncationRate", () => {
  test("passes with 'n/a (no data)' when no events have cap set", () => {
    // No events at all
    const result = checkTruncationRate([]);
    expect(result.pass).toBe(true);
    expect(result.value).toBe("n/a (no data)");
    expect(result.gate).toBe("<5%");
  });

  test("passes with 'n/a (no data)' when events exist but none have maxOutputTokens", () => {
    const events: TelemetryEvent[] = [
      makeStandardDecision({ outputTokens: 5000 }), // no maxOutputTokens
    ];
    const result = checkTruncationRate(events);
    expect(result.pass).toBe(true);
    expect(result.value).toBe("n/a (no data)");
  });

  test("passes with 'n/a (no data)' when only non-standard decisions have cap", () => {
    const events: TelemetryEvent[] = [makeNonStandardDecision()];
    const result = checkTruncationRate(events);
    expect(result.pass).toBe(true);
    expect(result.value).toBe("n/a (no data)");
  });

  test("fails when 2/20 are near-cap → 10%", () => {
    // 2 near-cap (outputTokens = maxOutputTokens * 0.99 ≥ 0.98 threshold)
    // 18 safe (outputTokens = maxOutputTokens * 0.5)
    const cap = 8000;
    const nearCap = Math.round(cap * 0.99); // 7920 ≥ 7840 (98%)
    const safe = Math.round(cap * 0.5);    // 4000

    const events: TelemetryEvent[] = [
      ...Array.from({ length: 2 }, () =>
        makeStandardDecision({ outputTokens: nearCap, maxOutputTokens: cap }),
      ),
      ...Array.from({ length: 18 }, () =>
        makeStandardDecision({ outputTokens: safe, maxOutputTokens: cap }),
      ),
    ];

    const result = checkTruncationRate(events);
    expect(result.pass).toBe(false);
    expect(result.value).toBe("10.0%");
    expect(result.detail).toContain("2 of 20");
    expect(result.detail).toContain("≥98%");
    expect(result.detail).toContain("maxOutputTokens");
  });

  test("fails at exactly 5% (boundary — < 0.05 is the gate, not <=)", () => {
    // 1/20 = 5% → fails because gate is < 0.05 (strict)
    const cap = 8000;
    const nearCap = Math.round(cap * 0.99);
    const safe = Math.round(cap * 0.5);

    const events: TelemetryEvent[] = [
      makeStandardDecision({ outputTokens: nearCap, maxOutputTokens: cap }),
      ...Array.from({ length: 19 }, () =>
        makeStandardDecision({ outputTokens: safe, maxOutputTokens: cap }),
      ),
    ];

    const result = checkTruncationRate(events);
    expect(result.pass).toBe(false);
    expect(result.value).toBe("5.0%");
  });

  test("passes when 0/20 are near-cap", () => {
    const cap = 8000;
    const safe = Math.round(cap * 0.5);

    const events: TelemetryEvent[] = Array.from({ length: 20 }, () =>
      makeStandardDecision({ outputTokens: safe, maxOutputTokens: cap }),
    );

    const result = checkTruncationRate(events);
    expect(result.pass).toBe(true);
    expect(result.value).toBe("0.0%");
    expect(result.detail).toBeUndefined();
  });

  test("ignores events without cost", () => {
    const cap = 8000;
    // These should be filtered out (no cost, so not eligible)
    const events: TelemetryEvent[] = Array.from({ length: 5 }, () =>
      makeStandardDecision({ outputTokens: 9000, maxOutputTokens: cap, hasCost: false }),
    );
    const result = checkTruncationRate(events);
    expect(result.pass).toBe(true);
    expect(result.value).toBe("n/a (no data)");
  });

  test("name is 'truncation-rate'", () => {
    const result = checkTruncationRate([]);
    expect(result.name).toBe("truncation-rate");
  });
});

// ---------------------------------------------------------------------------
// checkBenchAccuracy
// ---------------------------------------------------------------------------

describe("checkBenchAccuracy", () => {
  test("returns 'skipped' when evalSetPath is empty", async () => {
    const result = await checkBenchAccuracy("", noopSpawn);
    expect(result.pass).toBe(true);
    expect(result.value).toBe("skipped");
    expect(result.name).toBe("bench-accuracy");
    expect(result.gate).toBe("≤2% regression");
    expect(result.detail).toContain("No eval set path");
  });

  test("never calls spawnFn (bench runs in-process)", async () => {
    let called = false;
    const spy: SpawnFn = async () => {
      called = true;
      return { stdout: "", exitCode: 0 };
    };
    // Empty path → skipped without calling spawnFn
    await checkBenchAccuracy("", spy);
    expect(called).toBe(false);
  });

  test("returns error result when eval file does not exist", async () => {
    const result = await checkBenchAccuracy("/nonexistent/path/eval.jsonl", noopSpawn);
    expect(result.pass).toBe(false);
    expect(result.value).toBe("error");
    expect(result.name).toBe("bench-accuracy");
    expect(result.detail).toMatch(/Bench run failed/);
  });
});

// ---------------------------------------------------------------------------
// checkE1QualityProbe
// ---------------------------------------------------------------------------

function makeStandardDecisionWithPrompt(prompt: string): Extract<TelemetryEvent, { type: "decision" }> {
  return {
    type: "decision",
    ts: new Date().toISOString(),
    prompt,
    decision: {
      class: "standard",
      classifier: "heuristic",
      confidence: 0.8,
      spec: { model: "sonnet", effort: "medium", maxBudgetUsd: 0.1 },
      latencyMs: 5,
      diagnostics: [],
    },
  };
}

describe("checkE1QualityProbe", () => {
  test("returns 'n/a (no data)' when sampleSize is 0", async () => {
    const result = await checkE1QualityProbe([], 0, noopSpawn);
    expect(result.pass).toBe(true);
    expect(result.value).toBe("n/a (no data)");
    expect(result.name).toBe("e1-quality-probe");
    expect(result.gate).toBe("≥60% B-win");
  });

  test("returns 'n/a (no data)' when no eligible events", async () => {
    const result = await checkE1QualityProbe([], 10, noopSpawn);
    expect(result.pass).toBe(true);
    expect(result.value).toBe("n/a (no data)");
  });

  test("never calls spawnFn when sampleSize is 0", async () => {
    let called = false;
    const spy: SpawnFn = async () => {
      called = true;
      return { stdout: "", exitCode: 0 };
    };
    await checkE1QualityProbe([], 0, spy);
    expect(called).toBe(false);
  });

  test("never calls spawnFn when no eligible events (empty prompt events filtered out)", async () => {
    let called = false;
    const spy: SpawnFn = async () => {
      called = true;
      return { stdout: "", exitCode: 0 };
    };
    // Events without prompt field
    const events: TelemetryEvent[] = [
      makeStandardDecision({ outputTokens: 100, maxOutputTokens: 8000 }),
    ];
    await checkE1QualityProbe(events, 10, spy);
    expect(called).toBe(false);
  });

  test("calls spawnFn twice per eligible event (B-run + judge)", async () => {
    const calls: string[] = [];
    const spy: SpawnFn = async (opts) => {
      calls.push(opts.prompt.slice(0, 30));
      return { stdout: "PASS", exitCode: 0 };
    };
    const events: TelemetryEvent[] = [makeStandardDecisionWithPrompt("fix the bug")];
    await checkE1QualityProbe(events, 5, spy);
    // 2 calls: one for B-run, one for judge
    expect(calls).toHaveLength(2);
  });

  test("passes when all sampled turns return PASS from judge", async () => {
    const spy: SpawnFn = async () => ({ stdout: "PASS", exitCode: 0 });
    const events: TelemetryEvent[] = [
      makeStandardDecisionWithPrompt("explain this"),
      makeStandardDecisionWithPrompt("refactor that"),
    ];
    const result = await checkE1QualityProbe(events, 5, spy);
    expect(result.pass).toBe(true);
    expect(result.value).toBe("100% B-win");
    expect(result.gate).toBe("≥60% B-win");
  });

  test("fails when fewer than 60% of sampled turns are judged PASS", async () => {
    let callCount = 0;
    const spy: SpawnFn = async (opts) => {
      callCount++;
      // B-run calls are odd (1st, 3rd, 5th...), judge calls are even
      // Alternate: first event judge=FAIL, second event judge=PASS → 1/2 = 50%
      const isJudge = opts.prompt.includes("Is this answer adequate");
      if (isJudge && callCount <= 4) {
        return { stdout: callCount <= 2 ? "FAIL" : "PASS", exitCode: 0 };
      }
      return { stdout: "answer here", exitCode: 0 };
    };
    // 3 events; judge returns FAIL for first two, PASS for third → 1/3 ≈ 33%
    const events: TelemetryEvent[] = [
      makeStandardDecisionWithPrompt("prompt A"),
      makeStandardDecisionWithPrompt("prompt B"),
      makeStandardDecisionWithPrompt("prompt C"),
    ];
    const spy2: SpawnFn = async (opts) => {
      const isJudge = opts.prompt.includes("Is this answer adequate");
      if (isJudge) return { stdout: "FAIL", exitCode: 0 };
      return { stdout: "answer here", exitCode: 0 };
    };
    const result = await checkE1QualityProbe(events, 5, spy2);
    expect(result.pass).toBe(false);
    expect(result.value).toBe("0% B-win");
    expect(result.detail).toContain("0/3");
  });

  test("skips events where spawnFn returns non-zero exit code", async () => {
    const spy: SpawnFn = async (opts) => {
      const isJudge = opts.prompt.includes("Is this answer adequate");
      if (!isJudge) return { stdout: "", exitCode: 1 }; // B-run fails
      return { stdout: "PASS", exitCode: 0 };
    };
    const events: TelemetryEvent[] = [makeStandardDecisionWithPrompt("do something")];
    const result = await checkE1QualityProbe(events, 5, spy);
    // B-run failed → ran=0 → error result
    expect(result.pass).toBe(false);
    expect(result.detail).toContain("claude binary");
  });
});

// ---------------------------------------------------------------------------
// runOutputQuality
// ---------------------------------------------------------------------------

describe("runOutputQuality", () => {
  test("returns dimension='quality'", async () => {
    const result = await runOutputQuality([], {});
    expect(result.dimension).toBe("quality");
  });

  test("returns 3 checks", async () => {
    const result = await runOutputQuality([], {});
    expect(result.checks).toHaveLength(3);
  });

  test("passes when all checks pass (no near-cap events)", async () => {
    const cap = 8000;
    const safe = Math.round(cap * 0.5);
    const events: TelemetryEvent[] = Array.from({ length: 5 }, () =>
      makeStandardDecision({ outputTokens: safe, maxOutputTokens: cap }),
    );
    const result = await runOutputQuality(events, {});
    expect(result.pass).toBe(true);
    expect(result.checks.every((c) => c.pass)).toBe(true);
  });

  test("fails when truncation check fails", async () => {
    const cap = 8000;
    const nearCap = Math.round(cap * 0.99);
    const safe = Math.round(cap * 0.5);
    // 2/20 near-cap = 10% → fails
    const events: TelemetryEvent[] = [
      ...Array.from({ length: 2 }, () =>
        makeStandardDecision({ outputTokens: nearCap, maxOutputTokens: cap }),
      ),
      ...Array.from({ length: 18 }, () =>
        makeStandardDecision({ outputTokens: safe, maxOutputTokens: cap }),
      ),
    ];
    const result = await runOutputQuality(events, {});
    expect(result.pass).toBe(false);
    const truncCheck = result.checks.find((c) => c.name === "truncation-rate");
    expect(truncCheck?.pass).toBe(false);
  });

  test("check names include truncation-rate, bench-accuracy, e1-quality-probe", async () => {
    const result = await runOutputQuality([], {});
    const names = result.checks.map((c) => c.name);
    expect(names).toContain("truncation-rate");
    expect(names).toContain("bench-accuracy");
    expect(names).toContain("e1-quality-probe");
  });

  test("works without spawnFn in params (uses internal noop, skips bench when no evalSetPath)", async () => {
    // Empty evalSetPath → bench-accuracy returns 'skipped' (pass), e1 returns 'n/a' (pass)
    const result = await runOutputQuality([], { evalSetPath: "", sampleSize: 0 });
    expect(result.pass).toBe(true);
  });
});
