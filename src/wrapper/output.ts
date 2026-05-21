// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { extractJSON } from "../core/extract.js";
import type { CostBreakdown, Diagnostic, UserConfig } from "../core/types.js";

const DEFAULT_AUTO_COMPACT_THRESHOLD = 8000;

export type ParsedOutput = {
  cost: CostBreakdown;
  diagnostics: Diagnostic[];
  sessionId: string | null;
};

/**
 * Shape of Claude CLI `--output-format json` result envelope, as observed in
 * spike 2 (see docs/router-observations.md). Fields are optional because we
 * defend against version drift: missing values default rather than throw.
 */
type ClaudeJsonOutput = {
  type?: string;
  subtype?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  stop_reason?: string;
  session_id?: string;
  is_error?: boolean;
  errors?: ReadonlyArray<string>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    service_tier?: string;
  };
  modelUsage?: Record<
    string,
    {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
      costUSD?: number;
    }
  >;
};

/**
 * Parse the JSON envelope Claude CLI emits with `--output-format json` and
 * derive a CostBreakdown plus diagnostics. Returns null if the envelope is
 * absent, malformed, or not a "result" message.
 *
 * S10: when `cache_creation_input_tokens` exceeds the threshold, emits an
 * `info.compact_recommended` diagnostic so the wrapper CLI can print the
 * "consider /clear or /compact" hint.
 */
export function parseOutput(raw: string, userConfig: UserConfig = {}): ParsedOutput | null {
  const parsed = extractJSON<ClaudeJsonOutput>(raw);
  if (!parsed) return null;
  if (typeof parsed.type !== "string" || parsed.type !== "result") return null;

  // R8 observation: on budget-error, top-level usage zeros out and real
  // counts live in modelUsage[*]. Prefer the model-level numbers when the
  // top-level reports zero output but the model used tokens.
  const modelEntry = pickModelEntry(parsed.modelUsage);
  const usage = parsed.usage ?? {};
  const inputTokens =
    usage.input_tokens && usage.input_tokens > 0
      ? usage.input_tokens
      : (modelEntry?.inputTokens ?? 0);
  const outputTokens =
    usage.output_tokens && usage.output_tokens > 0
      ? usage.output_tokens
      : (modelEntry?.outputTokens ?? 0);
  const cacheCreation =
    usage.cache_creation_input_tokens && usage.cache_creation_input_tokens > 0
      ? usage.cache_creation_input_tokens
      : (modelEntry?.cacheCreationInputTokens ?? 0);
  const cacheRead =
    usage.cache_read_input_tokens && usage.cache_read_input_tokens > 0
      ? usage.cache_read_input_tokens
      : (modelEntry?.cacheReadInputTokens ?? 0);

  const cost: CostBreakdown = {
    totalCostUsd: parsed.total_cost_usd ?? modelEntry?.costUSD ?? 0,
    inputTokens,
    outputTokens,
    cacheCreationInputTokens: cacheCreation,
    cacheReadInputTokens: cacheRead,
    durationMs: parsed.duration_ms ?? 0,
    durationApiMs: parsed.duration_api_ms ?? 0,
    stopReason: parsed.stop_reason ?? "unknown",
    serviceTier: parsed.usage?.service_tier ?? "unknown",
    modelUsed: pickModelName(parsed.modelUsage),
  };

  const diagnostics: Diagnostic[] = [];
  const threshold = userConfig.autoCompactThresholdTokens ?? DEFAULT_AUTO_COMPACT_THRESHOLD;
  if (cost.cacheCreationInputTokens > threshold) {
    diagnostics.push({
      severity: "hint",
      code: "info.compact_recommended",
      message: `cache_creation_input_tokens=${cost.cacheCreationInputTokens} exceeded ${threshold}; consider /clear or /compact to reset cache cost`,
    });
  }
  if (parsed.subtype === "error_max_budget_usd") {
    const errMsg = parsed.errors?.[0] ?? "max_budget_usd reached";
    diagnostics.push({
      severity: "warning",
      code: "claude.budget_exceeded",
      message: `${errMsg}; realized cost $${cost.totalCostUsd.toFixed(6)}`,
    });
  } else if (parsed.is_error === true) {
    diagnostics.push({
      severity: "warning",
      code: "claude.is_error",
      message: `Claude CLI reported is_error=true (stop_reason=${cost.stopReason})`,
    });
  }

  return {
    cost,
    diagnostics,
    sessionId: typeof parsed.session_id === "string" ? parsed.session_id : null,
  };
}

function pickModelName(modelUsage: ClaudeJsonOutput["modelUsage"]): string {
  if (!modelUsage) return "unknown";
  const keys = Object.keys(modelUsage);
  return keys[0] ?? "unknown";
}

function pickModelEntry(
  modelUsage: ClaudeJsonOutput["modelUsage"],
): NonNullable<ClaudeJsonOutput["modelUsage"]>[string] | null {
  if (!modelUsage) return null;
  const keys = Object.keys(modelUsage);
  const first = keys[0];
  if (!first) return null;
  return modelUsage[first] ?? null;
}
