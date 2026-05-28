// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

/**
 * Token pricing rates and cost derivation helpers.
 *
 * All costs are derived from token volumes × model rates. Never trust
 * total_cost_usd from Claude Code's JSON output — it is fabricated on
 * Pro/Team subscriptions and cannot be used for savings calculations.
 */

// ---------------------------------------------------------------------------
// Rate tables (USD per token)
// ---------------------------------------------------------------------------

export const OPUS_INPUT_PER_TOK = 15 / 1_000_000;
export const OPUS_OUTPUT_PER_TOK = 75 / 1_000_000;
export const OPUS_CACHE_WRITE_PER_TOK = 18.75 / 1_000_000;
export const OPUS_CACHE_READ_PER_TOK = 1.50 / 1_000_000;

/** 1M-context Opus variant costs 2× standard on input/cache tokens. */
export const OPUS_1M_INPUT_PER_TOK = 30 / 1_000_000;
export const OPUS_1M_CACHE_WRITE_PER_TOK = 37.5 / 1_000_000;
export const OPUS_1M_CACHE_READ_PER_TOK = 3.0 / 1_000_000;

const INPUT_RATE: Record<string, number> = {
  haiku: 0.80 / 1_000_000,
  sonnet: 3.00 / 1_000_000,
  opus: OPUS_INPUT_PER_TOK,
};

const OUTPUT_RATE: Record<string, number> = {
  haiku: 4.00 / 1_000_000,
  sonnet: 15.00 / 1_000_000,
  opus: OPUS_OUTPUT_PER_TOK,
};

const CACHE_WRITE_RATE: Record<string, number> = {
  haiku: 1.00 / 1_000_000,
  sonnet: 3.75 / 1_000_000,
  opus: OPUS_CACHE_WRITE_PER_TOK,
};

const CACHE_READ_RATE: Record<string, number> = {
  haiku: 0.08 / 1_000_000,
  sonnet: 0.30 / 1_000_000,
  opus: OPUS_CACHE_READ_PER_TOK,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a modelUsed string (e.g. "claude-haiku-4-5-20251001") to a
 * pricing alias. Falls back to "sonnet" when unrecognized — conservative
 * choice that slightly overestimates cheap-model costs.
 */
export function modelAlias(modelUsed: string): "haiku" | "sonnet" | "opus" {
  const lower = modelUsed.toLowerCase();
  if (lower.includes("haiku")) return "haiku";
  if (lower.includes("opus")) return "opus";
  return "sonnet";
}

/**
 * Derive the real per-turn cost from token volumes × the actually-used
 * model's rates.
 *
 * Use this everywhere instead of total_cost_usd from Claude Code's JSON
 * output. total_cost_usd is fabricated on Pro/Team subscriptions and cannot
 * be used for budget caps, savings calculations, or telemetry reconciliation.
 */
export function computeTurnCost(
  modelUsed: string,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
  is1m: boolean,
): number {
  const alias = modelAlias(modelUsed);
  const ir = alias === "opus" && is1m ? OPUS_1M_INPUT_PER_TOK : (INPUT_RATE[alias] ?? INPUT_RATE.sonnet!);
  const or = OUTPUT_RATE[alias] ?? OUTPUT_RATE.sonnet!;
  const cwr = alias === "opus"
    ? (is1m ? OPUS_1M_CACHE_WRITE_PER_TOK : OPUS_CACHE_WRITE_PER_TOK)
    : (CACHE_WRITE_RATE[alias] ?? CACHE_WRITE_RATE.sonnet!);
  const crr = alias === "opus"
    ? (is1m ? OPUS_1M_CACHE_READ_PER_TOK : OPUS_CACHE_READ_PER_TOK)
    : (CACHE_READ_RATE[alias] ?? CACHE_READ_RATE.sonnet!);
  return inputTokens * ir + outputTokens * or + cacheCreationTokens * cwr + cacheReadTokens * crr;
}

/**
 * Reprice a set of token counts at Opus rates (the counterfactual baseline).
 * Handles 1M-context variant tokens separately at 2× standard pricing.
 */
export function computeOpusBaseline(
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
  inputTokens1m: number,
  cacheCreationTokens1m: number,
  cacheReadTokens1m: number,
): number {
  const inputStd = inputTokens - inputTokens1m;
  const cacheCreationStd = cacheCreationTokens - cacheCreationTokens1m;
  const cacheReadStd = cacheReadTokens - cacheReadTokens1m;

  return (
    inputStd * OPUS_INPUT_PER_TOK +
    inputTokens1m * OPUS_1M_INPUT_PER_TOK +
    outputTokens * OPUS_OUTPUT_PER_TOK +
    cacheCreationStd * OPUS_CACHE_WRITE_PER_TOK +
    cacheCreationTokens1m * OPUS_1M_CACHE_WRITE_PER_TOK +
    cacheReadStd * OPUS_CACHE_READ_PER_TOK +
    cacheReadTokens1m * OPUS_1M_CACHE_READ_PER_TOK
  );
}

/**
 * Derive cost for a single TelemetryEvent cost object.
 * Falls back to decision.spec.model when modelUsed is absent (e.g. sdk-proxy
 * events logged before this fix shipped).
 */
export function costFromEvent(
  cost: {
    modelUsed?: string;
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
    is1mVariant?: boolean;
  },
  decidedModel: string,
): number {
  return computeTurnCost(
    cost.modelUsed ?? decidedModel,
    cost.inputTokens,
    cost.outputTokens,
    cost.cacheCreationInputTokens,
    cost.cacheReadInputTokens,
    cost.is1mVariant ?? false,
  );
}
