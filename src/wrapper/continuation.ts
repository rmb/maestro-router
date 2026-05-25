// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

/**
 * Detect whether a user prompt is a "continuation" of the prior turn
 * (user asking Claude to continue from where it stopped).
 *
 * Requires TWO signals to avoid false positives:
 *   1. Linguistic: prompt is short and matches continuation pattern
 *   2. Session state: prior turn was truncated (max_tokens) OR ended mid-block
 *
 * If both signals present → returns a modified appendSystemPrompt hint.
 * If only one signal → returns null (let normal routing handle it).
 */
export function detectContinuation(
  prompt: string,
  priorStopReason: string | null | undefined,
): {
  isContinuation: boolean;
  hint: string;
} | null {
  const trimmed = prompt.trim();

  // Signal 1: linguistic — short prompt matching continuation
  const isLinguistic = trimmed.length < 50 && CONTINUATION_PATTERNS.test(trimmed);
  if (!isLinguistic) return null;

  // Signal 2: session state — prior turn was truncated
  const wasTruncated = priorStopReason === "max_tokens";

  if (!wasTruncated) {
    // Only one signal — not enough
    return null;
  }

  return {
    isContinuation: true,
    hint: CONTINUATION_HINT,
  };
}

export const CONTINUATION_PATTERNS =
  /^(continue|keep going|go on|and[?]?|yes[,.]?$|more[,.]?$|next[,.]?$|proceed[,.]?$|\.{2,}$)/i;

/**
 * Prompt hint to inject when continuation is detected.
 * Suppresses recap/re-acknowledgment while preserving context.
 */
export const CONTINUATION_HINT =
  "Resume from where you stopped. No recap. No restating the question. Continue directly.";
