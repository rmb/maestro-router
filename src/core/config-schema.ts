// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
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

/**
 * Zod schema mirroring `UserConfig`. Every field is optional and `.strip()`
 * removes unknown keys silently.
 */
export const userConfigSchema = z
  .object({
    profile: z.string().optional(),
    aggressiveness: z.enum(["conservative", "balanced", "aggressive"]).optional(),
    disabledModels: z.array(z.string()).readonly().optional(),
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
 * Parse raw JSON (from `readJsonOrNull`) into a validated `UserConfig`.
 * Throws `ConfigValidationError` with a human-readable message on failure.
 */
export function parseUserConfig(raw: unknown): UserConfig {
  const result = userConfigSchema.safeParse(raw);
  if (result.success) {
    return result.data as UserConfig;
  }

  const lines = result.error.issues.map((issue) => {
    const field = issue.path.join(".");
    const received =
      "received" in issue ? String((issue as { received: unknown }).received) : "unknown";
    const expected =
      "expected" in issue ? String((issue as { expected: unknown }).expected) : issue.message;
    return field ? `  ${field}: expected ${expected}, got ${received}` : `  ${issue.message}`;
  });

  throw new ConfigValidationError(`config validation failed:\n${lines.join("\n")}`);
}
