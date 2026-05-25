// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { Command } from "commander";
import { embeddingClassifier } from "../classifiers/embedding.js";
import { heuristicClassifier, createHeuristicClassifier } from "../classifiers/heuristic.js";
import { llmClassifier } from "../classifiers/llm.js";
import { overrideClassifier, stripOverride } from "../classifiers/override.js";
import { turnTypeClassifier } from "../classifiers/turn-type.js";
import type { Classifier, Class } from "../core/types.js";
import { PROMPT_TRUNCATE_CHARS } from "../core/types.js";
import { createTelemetry } from "../core/telemetry.js";
import { createPostHogClient } from "../core/posthog.js";

const truncate = (s: string, max: number): string =>
  s.length > max ? s.slice(0, max) : s;
import { createPipeline } from "../core/pipeline.js";
import { loadProfile } from "../core/profile.js";
import { parseOutput } from "../wrapper/output.js";
import { preflight } from "../wrapper/preflight.js";
import { createSessionStore } from "../wrapper/session.js";
import { buildClaudeArgs } from "../wrapper/spawn.js";
import { streamClaude } from "../wrapper/stream.js";
import { format, loadCliConfig, readState } from "./utils.js";

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
      // useLlmClassifierInWrapper defaults true — accuracy gain (~$0.001/uncertain prompt) justifies latency
      const useLlm = cli.userConfig.useLlmClassifierInWrapper !== false;
      const classifiers: Classifier[] = [overrideClassifier, turnTypeClassifier, heuristic];
      if (useEmbedding) classifiers.push(embeddingClassifier);
      if (useLlm) classifiers.push(llmClassifier);
      const pipeline = createPipeline({
        classifiers,
        profile,
      });

      // Read Markov prior from any recent session for this cwd
      const sessions = createSessionStore();
      const allSessions = await sessions.list();
      const cwd = process.cwd();
      const CORRECTION_WINDOW_MS = 60 * 60 * 1000; // only correlate turns within 1h
      const priorSession = allSessions
        .filter((s) => s.cwd === cwd)
        .sort((a, b) => Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt))[0];
      const recentClasses: string[] = priorSession?.recentClasses ?? [];
      // Buffer prev-turn decision for correction detection after routing
      const prevDecision =
        priorSession?.lastPrompt &&
        priorSession?.lastDecisionClass &&
        priorSession?.lastDecisionAt &&
        Date.now() - Date.parse(priorSession.lastDecisionAt) < CORRECTION_WINDOW_MS
          ? { prompt: priorSession.lastPrompt, cls: priorSession.lastDecisionClass as Class, ts: priorSession.lastDecisionAt }
          : null;

      const decision = await pipeline.route(
        { prompt },
        { sessionContext: { recentClasses } },
      );
      log(
        `route: ${decision.classifier} → class=${decision.class} conf=${decision.confidence.toFixed(2)} model=${decision.spec.model} effort=${decision.spec.effort} budget=$${decision.spec.maxBudgetUsd}`,
        quiet,
      );

      // Emit correction event when user uses @deep/@fast to correct a prior auto-routed turn.
      // This is the strongest implicit mis-classification signal: prev prompt was under/over-routed.
      const overrideDiagEarly = decision.diagnostics.find(
        (d) => d.code === "override.matched" || d.code === "override.nl_think",
      );
      if (overrideDiagEarly && prevDecision && prevDecision.cls !== decision.class) {
        const hint = overrideDiagEarly.message?.replace(/^@/, "") ?? "";
        const ts = new Date().toISOString();
        const correctionEvent = {
          type: "correction" as const,
          ts,
          sessionId: priorSession?.sessionId ?? "",
          prevClass: prevDecision.cls,
          correctedToClass: decision.class,
          hint,
          prevPrompt: prevDecision.prompt,
        };
        const telEarly = createTelemetry(
          cli.userConfig.telemetryPath ? { path: cli.userConfig.telemetryPath } : {},
        );
        void telEarly.log(correctionEvent);

        if (cli.userConfig.posthogApiKey) {
          const phEarly = createPostHogClient(cli.userConfig.posthogApiKey);
          const distinctId = Buffer.from(process.cwd()).toString("base64url").slice(0, 16);
          const corrProps: Record<string, unknown> = {
            distinct_id: distinctId,
            prev_class: prevDecision.cls,
            corrected_to_class: decision.class,
            hint,
            prev_prompt_length: prevDecision.prompt.length,
          };
          if (cli.userConfig.sendPromptText) {
            corrProps["prev_prompt"] = prevDecision.prompt;
          }
          void phEarly.capture("maestro_correction", corrProps);
        }
      }

      const session = await sessions.getOrCreate(process.cwd(), decision.spec.model, {
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

      // Markov prior depends on a complete history — record the decided class
      // regardless of whether Claude returned parseable output (it may error,
      // hit a budget cap, or be interrupted — the routing decision still happened).
      await sessions.appendClass(session.sessionId, decision.class);
      // Buffer this turn's prompt + class so the next turn can emit a correction event.
      void sessions.updateLastDecision(session.sessionId, truncate(prompt, PROMPT_TRUNCATE_CHARS), decision.class);

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
          prompt: truncate(prompt, PROMPT_TRUNCATE_CHARS),
        });

        // Outcome event: stop_reason + output token ratio reveals over/under-routing.
        if (parsed.cost) {
          void telemetry.log({
            type: "outcome",
            ts: new Date().toISOString(),
            sessionId: session.sessionId,
            decidedClass: decision.class,
            stopReason: parsed.cost.stopReason,
            outputTokens: parsed.cost.outputTokens,
            cacheCreationTokens: parsed.cost.cacheCreationInputTokens,
            totalCostUsd: parsed.cost.totalCostUsd,
            durationApiMs: parsed.cost.durationApiMs,
          });
        }

        if (cli.userConfig.posthogApiKey) {
          const ph = createPostHogClient(cli.userConfig.posthogApiKey);
          // One-way SHA-256 of cwd — stable pseudonym, not reversible (no PII)
          const distinctId = createHash("sha256").update(process.cwd()).digest("hex").slice(0, 16);
          void ph.capture("maestro_decision", {
            distinct_id: distinctId,
            class: decision.class,
            model: decision.spec.model,
            effort: decision.spec.effort,
            confidence: decision.confidence,
            classifier: decision.classifier,
            latency_ms: decision.latencyMs,
            prompt_length: prompt.length,
            cost_usd: parsed.cost?.totalCostUsd ?? null,
          });

          if (parsed.cost) {
            void ph.capture("maestro_outcome", {
              distinct_id: distinctId,
              class: decision.class,
              stop_reason: parsed.cost.stopReason,
              output_tokens: parsed.cost.outputTokens,
              cache_creation_tokens: parsed.cost.cacheCreationInputTokens,
              total_cost_usd: parsed.cost.totalCostUsd,
              duration_api_ms: parsed.cost.durationApiMs,
            });
          }

          // Emit override event when user used @fast / @deep / @think
          const overrideDiag = decision.diagnostics.find(
            (d) => d.code === "override.matched" || d.code === "override.nl_think",
          );
          if (overrideDiag) {
            const hint = overrideDiag.message?.replace(/^@/, "") ?? "";
            const overrideProps: Record<string, unknown> = {
              distinct_id: distinctId,
              to_class: decision.class,
              hint,
              prompt_length: prompt.length,
            };
            if (cli.userConfig.sendPromptText) {
              overrideProps["prompt"] = truncate(prompt, PROMPT_TRUNCATE_CHARS);
            }
            void ph.capture("maestro_override", overrideProps);
          }
        }

        for (const d of parsed.diagnostics) {
          if (d.severity === "hint" || d.severity === "warning") {
            process.stderr.write(`\n[maestro] ${d.code}: ${d.message}\n`);
          }
        }

        if (globalOpts.json) {
          process.stdout.write(format({ decision, cost: parsed.cost }, { json: true }) + "\n");
        }
      }

      // Background auto-tune: fetch community heuristics + apply local patterns.
      // Runs at most once per autoTuneIntervalDays (default 7). Fire-and-forget.
      void (async () => {
        try {
          const intervalDays = cli.userConfig.autoTuneIntervalDays ?? 7;
          const state = await readState();
          const lastRun = state.autoTuneLastRunAt ? Date.parse(state.autoTuneLastRunAt) : 0;
          if (Date.now() - lastRun > intervalDays * 24 * 60 * 60 * 1000) {
            // Always run --auto (community heuristics + local patterns).
            // Also run --posthog when credentials are present (cross-user override mining).
            const hasPh = !!(cli.userConfig.posthogQueryKey && cli.userConfig.posthogProjectId);
            const autoChild = spawn(process.execPath, [process.argv[1]!, "tune", "--auto"], {
              detached: true,
              stdio: "ignore",
              env: process.env,
            });
            autoChild.unref();
            if (hasPh) {
              const phChild = spawn(process.execPath, [process.argv[1]!, "tune", "--posthog"], {
                detached: true,
                stdio: "ignore",
                env: process.env,
              });
              phChild.unref();
            }
          }
        } catch {
          // never block the exit on auto-tune errors
        }
      })();

      process.exit(result.exitCode ?? 0);
    });
}
