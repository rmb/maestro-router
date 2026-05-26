// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import type { Decision } from "../core/types.js";

/**
 * When this is the first turn of a new session and the routed model is Opus,
 * downgrade to Sonnet to avoid paying the most expensive cache_creation boot.
 * Subsequent turns can resume the cheaper cache and route freely.
 *
 * Empirically: a fresh Opus first-turn boot costs $3-12 (at 1h ephemeral cache
 * rates). Sonnet first-turn boot is ~$0.30. Routing decisions for opus-class
 * prompts pay off across many follow-up turns; the first turn alone almost never
 * justifies the boot premium.
 *
 * Returns the original decision if no downgrade applies.
 */
export function applyFirstTurnGuard(
  decision: Decision,
  isFirstTurn: boolean,
): Decision {
  if (!isFirstTurn) return decision;
  if (!decision.spec.model.includes("opus")) return decision;
  return {
    ...decision,
    spec: { ...decision.spec, model: "sonnet" },
    diagnostics: [
      ...decision.diagnostics,
      {
        severity: "info",
        code: "first_turn_guard.opus_to_sonnet",
        message: `first-turn guard: opus → sonnet (avoid $3-12 boot cost; subsequent turns can route freely)`,
      },
    ],
  };
}
