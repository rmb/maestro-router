// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0
// budget: 1ms

import type { Diagnostic } from "./types.js";

// Prompt larger than this is likely a file or log paste, not a typed query.
const PASTE_THRESHOLD_CHARS = 3_000;

// Session context thresholds in tokens.
const SESSION_WARM_TOKENS = 80_000;  // session is active and growing
const SESSION_HOT_TOKENS = 250_000;  // session is large; next big turn will be expensive

/**
 * Proactive compaction advisory. Called before spawn to detect turns that will
 * push the session window up significantly. Returns diagnostics to merge into
 * the Decision; returns [] when no candidate is detected.
 *
 * Signals (both must be true to fire):
 *   1. Incoming prompt is large (paste-heavy) — proxy for token volume.
 *   2. Session already has meaningful cached context — indicates compacting
 *      first would avoid a large cache_creation hit.
 *
 * This is advisory only. It does not change routing and never throws.
 */
export function classifyCompactionCandidate(
  promptLength: number,
  sessionCacheReadTokens: number,
): Diagnostic[] {
  if (promptLength < PASTE_THRESHOLD_CHARS) return [];
  if (sessionCacheReadTokens <= SESSION_WARM_TOKENS) return [];

  const urgency = sessionCacheReadTokens >= SESSION_HOT_TOKENS ? "high" : "medium";
  const cachedK = Math.round(sessionCacheReadTokens / 1_000);

  return [
    {
      severity: "hint" as const,
      code: "compaction.candidate",
      message: `prompt ${promptLength} chars into ${cachedK}k-token session (${urgency} urgency) — /compact first reduces cache_creation cost`,
    },
  ];
}
