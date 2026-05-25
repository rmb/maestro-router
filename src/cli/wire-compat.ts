// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0
//
// Wire-compatibility layer for the official Claude Code VSCode extension's
// `claudeCode.claudeProcessWrapper` setting.
//
// IMPORTANT: the extension does NOT treat the wrapper as a claude
// replacement. It invokes the wrapper with the REAL claude binary path as
// argv[1] and the actual claude arguments as argv[2..]. The wrapper is
// expected to fork/exec the real claude with the remaining arguments,
// optionally adding/modifying flags.
//
// Maestro's wrapper:
//   1. Recognizes the wrapper invocation shape.
//   2. For management subcommands (auth, --version, --help, mcp, ...) it
//      passes through completely unmodified so the extension's probes
//      (e.g. `claude auth status`) return what the extension expects.
//   3. For real prompt invocations (--print with stdin), it classifies the
//      prompt and overrides --model / --effort / --max-budget-usd, then
//      exec's the real claude.
//   4. stream-json input from the VSCode panel: Maestro intercepts each user
//      turn, classifies it, and spawns claude --print --resume per turn.
//      Session continuity is preserved via --session-id + --resume. This
//      enables per-turn model routing without restarting the session.

import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { embeddingClassifier } from "../classifiers/embedding.js";
import { heuristicClassifier, createHeuristicClassifier } from "../classifiers/heuristic.js";
import { llmClassifier } from "../classifiers/llm.js";
import { markovClassifier } from "../classifiers/markov.js";
import { overrideClassifier } from "../classifiers/override.js";
import { toolOverrideClassifier } from "../classifiers/tool-override.js";
import { turnTypeClassifier } from "../classifiers/turn-type.js";
import { createPipeline } from "../core/pipeline.js";
import type { Pipeline } from "../core/pipeline.js";
import { loadProfile } from "../core/profile.js";
import { createTelemetry } from "../core/telemetry.js";
import type { Classifier, Decision, Profile } from "../core/types.js";
import { classifierCache } from "../core/classifier-cache.js";
import { parseOutput } from "../wrapper/output.js";
import { preflight } from "../wrapper/preflight.js";
import { streamClaude } from "../wrapper/stream.js";
import { runSdkProxy } from "../wrapper/sdk-proxy.js";
import type { LoadedCliConfig } from "./utils.js";
import { loadCliConfig } from "./utils.js";

const ROUTING_FLAGS_WITH_VALUE = new Set([
  "--model",
  "--effort",
  "--max-budget-usd",
]);

const KNOWN_SUBCOMMANDS = new Set([
  "run",
  "telemetry",
  "stats",
  "health",
  "tune",
  "replay",
  "bench",
  "install-vscode",
  "oracle",
  "help",
]);

/**
 * Claude CLI management subcommands that should always passthrough
 * unmodified. The VSCode extension probes several of these on startup.
 * Note: --version / --help are NOT here because Maestro handles those at
 * the top level (commander shows maestro --help / maestro --version).
 * Inside process-wrapper mode they reach this set indirectly via argv[3].
 */
const PASSTHROUGH_FIRST_ARGS = new Set([
  "auth",
  "mcp",
  "doctor",
  "agents",
  "plugin",
  "plugins",
  "install",
  "update",
  "upgrade",
  "setup-token",
  "auto-mode",
]);

/** Flags Maestro handles itself when invoked as a CLI (not as a wrapper). */
const MAESTRO_TOP_LEVEL_FLAGS = new Set(["--version", "-V", "--help", "-h"]);

export type WireCompatShape = "none" | "process-wrapper" | "direct-claude-args";

/**
 * Identify whether argv represents a wrapper invocation.
 *
 * - "process-wrapper": argv[2] is the real claude binary path, argv[3..]
 *   are claude args. This is what the VSCode extension does.
 * - "direct-claude-args": argv[2..] looks like claude args directly (no
 *   binary path). Used when a user aliases `claude=maestro` in their shell.
 * - "none": this is a Maestro subcommand invocation; commander handles it.
 */
export function detectWireCompatShape(argv: ReadonlyArray<string>): WireCompatShape {
  const args = argv.slice(2);
  if (args.length === 0) return "none";

  // If first non-flag arg is a known Maestro subcommand, normal mode.
  for (const a of args) {
    if (a.startsWith("-")) continue;
    if (KNOWN_SUBCOMMANDS.has(a)) return "none";
    break;
  }

  const first = args[0]!;

  // Maestro's own top-level flags must reach commander.
  if (MAESTRO_TOP_LEVEL_FLAGS.has(first)) return "none";

  // VSCode-style: first arg is an absolute path that exists and looks like
  // the real claude binary.
  if (isAbsolute(first) && looksLikeClaudeBinary(first)) {
    return "process-wrapper";
  }

  // Direct claude args: contains --print or a Claude management subcommand.
  if (args.includes("--print") || PASSTHROUGH_FIRST_ARGS.has(first)) {
    return "direct-claude-args";
  }

  return "none";
}

function looksLikeClaudeBinary(path: string): boolean {
  // Cheap heuristic. We don't want to spawn for the check.
  return path.endsWith("/claude") || path.endsWith("\\claude") || path.endsWith("/claude.exe");
}

/** Keep old name as an alias so callers stay compatible. */
export function shouldEnterWireCompat(argv: ReadonlyArray<string>): boolean {
  return detectWireCompatShape(argv) !== "none";
}

async function readStdin(timeoutMs = 100): Promise<string> {
  if (process.stdin.isTTY) return "";
  // Read with a short timeout: VSCode extension probes (auth status etc.)
  // don't pipe anything; we don't want to hang waiting for stdin.
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const finish = (): void => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      clearTimeout(timer);
    });
    process.stdin.on("end", () => {
      clearTimeout(timer);
      finish();
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      finish();
    });
  });
}

function resolveRealClaude(): string | null {
  const selfPath = (() => {
    try {
      return realpathSync(process.argv[1] ?? "");
    } catch {
      return "";
    }
  })();
  const candidates = [
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    "/usr/bin/claude",
  ];
  for (const c of candidates) {
    try {
      const real = realpathSync(c);
      if (real !== selfPath) return c;
    } catch {
      // not present
    }
  }
  return null;
}

function applyRouting(
  args: ReadonlyArray<string>,
  decision: Decision,
  bareSupported: boolean,
  userConfigExcludeDynamic: boolean | undefined,
): string[] {
  const filtered: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (ROUTING_FLAGS_WITH_VALUE.has(a)) {
      i++;
      continue;
    }
    filtered.push(a);
  }

  const spec = decision.spec;
  filtered.push("--model", spec.model);
  filtered.push("--effort", spec.effort);
  filtered.push("--max-budget-usd", String(spec.maxBudgetUsd));

  const excludeDynamic =
    spec.excludeDynamicSections !== undefined
      ? spec.excludeDynamicSections
      : (userConfigExcludeDynamic ?? true);
  if (excludeDynamic && !filtered.includes("--exclude-dynamic-system-prompt-sections")) {
    filtered.push("--exclude-dynamic-system-prompt-sections");
  }

  const codes = decision.diagnostics.map((d) => d.code);
  const bareSafe = codes.includes("heuristic.bare_safe");
  const disableBare = codes.includes("override.disable_bare");
  if (spec.bare === true && bareSafe && !disableBare && bareSupported && !filtered.includes("--bare")) {
    filtered.push("--bare");
  }

  return filtered;
}

function buildPipeline(cli: LoadedCliConfig): { pipeline: Pipeline; profile: Profile } {
  const { profile } = loadProfile({ userConfig: cli.userConfig, overrides: cli.profileOverrides });
  const heuristic =
    cli.userHeuristics.length > 0
      ? createHeuristicClassifier({ extraRules: cli.userHeuristics })
      : heuristicClassifier;
  // K2: markov prior goes first in the classifiers array, but pipeline evaluates it
  // only when sessionContext.recentClasses is present. Early position is declarative.
  const classifiers: Classifier[] = [overrideClassifier, turnTypeClassifier, toolOverrideClassifier, markovClassifier, heuristic];
  if (cli.userConfig.useEmbeddingClassifier !== false) classifiers.push(embeddingClassifier);
  // LLM stage is on by default. Cold-cache penalty (~$0.04, 13-20s) only hits
  // the first turn after a VSCode restart; subsequent turns hit cache_read and
  // resolve in <1s. Opt out with useLlmClassifierInWrapper: false if latency
  // on first turn is unacceptable for your workflow.
  if (cli.userConfig.useLlmClassifierInWrapper !== false) classifiers.push(llmClassifier);
  return { pipeline: createPipeline({ classifiers, profile }), profile };
}

export async function wireCompatMain(argv: ReadonlyArray<string>): Promise<number> {
  const shape = detectWireCompatShape(argv);
  if (shape === "none") return 0;

  // Determine real claude binary and the args we'll pass to it.
  let realClaude: string | null = null;
  let claudeArgs: ReadonlyArray<string> = [];
  if (shape === "process-wrapper") {
    realClaude = argv[2] ?? null;
    claudeArgs = argv.slice(3);
  } else {
    realClaude = resolveRealClaude();
    claudeArgs = argv.slice(2);
  }

  if (!realClaude) {
    process.stderr.write(
      "maestro (wire-compat): could not locate real `claude` binary.\n",
    );
    return 1;
  }

  // Passthrough management subcommands and probe flags untouched.
  const firstArg = claudeArgs[0];
  if (firstArg !== undefined && PASSTHROUGH_FIRST_ARGS.has(firstArg)) {
    const res = await streamClaude({
      binary: realClaude,
      args: claudeArgs,
      inheritStdin: true,
      stdout: process.stdout,
      stderr: process.stderr,
      forwardSigint: true,
    });
    return res.exitCode ?? 0;
  }

  // stream-json input is used by the VSCode panel SDK, which speaks a
  // bidirectional control protocol over stdin/stdout. The SDK-aware
  // proxy passes control frames through and injects a set_model
  // control_request before each user message based on the pipeline's
  // routing decision — per-turn cost optimization without breaking
  // the SDK lifecycle.
  if (argsContainStreamJsonInput(claudeArgs)) {
    const cli = await loadCliConfig();
    const { pipeline, profile } = buildPipeline(cli);
    const telemetry = createTelemetry(
      cli.userConfig.telemetryPath ? { path: cli.userConfig.telemetryPath } : {},
    );
    return runSdkProxy({
      realClaude,
      claudeArgs,
      pipeline,
      profile,
      userConfig: cli.userConfig,
      telemetry,
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
    });
  }

  // Text-input --print mode: read stdin, classify, modify args, exec real claude.
  const pre = preflight();
  const prompt = (await readStdin()).trim();
  if (!prompt) {
    // No prompt detected on stdin within the read timeout. Fall back to
    // inheriting stdin so anything the caller still writes reaches claude.
    const res = await streamClaude({
      binary: realClaude,
      args: claudeArgs,
      inheritStdin: true,
      stdout: process.stdout,
      stderr: process.stderr,
      forwardSigint: true,
    });
    return res.exitCode ?? 0;
  }

  const cli = await loadCliConfig();
  const { pipeline, profile } = buildPipeline(cli);

  // K1: classifier cache — bypass for overrides and continuation patterns
  const promptHash = classifierCache.promptHash(prompt);
  const shouldBypassCache =
    prompt.trim().startsWith("@") ||
    /^(continue|keep going|go on|and[?]?)\b/i.test(prompt.trim());

  let decision: Decision;
  const cachedClass = shouldBypassCache ? null : classifierCache.get(promptHash);
  if (cachedClass) {
    const spec = profile.classes[cachedClass.class];
    decision = {
      class: cachedClass.class,
      classifier: `cache:${cachedClass.classifier}`,
      confidence: cachedClass.confidence,
      spec,
      latencyMs: 0,
      diagnostics: [{ severity: "info" as const, code: "cache.classifier_hit", message: "classifier cache hit" }],
    };
  } else {
    decision = await pipeline.route({ prompt });
    // Store in classifier cache after routing
    if (!shouldBypassCache) {
      classifierCache.set(promptHash, {
        class: decision.class,
        classifier: decision.classifier,
        confidence: decision.confidence,
        cachedAt: new Date().toISOString(),
      });
    }
  }

  const modifiedArgs = applyRouting(
    claudeArgs,
    decision,
    pre.ok && pre.bareSupported,
    cli.userConfig.excludeDynamicSections,
  );

  const result = await streamClaude({
    binary: realClaude,
    args: modifiedArgs,
    prompt,
    stdout: process.stdout,
    stderr: process.stderr,
    forwardSigint: true,
  });

  try {
    const parsed = parseOutput(result.capturedStdout, cli.userConfig);
    if (parsed) {
      const telemetry = createTelemetry(
        cli.userConfig.telemetryPath ? { path: cli.userConfig.telemetryPath } : {},
      );
      await telemetry.log({
        type: "decision",
        ts: new Date().toISOString(),
        decision: {
          ...decision,
          cacheHit: (parsed.cost?.cacheReadInputTokens ?? 0) > 0,
        },
        cost: parsed.cost,
      });
    }
  } catch {
    /* never blocks routing */
  }

  return result.exitCode ?? 0;
}

function argsContainStreamJsonInput(args: ReadonlyArray<string>): boolean {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--input-format" && args[i + 1] === "stream-json") return true;
  }
  return false;
}
