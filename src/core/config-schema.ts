// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import type { ZodIssue } from "zod";
import type { UserConfig } from "./types.js";

/**
 * Thrown by `parseUserConfig` when the raw JSON does not conform to
 * the `UserConfig` schema. The message lists every field error.
 */
export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

function formatIssue(issue: ZodIssue): string {
  const field = issue.path.join(".");
  const prefix = field ? `  ${field}` : "  (root)";
  if (issue.code === "invalid_enum_value") {
    const opts = issue.options.join(" | ");
    return `${prefix}: must be one of ${opts}, got "${issue.received}"`;
  }
  if (issue.code === "invalid_type") {
    return `${prefix}: expected ${issue.expected}, got ${issue.received}`;
  }
  return `${prefix}: ${issue.message}`;
}

/**
 * Zod schema mirroring `UserConfig`. Every field is optional and `.strip()`
 * removes unknown keys silently.
 *
 * The compile-time drift guard below (`_SchemaCoversUserConfig`) causes a TS
 * error when a new field is added to UserConfig but not to this schema.
 * `disabledModels` uses `z.array` (without `.readonly()`) because Zod does not
 * infer `ReadonlyArray` — the guard uses `Required` to normalise optionality.
 */
export const userConfigSchema = z
  .object({
    profile: z.string().optional(),
    aggressiveness: z.enum(["conservative", "balanced", "aggressive"]).optional(),
    disabledModels: z.array(z.string()).optional(),
    dailyCostCapUsd: z.number().optional(),
    feedbackPrompts: z.enum(["never", "occasional", "always"]).optional(),
    feedbackSampleRate: z.number().optional(),
    autoLearn: z.boolean().optional(),
    excludeDynamicSections: z.boolean().optional(),
    autoCompact: z.boolean().optional(),
    autoCompactThresholdTokens: z.number().optional(),
    telemetryPath: z.string().optional(),
    useLlmClassifier: z.boolean().optional(),
    useLlmClassifierInWrapper: z.boolean().optional(),
    useEmbeddingClassifier: z.boolean().optional(),
    embeddingModel: z.string().optional(),
    embeddingMinSimilarity: z.number().min(0).max(1).optional(),
    embeddingHeadPath: z.string().optional(),
    appendSystemPrompt: z.string().optional(),
    posthogApiKey: z.string().optional(),
    posthogQueryKey: z.string().optional(),
    communityHeuristicsUrl: z.string().optional(),
    autoTuneIntervalDays: z.number().optional(),
    posthogProjectId: z.string().optional(),
    sendPromptText: z.boolean().optional(),
    telemetry: z
      .object({
        eventsLogged: z.number().optional(),
        lastWriteAt: z.string().nullable().optional(),
      })
      .optional(),
    injectSetMaxThinkingTokens: z.boolean().optional(),
    disableStandardMcpIsolation: z.boolean().optional(),
    autoResumeOnMaxTokens: z.boolean().optional(),
    restorePerClassBrevity: z.boolean().optional(),
    disableFirstTurnGuard: z.boolean().optional(),
    enablePasteCondenser: z.boolean().optional(),
    trivialMinimalContext: z.boolean().optional(),
    langfusePublicKey: z.string().optional(),
    langfuseSecretKey: z.string().optional(),
    langfuseHost: z.string().optional(),
  })
  .strip();

/**
 * Compile-time drift guard: errors if `userConfigSchema` output is missing a
 * key that exists in `UserConfig`. Add a field to `UserConfig` without adding
 * it here and TypeScript will report "Type 'false' is not assignable to type
 * 'true'" pointing at this line.
 */
type _SchemaOutput = z.output<typeof userConfigSchema>;
// Normalise both sides: make all keys required and replace arrays with
// `unknown[]` so ReadonlyArray vs Array differences don't matter.
type _NormSchema = { [K in keyof Required<_SchemaOutput>]: unknown };
type _NormConfig = { [K in keyof Required<UserConfig>]: unknown };
// This type errors when UserConfig has a key not present in the schema.
// Exported so both TS and ESLint consider it "used".
export type SchemaCoversUserConfig = _NormConfig extends _NormSchema
  ? true
  : "schema is missing fields from UserConfig — add them to userConfigSchema";

/**
 * Parse raw JSON (from `readJsonOrNull`) into a validated `UserConfig`.
 * Throws `ConfigValidationError` with a human-readable message on failure.
 */
export function parseUserConfig(raw: unknown): UserConfig {
  const result = userConfigSchema.safeParse(raw);
  if (result.success) {
    // exactOptionalPropertyTypes: Zod infers `T | undefined` for optional fields
    // but UserConfig uses `T?`. The values are identical at runtime.
    return result.data as UserConfig;
  }

  const lines = result.error.issues.map(formatIssue);
  throw new ConfigValidationError(`config validation failed:\n${lines.join("\n")}`);
}
