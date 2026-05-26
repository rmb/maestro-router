// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import type { Decision } from "../core/types.js";
import { applyFirstTurnGuard } from "./first-turn-guard.js";

function makeDecision(model: string): Decision {
  return {
    class: "max",
    classifier: "test",
    confidence: 1.0,
    spec: {
      model,
      effort: "max",
      maxBudgetUsd: 5,
    },
    latencyMs: 0,
    diagnostics: [],
  };
}

describe("applyFirstTurnGuard", () => {
  test("isFirstTurn=true + opus model → downgraded to sonnet", () => {
    const result = applyFirstTurnGuard(makeDecision("opus"), true);
    expect(result.spec.model).toBe("sonnet");
  });

  test("isFirstTurn=true + opus model → diagnostic added", () => {
    const result = applyFirstTurnGuard(makeDecision("opus"), true);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]!.code).toBe("first_turn_guard.opus_to_sonnet");
    expect(result.diagnostics[0]!.severity).toBe("info");
  });

  test("isFirstTurn=true + sonnet model → unchanged", () => {
    const decision = makeDecision("sonnet");
    const result = applyFirstTurnGuard(decision, true);
    expect(result).toBe(decision);
  });

  test("isFirstTurn=true + haiku model → unchanged", () => {
    const decision = makeDecision("haiku");
    const result = applyFirstTurnGuard(decision, true);
    expect(result).toBe(decision);
  });

  test("isFirstTurn=false + opus model → unchanged", () => {
    const decision = makeDecision("opus");
    const result = applyFirstTurnGuard(decision, false);
    expect(result).toBe(decision);
  });

  test("isFirstTurn=true + full opus model name (claude-opus-4-7) → downgraded", () => {
    const result = applyFirstTurnGuard(makeDecision("claude-opus-4-7"), true);
    expect(result.spec.model).toBe("sonnet");
  });

  test("diagnostic code is exactly first_turn_guard.opus_to_sonnet", () => {
    const result = applyFirstTurnGuard(makeDecision("opus"), true);
    expect(result.diagnostics[0]!.code).toBe("first_turn_guard.opus_to_sonnet");
  });

  test("existing diagnostics are preserved when guard fires", () => {
    const decision = makeDecision("opus");
    decision.diagnostics = [{ severity: "info", code: "prior.diag", message: "prior" }];
    const result = applyFirstTurnGuard(decision, true);
    expect(result.diagnostics).toHaveLength(2);
    expect(result.diagnostics[0]!.code).toBe("prior.diag");
    expect(result.diagnostics[1]!.code).toBe("first_turn_guard.opus_to_sonnet");
  });
});
