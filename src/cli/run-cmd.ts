// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import type { Command } from "commander";
import { embeddingClassifier } from "../classifiers/embedding.js";
import { heuristicClassifier, createHeuristicClassifier } from "../classifiers/heuristic.js";
import { llmClassifier } from "../classifiers/llm.js";
import { overrideClassifier, stripOverride } from "../classifiers/override.js";
import { turnTypeClassifier } from "../classifiers/turn-type.js";
import type { Classifier } from "../core/types.js";
import { createTelemetry } from "../core/telemetry.js";
import { createPipeline } from "../core/pipeline.js";
import { loadProfile } from "../core/profile.js";
import { parseOutput } from "../wrapper/output.js";
import { preflight } from "../wrapper/preflight.js";
import { createSessionStore } from "../wrapper/session.js";
import { buildClaudeArgs } from "../wrapper/spawn.js";
import { streamClaude } from "../wrapper/stream.js";
import { format, loadCliConfig } from "./utils.js";

const log = (msg: string, quiet?: boolean): void => {
  if (!quiet) process.stderr.write(`[maestro] ${msg}\n`);
};

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function registerRunCommand(program: Command): void {
  program
    .command("run [prompt...]")
    .description(
      "Classify a prompt and forward to claude --print with the chosen flags. Reads stdin when no positional prompt is given.",
    )
    .option("--new-session", "force a fresh session id (no --resume)")
    .action(async (positional: string[], cmdOpts: { newSession?: boolean }) => {
      const globalOpts = program.opts<{ quiet?: boolean; json?: boolean; config?: string }>();
      const quiet = globalOpts.quiet === true;

      const fromArgs = positional.join(" ").trim();
      const prompt = fromArgs.length > 0 ? fromArgs : (await readStdin()).trim();
      if (!prompt) {
        process.stderr.write("Usage: maestro run <prompt>  (or pipe via stdin)\n");
        process.exit(2);
      }

      const pre = preflight();
      if (!pre.ok) {
        process.stderr.write(`maestro: ${pre.reason}\n`);
        process.exit(1);
      }
      log(`preflight ok (claude ${pre.version})`, quiet);

      const cli = await loadCliConfig(globalOpts.config);
      const { profile } = loadProfile({
        userConfig: cli.userConfig,
        overrides: cli.profileOverrides,
      });

      const heuristic =
        cli.userHeuristics.length > 0
          ? createHeuristicClassifier({ extraRules: cli.userHeuristics })
          : heuristicClassifier;

      const useEmbedding = cli.userConfig.useEmbeddingClassifier !== false;
      const useLlm = cli.userConfig.useLlmClassifier !== false;
      const classifiers: Classifier[] = [overrideClassifier, turnTypeClassifier, heuristic];
      if (useEmbedding) classifiers.push(embeddingClassifier);
      if (useLlm) classifiers.push(llmClassifier);
      const pipeline = createPipeline({
        classifiers,
        profile,
      });

      const decision = await pipeline.route({ prompt });
      log(
        `route: ${decision.classifier} → class=${decision.class} conf=${decision.confidence.toFixed(2)} model=${decision.spec.model} effort=${decision.spec.effort} budget=$${decision.spec.maxBudgetUsd}`,
        quiet,
      );

      const sessions = createSessionStore();
      const session = await sessions.getOrCreate(process.cwd(), {
        ...(cmdOpts.newSession ? { newSession: true } : {}),
      });

      const args = buildClaudeArgs({
        decision,
        userConfig: cli.userConfig,
        sessionId: session.sessionId,
        isResume: !session.isNew,
        bareSupported: pre.bareSupported,
      });

      const stripped = stripOverride(prompt);
      const result = await streamClaude({
        args,
        prompt: stripped,
        stdout: process.stdout,
        stderr: process.stderr,
        forwardSigint: true,
      });

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

        for (const d of parsed.diagnostics) {
          if (d.severity === "hint" || d.severity === "warning") {
            process.stderr.write(`\n[maestro] ${d.code}: ${d.message}\n`);
          }
        }

        if (globalOpts.json) {
          process.stdout.write(format({ decision, cost: parsed.cost }, { json: true }) + "\n");
        }
      }

      process.exit(result.exitCode ?? 0);
    });
}
