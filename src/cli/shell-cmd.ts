// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0
//
// `maestro shell` — interactive terminal REPL with per-turn routing. The
// terminal-side equivalent of the VSCode panel: it drives a real `claude`
// subprocess over the stream-json SDK transport and routes every turn through
// runSdkProxy, so model/effort selection is byte-identical to the panel.
//
// See wrapper/sdk-host.ts for the protocol and topology.

import { computeFingerprint } from "../wrapper/prewarm.js";
import type { Command } from "commander";
import { createEmbeddingClassifier } from "../classifiers/embedding.js";
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
import { renderBanner } from "./components/Banner.js";

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
      if (cli.userConfig.useEmbeddingClassifier !== false)
        classifiers.push(
          createEmbeddingClassifier(
            cli.userConfig.embeddingModel !== undefined
              ? { modelId: cli.userConfig.embeddingModel }
              : {},
          ),
        );
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

      // F9: reuse the most recent session for this fingerprint to amortize cache_creation cost.
      const standardSpec = profile.classes.standard;
      const fp = computeFingerprint({
        model: standardSpec.model,
        bare: false,
        excludeDynamicSections: standardSpec.excludeDynamicSections ?? true,
        ...(standardSpec.tools ? { tools: standardSpec.tools } : {}),
        ...(standardSpec.mcpConfig ? { mcpConfig: standardSpec.mcpConfig } : {}),
      });
      const shellSession = await sessions.getByFingerprint(cwd, fp, {
        ...(cmdOpts.new ? { newSession: true } : {}),
      });
      const { sessionId, isNew } = shellSession;
      const claudeArgs = [
        "--print",
        "--input-format", "stream-json",
        "--output-format", "stream-json",
        "--verbose",
        "--model", standardSpec.model,
        "--session-id", sessionId,
        ...(!isNew ? ["--resume"] : []),
      ];

      await renderBanner({ cwd: process.cwd(), resumed: !isNew });

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
