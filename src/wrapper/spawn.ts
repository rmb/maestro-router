// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { spawn as nodeSpawn } from "node:child_process";
import type { Decision, UserConfig } from "../core/types.js";

export type BuildArgsInput = {
  decision: Decision;
  userConfig: UserConfig;
  sessionId: string;
  /** true if continuing a prior session, false if starting fresh with this id. */
  isResume: boolean;
  /**
   * Whether the current auth method supports --bare. False on OAuth.
   * When false, --bare is suppressed even if the profile would have set it.
   * Defaults to false (safe).
   */
  bareSupported?: boolean;
};

/**
 * Build the `claude --print …` argument list from a Decision plus user config.
 * Pure function — easy to test, easy to reason about. Spawn-side concerns
 * (stdin, signal handling, output capture) live in spawnClaude.
 */
export function buildClaudeArgs(input: BuildArgsInput): string[] {
  const { decision, userConfig, sessionId, isResume } = input;
  const spec = decision.spec;
  const args: string[] = ["--print", "--output-format", "json"];

  if (isResume) {
    args.push("--resume", sessionId);
  } else {
    args.push("--session-id", sessionId);
  }

  args.push("--model", spec.model);
  args.push("--effort", spec.effort);
  args.push("--max-budget-usd", String(spec.maxBudgetUsd));

  // S7: exclude dynamic system prompt sections — per-class overrides global
  const excludeDynamic =
    spec.excludeDynamicSections !== undefined
      ? spec.excludeDynamicSections
      : (userConfig.excludeDynamicSections ?? true);
  if (excludeDynamic) {
    args.push("--exclude-dynamic-system-prompt-sections");
  }

  // S8: tool restriction (omit when "default" since that's Claude's default)
  if (spec.tools && spec.tools !== "default") {
    args.push("--tools", spec.tools);
  }

  // S9: MCP isolation — when mcpConfig present, force strict mode and pass the inline JSON
  if (spec.mcpConfig !== undefined) {
    args.push("--strict-mcp-config", "--mcp-config", spec.mcpConfig);
  }

  const appendPrompt = resolveAppendSystemPrompt(decision, userConfig);
  // Only emit the flag when there is a non-empty string (empty = intentional suppression)
  if (appendPrompt !== "") {
    args.push("--append-system-prompt", appendPrompt);
  }

  // S6: --bare requires four conditions (R-auth: bare_supported by env)
  const codes = decision.diagnostics.map((d) => d.code);
  const bareSafe = codes.includes("heuristic.bare_safe");
  const disableBare = codes.includes("override.disable_bare");
  const bareSupported = input.bareSupported === true;
  if (spec.bare === true && bareSafe && !disableBare && bareSupported) {
    args.push("--bare");
  }

  return args;
}

/**
 * X.soft brevity hints by class. Source of truth — exported so the fingerprint
 * compute in run-cmd.ts and oracle/tool-correctness.ts can replicate exactly
 * what spawn.ts sends in --append-system-prompt. Empty string means "suppress
 * the flag entirely" (hard/reasoning/max never want a brevity hint).
 */
export const CLASS_BREVITY: Partial<Record<string, string>> = {
  trivial: "Output only the answer. No explanation. No formatting.",
  simple: "Be concise. Skip preamble.",
  // standard: explicit cap — claude CLI has no --max-tokens flag, so this is
  // the only soft pressure on output length. Earlier production p90 was 12k+
  // tokens against an aspirational 8k cap, so we make the limit explicit and
  // override the userConfig default for standard turns.
  standard: "Aim for under 4000 tokens. Prefer bullet points and code over prose. Skip preambles, recaps, and trailing summaries — the user reads the diff.",
  hard: "",
  reasoning: "",
  max: "",
};

/** Default appendSystemPrompt when no per-class or user override exists. */
export const DEFAULT_APPEND_SYSTEM_PROMPT =
  "Be concise. Avoid preambles and trailing summaries — the user can read the diff.";

/**
 * Resolve the effective appendSystemPrompt for a decision. Used by spawn.ts
 * (for the --append-system-prompt flag) and run-cmd.ts (for fingerprint
 * computation). Must produce identical output in both call sites or the
 * fingerprint will diverge from the actual flag and Track Z will miss.
 */
export function resolveAppendSystemPrompt(
  decision: Decision,
  userConfig: UserConfig,
): string {
  const spec = decision.spec;
  if (spec.appendSystemPrompt !== undefined) return spec.appendSystemPrompt;
  const classHint = CLASS_BREVITY[decision.class];
  if (classHint !== undefined) return classHint;
  if (userConfig.appendSystemPrompt !== undefined) return userConfig.appendSystemPrompt;
  return DEFAULT_APPEND_SYSTEM_PROMPT;
}

export type SpawnResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

export type SpawnClaudeOptions = {
  binary?: string;
  args: ReadonlyArray<string>;
  prompt: string;
  signal?: AbortSignal;
};

/**
 * Spawn the Claude CLI subprocess, write the prompt to stdin, capture stdout
 * and stderr, return the exit code. Rejects only on spawn-level failure
 * (binary not found, etc.) — a non-zero exit is reported via exitCode and
 * does not reject.
 */
export function spawnClaude(opts: SpawnClaudeOptions): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const binary = opts.binary ?? "claude";
    const child = nodeSpawn(binary, [...opts.args], { stdio: ["pipe", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    let settled = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const onAbort = (): void => {
      if (!child.killed) child.kill("SIGTERM");
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        onAbort();
      } else {
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ stdout, stderr, exitCode: code });
    });

    try {
      child.stdin.write(opts.prompt);
      child.stdin.end();
    } catch (err) {
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener("abort", onAbort);
      reject(err as Error);
    }
  });
}
