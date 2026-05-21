// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

/** Six complexity classes used to pick model + thinking budget. */
export type Class = "trivial" | "simple" | "standard" | "hard" | "reasoning" | "max";

/** Effort levels accepted by `claude --effort`. */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** Turn types detected by the turn-type classifier. */
export type TurnType = "user_prompt" | "tool_result" | "error_recovery" | "continuation";

/** Diagnostic emitted by a classifier — informational, never fatal. */
export type Diagnostic = {
  severity: "info" | "hint" | "warning";
  /** Stable identifier, e.g. "cache.hit" or "fallback.timeout". */
  code: string;
  message: string;
};

/** Per-class flags passed to `claude --print`. */
export type ClassSpec = {
  /** Model alias ("haiku" / "sonnet" / "opus") or full name. */
  model: string;
  effort: Effort;
  maxBudgetUsd: number;
  /** Comma-separated tool list for `--tools`, or "default". */
  tools?: string;
  /** Enable `--bare` mode (S6). Only safe for definite-trivial. */
  bare?: boolean;
  /** JSON for `--mcp-config`; combined with `--strict-mcp-config` (S9). */
  mcpConfig?: string;
  /** Override global `--exclude-dynamic-system-prompt-sections` (S7). */
  excludeDynamicSections?: boolean;
};

/** Built-in / user profile — every class fully specified. */
export type Profile = {
  name: string;
  classes: Record<Class, ClassSpec>;
};

/** Per-class user overrides applied on top of a profile. */
export type ProfileOverride = Partial<Record<Class, Partial<ClassSpec>>>;

/** A regex pattern → class mapping; built-in or user-supplied. */
export type HeuristicRule = {
  /** Serialized as string in JSON; compiled to RegExp at load. */
  pattern: string;
  /** Matching flags ("i" by default). */
  flags?: string;
  class: Class;
  confidence: number;
  source?: "builtin" | "auto" | "manual";
  /** Whether this rule is safe for `--bare` mode (S6 safety). */
  bareSafe?: boolean;
};

/** Global user preferences from ~/.maestro/config.json. */
export type UserConfig = {
  profile?: string;
  aggressiveness?: "conservative" | "balanced" | "aggressive";
  disabledModels?: ReadonlyArray<string>;
  dailyCostCapUsd?: number;
  feedbackPrompts?: "never" | "occasional" | "always";
  autoLearn?: boolean;
  /** Global default for S7. Per-class can override via ClassSpec. */
  excludeDynamicSections?: boolean;
  /** Emit hint when cache_creation_input_tokens exceeds threshold (S10). */
  autoCompact?: boolean;
  autoCompactThresholdTokens?: number;
  telemetryPath?: string;
};

/** One message in a conversation; minimal shape used by classifiers. */
export type Message = {
  role: "user" | "assistant" | "tool" | "system";
  /** Either a string or a structured content array; we only inspect strings. */
  content: string | ReadonlyArray<unknown>;
};

/** Input to any classifier. */
export type Request = {
  /** Last user-visible message text. */
  prompt: string;
  /** Full conversation if available; used by turn-type and others. */
  messages?: ReadonlyArray<Message>;
  /** Scenario hint passed through external integrations (future). */
  scenarioHint?: string;
  metadata?: Record<string, unknown>;
};

/** Output of a single classifier; null = "no signal". */
export type Classification = {
  class: Class;
  confidence: number;
  diagnostics?: ReadonlyArray<Diagnostic>;
};

/** Options threaded through classifier invocations. */
export type ClassifyOptions = {
  signal?: AbortSignal;
};

/** Pure function: request → classification or null. */
export type ClassifyFn = (
  req: Request,
  opts?: ClassifyOptions,
) => Promise<Classification | null> | Classification | null;

/** Registered classifier; output of createClassifier factory. */
export type Classifier = {
  name: string;
  /** Weight in parallel weighted vote when no short-circuit fires. */
  weight: number;
  classify: ClassifyFn;
};

/** Final pipeline output. */
export type Decision = {
  class: Class;
  /** Name of the classifier that produced this decision, or "vote". */
  classifier: string;
  confidence: number;
  /** Resolved spec from profile + overrides. */
  spec: ClassSpec;
  latencyMs: number;
  diagnostics: ReadonlyArray<Diagnostic>;
  cacheHit?: boolean;
};

/** Token + cost data parsed from `claude --output-format json`. */
export type CostBreakdown = {
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  durationMs: number;
  durationApiMs: number;
  stopReason: string;
  modelUsed: string;
  serviceTier: string;
};

/** A single telemetry event written to ~/.maestro/decisions.jsonl. */
export type TelemetryEvent =
  | { type: "decision"; ts: string; decision: Decision; cost?: CostBreakdown }
  | { type: "override"; ts: string; from: Class; to: Class; prompt: string }
  | { type: "feedback"; ts: string; sessionId: string; rating: 1 | 2 | 3 | 4 | 5; note?: string };
