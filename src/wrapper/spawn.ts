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

  // X.soft: class-specific brevity hints. trivial/simple get tighter instructions;
  // hard/reasoning/max get nothing (don't constrain thinking). standard falls
  // through to global user default. Per-class spec.appendSystemPrompt wins first.
  const CLASS_BREVITY: Partial<Record<string, string>> = {
    trivial: "Output only the answer. No explanation. No formatting.",
    simple: "Be concise. Skip preamble.",
    // standard: falls through to global userConfig default
    hard: "",
    reasoning: "",
    max: "",
  };
  const classHint = CLASS_BREVITY[decision.class];
  const appendPrompt =
    spec.appendSystemPrompt !== undefined
      ? spec.appendSystemPrompt
      : classHint !== undefined
        ? classHint
        : (userConfig.appendSystemPrompt !== undefined
            ? userConfig.appendSystemPrompt
            : "Be concise. Avoid preambles and trailing summaries — the user can read the diff.");
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
