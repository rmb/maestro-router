// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0
//
// `maestro shell` — interactive terminal REPL with per-turn routing. The
// terminal-side equivalent of the VSCode panel: it drives a real `claude`
// subprocess over the stream-json SDK transport and routes every turn through
// runSdkProxy, so model/effort selection is byte-identical to the panel.
//
// See wrapper/sdk-host.ts for the protocol and topology.

import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import { embeddingClassifier } from "../classifiers/embedding.js";
import { heuristicClassifier, createHeuristicClassifier } from "../classifiers/heuristic.js";
import { llmClassifier } from "../classifiers/llm.js";
import { markovClassifier } from "../classifiers/markov.js";
import { overrideClassifier } from "../classifiers/override.js";
import { toolOverrideClassifier } from "../classifiers/tool-override.js";
import { toolResultContentClassifier } from "../classifiers/tool-result-content.js";
import { turnTypeClassifier } from "../classifiers/turn-type.js";
import { createPipeline } from "../core/pipeline.js";
import { loadProfile } from "../core/profile.js";
import { createTelemetry } from "../core/telemetry.js";
import type { Classifier } from "../core/types.js";
import { preflight } from "../wrapper/preflight.js";
import { createSessionStore } from "../wrapper/session.js";
import { runShellHost } from "../wrapper/sdk-host.js";
import { resolveRealClaude } from "./wire-compat.js";
import { loadCliConfig } from "./utils.js";

function formatCwd(cwd: string): string {
  const home = process.env["HOME"] ?? "";
  const withTilde = home && cwd.startsWith(home) ? "~" + cwd.slice(home.length) : cwd;
  const rest = withTilde.startsWith("~/") ? withTilde.slice(2) : withTilde.replace(/^\//, "");
  const parts = rest.split("/").filter(Boolean);
  if (parts.length <= 2) return withTilde;
  return `~/…/${parts.slice(-2).join("/")}`;
}

function printBanner(info?: { cwd: string; resumed: boolean }): void {
  const isTTY = (process.stdout as { isTTY?: boolean }).isTTY === true;
  const D = isTTY ? "\x1b[2m" : "";
  const B = isTTY ? "\x1b[1m" : "";
  const R = isTTY ? "\x1b[0m" : "";
  const G = isTTY ? "\x1b[32m" : "";
  const C = isTTY ? "\x1b[36m" : "";
  const M = isTTY ? "\x1b[35m" : "";
  // W = inner box width. Every content line must fill exactly W visible chars.
  const W = 44;
  // 17 visible chars: "══ maestro shell "
  const topInner = `══ ${R}${B}maestro shell${R}${D} ${"═".repeat(W - 17)}`;
  const emptyInner = " ".repeat(W);
  const divInner = "═".repeat(W);

  const routeText = "auto-route · cheapest model that works"; // 38 visible
  const routeInner = "  " + routeText + " ".repeat(W - 2 - routeText.length);

  const haikuVisible = "haiku  ·  sonnet  ·  opus"; // 25 visible
  const haikuInner = `  ${G}haiku${R}${D}  ·  ${R}${C}sonnet${R}${D}  ·  ${R}${M}opus${R}${D}${" ".repeat(W - 2 - haikuVisible.length)}`;

  // Override hints: color-coded to match their model, dim separators.
  const hintsVisible = "@fast · @think · @deep  ·  /help"; // 32 visible
  const hintsInner = `  ${G}@fast${R}${D} · ${R}${C}@think${R}${D} · ${R}${M}@deep${R}${D}  ·  /help${" ".repeat(W - 2 - hintsVisible.length)}`;

  // Status row: cwd + session continuity — dim metadata.
  const cwdStr = info ? formatCwd(info.cwd) : formatCwd(process.cwd());
  const sessionStr = info?.resumed ? "resumed" : "new";
  const statusVisible = `${cwdStr}  ·  ${sessionStr}`;
  const maxStatusVisible = W - 2;
  const statusTrunc =
    statusVisible.length > maxStatusVisible
      ? statusVisible.slice(0, maxStatusVisible - 1) + "…"
      : statusVisible;
  const statusPad = " ".repeat(maxStatusVisible - statusTrunc.length);
  const statusInner = `  ${D}${statusTrunc}${statusPad}${R}`;

  const lines = [
    "",
    ` ${D}╔${topInner}╗${R}`,
    ` ${D}║${R}${emptyInner}${D}║${R}`,
    ` ${D}║${R}${routeInner}${D}║${R}`,
    ` ${D}║${R}${emptyInner}${D}║${R}`,
    ` ${D}╠${divInner}╣${R}`,
    ` ${D}║${R}${haikuInner}${D}║${R}`,
    ` ${D}║${R}${hintsInner}${D}║${R}`,
    ` ${D}╠${divInner}╣${R}`,
    ` ${D}║${statusInner}${D}║${R}`,
    ` ${D}╚${divInner}╝${R}`,
    "",
  ];
  process.stdout.write(lines.join("\n") + "\n");
}

export function registerShellCommand(program: Command): void {
  program
    .command("shell")
    .description(
      "Interactive REPL with per-turn routing — the terminal equivalent of the VSCode panel. Drives real claude over stream-json.",
    )
    .option("--new", "force a fresh session (don't seed Markov from prior history)")
    .action(async (cmdOpts: { new?: boolean }) => {
      const pre = preflight();
      if (!pre.ok) {
        process.stderr.write(`maestro: ${pre.reason}\n`);
        process.exit(1);
      }

      const realClaude = resolveRealClaude();
      if (!realClaude) {
        process.stderr.write("maestro: could not locate real `claude` binary on PATH.\n");
        process.exit(1);
      }

      const cli = await loadCliConfig();
      const { profile } = loadProfile({ userConfig: cli.userConfig, overrides: cli.profileOverrides });

      const heuristic =
        cli.userHeuristics.length > 0
          ? createHeuristicClassifier({ extraRules: cli.userHeuristics })
          : heuristicClassifier;
      const classifiers: Classifier[] = [
        overrideClassifier,
        turnTypeClassifier,
        toolResultContentClassifier,
        toolOverrideClassifier,
        markovClassifier,
        heuristic,
      ];
      if (cli.userConfig.useEmbeddingClassifier !== false) classifiers.push(embeddingClassifier);
      if (cli.userConfig.useLlmClassifierInWrapper !== false) classifiers.push(llmClassifier);
      const pipeline = createPipeline({ classifiers, profile });

      const telemetry = createTelemetry(
        cli.userConfig.telemetryPath ? { path: cli.userConfig.telemetryPath } : {},
      );

      // Seed Markov context from the most recent prior session in this cwd.
      const sessions = createSessionStore();
      const cwd = process.cwd();
      const allSessions = await sessions.list();
      const prior = allSessions
        .filter((s) => s.cwd === cwd)
        .sort((a, b) => Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt))[0];
      const recentClasses = cmdOpts.new ? [] : (prior?.recentClasses ?? []);

      const sessionId = randomUUID();
      const bootstrapModel = profile.classes.standard.model;
      const claudeArgs = [
        "--print",
        "--input-format", "stream-json",
        "--output-format", "stream-json",
        "--verbose",
        "--model", bootstrapModel,
        "--session-id", sessionId,
      ];

      printBanner({ cwd: process.cwd(), resumed: !cmdOpts.new && prior !== undefined });

      const code = await runShellHost({
        realClaude,
        claudeArgs,
        pipeline,
        profile,
        userConfig: cli.userConfig,
        telemetry,
        input: process.stdin,
        output: process.stdout,
        errput: process.stderr,
        sessions,
        sessionId,
        recentClasses,
      });

      process.exit(code);
    });
}
