// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0
//
// Wire-compatibility layer. When invoked with Claude-style argv (e.g.,
// by VSCode's `claudeCode.claudeProcessWrapper`), Maestro:
//   1. reads the prompt from stdin (Claude --print mode does this),
//   2. classifies it,
//   3. overrides the model/effort/budget flags,
//   4. exec's the *real* `claude` with the modified args.

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { delimiter, sep } from "node:path";
import { heuristicClassifier, createHeuristicClassifier } from "../classifiers/heuristic.js";
import { overrideClassifier } from "../classifiers/override.js";
import { turnTypeClassifier } from "../classifiers/turn-type.js";
import { createPipeline } from "../core/pipeline.js";
import { loadProfile } from "../core/profile.js";
import { createTelemetry } from "../core/telemetry.js";
import type { Decision } from "../core/types.js";
import { parseOutput } from "../wrapper/output.js";
import { preflight } from "../wrapper/preflight.js";
import { streamClaude } from "../wrapper/stream.js";
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
  "tune",
  "replay",
  "bench",
  "install-vscode",
  "help",
]);

/**
 * Decide whether argv is a Claude-style passthrough invocation (e.g. from
 * claudeProcessWrapper) versus a Maestro subcommand. The signal is:
 * `--print` present AND no known Maestro subcommand in the first positional.
 */
export function shouldEnterWireCompat(argv: ReadonlyArray<string>): boolean {
  const args = argv.slice(2);
  if (args.length === 0) return false;
  for (const a of args) {
    if (a === "--print") return shouldEnterWireCompatPositional(args);
    if (!a.startsWith("-")) {
      if (KNOWN_SUBCOMMANDS.has(a)) return false;
      // Bare positional that is not a known subcommand → user error, let
      // commander handle it.
      return false;
    }
  }
  return false;
}

function shouldEnterWireCompatPositional(args: ReadonlyArray<string>): boolean {
  for (const a of args) {
    if (!a.startsWith("-") && KNOWN_SUBCOMMANDS.has(a)) return false;
  }
  return true;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Resolve the real `claude` binary on PATH, excluding the path of this
 * Maestro binary so we don't recurse. Returns null when not found or only
 * the Maestro binary is on PATH under the name `claude`.
 */
function resolveRealClaude(): string | null {
  const selfPath = (() => {
    try {
      return realpathSync(process.argv[1] ?? "");
    } catch {
      return "";
    }
  })();

  const PATH = process.env.PATH ?? "";
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE").split(";") : [""];
  for (const dir of PATH.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = `${dir}${sep}claude${ext}`;
      try {
        const real = realpathSync(candidate);
        if (real === selfPath) continue;
        // verify by attempting --version
        const res = spawnSync(candidate, ["--version"], { encoding: "utf8" });
        if (res.status === 0 && typeof res.stdout === "string" && res.stdout.includes("Claude")) {
          return candidate;
        }
      } catch {
        // not present at this path
      }
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

  // S8/S9 — we deliberately do NOT override --tools or --mcp-config here.
  // VSCode (or whatever caller wrapped us) may have configured these for the
  // user's actual session; clobbering would break tools they rely on.
  // `maestro run` applies S8/S9 explicitly. Wrapper mode trusts the caller.

  return filtered;
}

export async function wireCompatMain(argv: ReadonlyArray<string>): Promise<number> {
  const inboundArgs = argv.slice(2);

  const pre = preflight();
  if (!pre.ok) {
    process.stderr.write(`maestro (wire-compat): ${pre.reason}\n`);
    return 1;
  }

  const realClaude = resolveRealClaude();
  if (!realClaude) {
    process.stderr.write(
      "maestro (wire-compat): could not locate real `claude` binary on PATH (excluding the maestro symlink).\n",
    );
    return 1;
  }

  const prompt = (await readStdin()).trim();
  if (!prompt) {
    // No prompt: nothing to classify. Passthrough unmodified.
    const res = await streamClaude({
      binary: realClaude,
      args: inboundArgs,
      prompt: "",
      stdout: process.stdout,
      stderr: process.stderr,
      forwardSigint: true,
    });
    return res.exitCode ?? 0;
  }

  const cli = await loadCliConfig();
  const { profile } = loadProfile({
    userConfig: cli.userConfig,
    overrides: cli.profileOverrides,
  });
  const heuristic =
    cli.userHeuristics.length > 0
      ? createHeuristicClassifier({ extraRules: cli.userHeuristics })
      : heuristicClassifier;
  const pipeline = createPipeline({
    classifiers: [overrideClassifier, turnTypeClassifier, heuristic],
    profile,
  });

  const decision = await pipeline.route({ prompt });

  const modifiedArgs = applyRouting(
    inboundArgs,
    decision,
    pre.bareSupported,
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

  // Best-effort telemetry. Don't block on failure.
  try {
    const parsed = parseOutput(result.capturedStdout, cli.userConfig);
    if (parsed) {
      const telemetry = createTelemetry(
        cli.userConfig.telemetryPath ? { path: cli.userConfig.telemetryPath } : {},
      );
      await telemetry.log({
        type: "decision",
        ts: new Date().toISOString(),
        decision,
        cost: parsed.cost,
      });
    }
  } catch {
    /* never blocks routing */
  }

  return result.exitCode ?? 0;
}
