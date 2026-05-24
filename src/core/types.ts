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
  /** Hard ceiling on output tokens. Omit for uncapped (hard/reasoning/max). */
  maxOutputTokens?: number;
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
  /** Probability (0..1) of prompting on each Stop event when feedbackPrompts="occasional". */
  feedbackSampleRate?: number;
  autoLearn?: boolean;
  /** Global default for S7. Per-class can override via ClassSpec. */
  excludeDynamicSections?: boolean;
  /** Emit hint when cache_creation_input_tokens exceeds threshold (S10). */
  autoCompact?: boolean;
  autoCompactThresholdTokens?: number;
  telemetryPath?: string;
  /**
   * When true (default), use `claude --json-schema` as a final classifier
   * for prompts the cheap classifiers can't handle. Adds ~$0.001 per
   * uncertain prompt on Haiku. Set false to disable entirely (S12).
   *
   * NOTE: this flag controls bench/tune workflows. The wrapper's hot path
   * has its own opt-in via `useLlmClassifierInWrapper` because cold-call
   * latency (13-20s) plus VSCode's 60s init deadline left no margin.
   */
  useLlmClassifier?: boolean;
  /**
   * When true, run the LLM classifier inside the VSCode-panel hot path.
   * Default false — too costly (cold cache_creation ~\$0.04/call) and
   * too slow (13-20s) to belong on the wrapper hot path. Opt in only if
   * accuracy matters more than latency for your workflow.
   */
  useLlmClassifierInWrapper?: boolean;
  /**
   * When true (default if `@xenova/transformers` peer is installed), run
   * an in-process ONNX embedding classifier between `heuristic` and `llm`.
   * Returns null gracefully if the peer is missing, so this flag is mostly
   * an explicit opt-out (S2).
   */
  useEmbeddingClassifier?: boolean;
  /**
   * Text appended to Claude's system prompt on every spawn via
   * `--append-system-prompt`. Use this to instruct Claude to keep responses
   * brief, reducing output tokens and slowing context-window compaction.
   *
   * Example: "Be concise. Skip preambles and trailing summaries."
   *
   * Set to `""` (empty string) to disable. Defaults to a short brevity hint.
   */
  appendSystemPrompt?: string;
  /**
   * PostHog project API key (starts with `phc_`). When set, Maestro emits
   * `maestro_decision` and `maestro_override` events to PostHog on every spawn.
   * Leave unset to disable remote telemetry entirely.
   */
  posthogApiKey?: string;
  /**
   * PostHog personal API key (starts with `phx_`). Required only for
   * `maestro tune --posthog`. Obtain at posthog.com → Settings → Personal API Keys.
   */
  posthogQueryKey?: string;
  /**
   * PostHog numeric project ID. Required only for `maestro tune --posthog`.
   * Find it in PostHog → Project Settings → Project ID.
   */
  posthogProjectId?: string;
  /**
   * When true, include the raw prompt text in PostHog `maestro_override` events.
   * Default false. Only enable if you consent to sending prompt snippets to PostHog.
   * Required for `maestro tune --posthog` to mine patterns from cross-user data.
   */
  sendPromptText?: boolean;
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

/**
 * Max chars of a prompt persisted in telemetry. Truncates the head of the
 * prompt to keep decisions.jsonl bounded — pathological large prompts
 * (e.g. multi-MB pasted logs) would otherwise bloat the log. Consumers
 * relabeling real prompts only need the leading window to identify intent.
 */
export const PROMPT_TRUNCATE_CHARS = 500;

/** A single telemetry event written to ~/.maestro/decisions.jsonl. */
export type TelemetryEvent =
  | {
      type: "decision";
      ts: string;
      decision: Decision;
      cost?: CostBreakdown;
      /** Truncated to PROMPT_TRUNCATE_CHARS to bound log growth. */
      prompt?: string;
    }
  | { type: "override"; ts: string; from: Class; to: Class; prompt: string }
  | {
      type: "feedback";
      ts: string;
      sessionId: string;
      rating: 1 | 2 | 3 | 4 | 5;
      note?: string;
      /** "auto" = via Stop-hook sampling; "manual" = user invoked CLI directly. */
      source?: "auto" | "manual";
    };
