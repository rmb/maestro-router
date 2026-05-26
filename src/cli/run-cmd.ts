// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { Command } from "commander";
import { embeddingClassifier } from "../classifiers/embedding.js";
import { heuristicClassifier, createHeuristicClassifier } from "../classifiers/heuristic.js";
import { llmClassifier } from "../classifiers/llm.js";
import { markovClassifier } from "../classifiers/markov.js";
import { overrideClassifier, stripOverride } from "../classifiers/override.js";
import { turnTypeClassifier } from "../classifiers/turn-type.js";
import type { Classifier, Class, Decision, CostBreakdown } from "../core/types.js";
import { PROMPT_TRUNCATE_CHARS } from "../core/types.js";
import { createTelemetry } from "../core/telemetry.js";
import { createPostHogClient } from "../core/posthog.js";
import { classifierCache } from "../core/classifier-cache.js";

const truncate = (s: string, max: number): string =>
  s.length > max ? s.slice(0, max) : s;

// T4: model upgrade ladder for auto-resume on max_tokens.
// Maps current model alias → stronger model alias. Opus has no upgrade.
const T4_UPGRADE: Readonly<Record<string, string>> = {
  haiku: "sonnet",
  sonnet: "opus",
};

/**
 * T4: Build the --resume args for a retry on a stronger model.
 * Pure function for easy testing.
 */
export function buildT4ResumeArgs(sessionId: string, upgradeModel: string): string[] {
  return ["--print", "--output-format", "json", "--resume", sessionId, "--model", upgradeModel];
}

/** T4: resolve the upgrade model, or null if already at the top (opus). */
export function resolveT4UpgradeModel(currentModel: string): string | null {
  // Normalise — model may be full name like "claude-haiku-4-5"; check for aliases
  const lower = currentModel.toLowerCase();
  for (const [alias, upgrade] of Object.entries(T4_UPGRADE)) {
    if (lower === alias || lower.includes(alias)) {
      return upgrade;
    }
  }
  return null; // already opus (or unrecognised — don't retry unknown models)
}

import { createPipeline } from "../core/pipeline.js";
import { loadProfile } from "../core/profile.js";
import { parseOutput } from "../wrapper/output.js";
import { preflight } from "../wrapper/preflight.js";
import { createSessionStore } from "../wrapper/session.js";
import { buildClaudeArgs, resolveAppendSystemPrompt } from "../wrapper/spawn.js";
import { streamClaude } from "../wrapper/stream.js";
import { computeFingerprint } from "../wrapper/prewarm.js";
import { detectContinuation } from "../wrapper/continuation.js";
import { applyFirstTurnGuard } from "../wrapper/first-turn-guard.js";
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

// T4 cycle-breaker: tracks session+prompt hashes that have already been
// retried in this process execution. Scoped to the module so tests can
// clear it between cases via the exported reset helper.
const _t4RetriedHashes = new Set<string>();

/** Exported only for tests — resets the T4 cycle-breaker between test cases. */
export function _resetT4RetryState(): void {
  _t4RetriedHashes.clear();
}

export type StreamFn = typeof streamClaude;

export function registerRunCommand(program: Command, _streamFn?: StreamFn): void {
  const doStream: StreamFn = _streamFn ?? streamClaude;
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
      // K2: markov prior in classifiers array (pipeline only uses it when sessionContext.recentClasses present)
      const classifiers: Classifier[] = [overrideClassifier, turnTypeClassifier, markovClassifier, heuristic];
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

      // K1: classifier cache — bypass for overrides and short continuation phrases
      const stripped = stripOverride(prompt);
      const promptHash = classifierCache.promptHash(prompt);
      const shouldBypassCache =
        prompt.trim().startsWith("@") ||
        /^(continue|keep going|go on|and[?]?)\b/i.test(prompt.trim());

      // Read lastStopReason from prior session for E1/E3 signals
      const priorStopReason = priorSession?.lastStopReason ?? null;
      const priorCacheReadTokens = priorSession?.lastCacheReadTokens ?? 0;

      // Detect M1 continuation before routing
      const continuationResult = detectContinuation(stripped, priorStopReason);

      let decision: Decision;
      const cachedClass = shouldBypassCache ? null : classifierCache.get(promptHash);
      if (cachedClass) {
        // Build decision from cached classification (K1 hit)
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
        decision = await pipeline.route(
          { prompt },
          {
            sessionContext: {
              recentClasses,
              ...(priorStopReason ? { lastStopReason: priorStopReason } : {}),
            },
          },
        );
        // Store result in classifier cache after routing (K1 set)
        if (!shouldBypassCache && decision.classifier !== "cache") {
          classifierCache.set(promptHash, {
            class: decision.class,
            classifier: decision.classifier,
            confidence: decision.confidence,
            cachedAt: new Date().toISOString(),
          });
        }
      }

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

      // Resolve the effective appendSystemPrompt once and store it on the
      // decision spec so telemetry-logged specs are self-contained — the oracle
      // can recompute the same fingerprint from the spec without needing
      // userConfig. Same value flows to spawn.ts via decision.spec.
      const resolvedAppendPrompt = resolveAppendSystemPrompt(decision, cli.userConfig);
      // Use effective bare: --bare is only applied when bareSupported (non-OAuth).
      // On OAuth (Team/Pro), bareSupported=false so bare is never emitted — the
      // fingerprint must reflect the actual system prompt, not the spec value.
      const effectiveBare = pre.bareSupported && (decision.spec.bare ?? false);
      const fp = computeFingerprint({
        model: decision.spec.model,
        bare: effectiveBare,
        excludeDynamicSections: decision.spec.excludeDynamicSections ?? true,
        ...(decision.spec.tools ? { tools: decision.spec.tools } : {}),
        ...(decision.spec.mcpConfig ? { mcpConfig: decision.spec.mcpConfig } : {}),
        appendSystemPrompt: resolvedAppendPrompt,
      });

      // Track Z kill switch: fall back to legacy getOrCreate when MAESTRO_DISABLE_TRACK_Z is set
      const session = process.env["MAESTRO_DISABLE_TRACK_Z"]
        ? await sessions.getOrCreate(process.cwd(), decision.spec.model, {
            ...(cmdOpts.newSession ? { newSession: true } : {}),
          })
        : await sessions.getByFingerprint(process.cwd(), fp, {
            ...(cmdOpts.newSession ? { newSession: true } : {}),
          });

      // Compaction advisory: warn when cached context is large enough that /compact pays for itself
      const COMPACT_THRESHOLD = 300_000;
      if (!session.isNew && priorCacheReadTokens > COMPACT_THRESHOLD) {
        process.stderr.write(
          `maestro: session at ~${Math.round(priorCacheReadTokens / 1000)}k cached context — /compact will reset it and reduce per-turn cache_read cost\n`,
        );
      }

      // E1.escalate: upgrade effort on sessions where a prior standard turn hit max_tokens
      const isEscalated = session.isNew ? false : await sessions.getEffortEscalated(session.sessionId);
      let effectiveDecision: Decision = {
        ...decision,
        spec: { ...decision.spec, appendSystemPrompt: resolvedAppendPrompt },
      };
      if (isEscalated && effectiveDecision.class === "standard" && effectiveDecision.spec.effort === "low") {
        effectiveDecision = {
          ...effectiveDecision,
          spec: { ...effectiveDecision.spec, effort: "medium" as const },
          diagnostics: [
            ...effectiveDecision.diagnostics,
            {
              severity: "info" as const,
              code: "e1.escalated",
              message: "effort upgraded low→medium (session escalation from prior max_tokens)",
            },
          ],
        };
      }

      // First-turn guard: session.isNew means no prior session existed for this cwd+fingerprint.
      const runCmdGuardEnabled = cli.userConfig.disableFirstTurnGuard !== true;
      const isFirstTurn = session.isNew;
      effectiveDecision = runCmdGuardEnabled
        ? applyFirstTurnGuard(effectiveDecision, isFirstTurn)
        : effectiveDecision;
      if (isFirstTurn && runCmdGuardEnabled && effectiveDecision.spec.model !== decision.spec.model) {
        log(`first-turn guard: ${decision.spec.model} → ${effectiveDecision.spec.model} (avoid $3-12 boot cost)`, quiet);
      }

      // M1 continuation: previously injected the hint via appendSystemPrompt
      // AFTER the fingerprint was computed — guaranteed cache miss. Now we pass
      // the hint as a leading user-message line via a separate field that
      // spawn.ts emits as a user-prompt prefix, not a system-prompt mutation.
      let continuationHint: string | null = null;
      if (continuationResult) {
        continuationHint = continuationResult.hint;
      }

      const args = buildClaudeArgs({
        decision: effectiveDecision,
        userConfig: cli.userConfig,
        sessionId: session.sessionId,
        isResume: !session.isNew,
        bareSupported: pre.bareSupported,
      });

      // Cross-model prewarm removed: per-model fingerprints differ in mcpConfig
      // (reasoning/max keep MCP access; trivial/simple/standard/hard strip it),
      // so prewarming with the current turn's config produced unreachable sessions.
      // Sessions warm naturally on first use — 3 unique fingerprints per cwd after
      // the profile.simple tools→default unification.

      // P1: M1 continuation hint is prepended to the user prompt rather than
      // mutating spec.appendSystemPrompt — keeps the cache prefix stable across
      // continuation turns. Cost: ~50 tokens of input vs guaranteed cache miss
      // on the entire system prompt prefix (~14-37k tokens).
      const promptWithHint = continuationHint
        ? `${continuationHint}\n\n${stripped}`
        : stripped;

      let result = await doStream({
        args,
        prompt: promptWithHint,
        stdout: process.stdout,
        stderr: process.stderr,
        forwardSigint: true,
      });

      // T4: auto-resume on max_tokens — parse the result early to check stop_reason.
      // When the model is below opus and the completion was truncated, retry on
      // a stronger model via --resume. Hard cap: one retry per turn.
      let t4OriginalCost: CostBreakdown | null = null;
      const autoResume = cli.userConfig.autoResumeOnMaxTokens !== false;
      if (autoResume) {
        const earlyParsed = parseOutput(result.capturedStdout, cli.userConfig);
        if (earlyParsed?.cost?.stopReason === "max_tokens") {
          const upgradeModel = resolveT4UpgradeModel(effectiveDecision.spec.model);
          if (upgradeModel === null) {
            // Already at opus — no retry possible; emit diagnostic to stderr
            process.stderr.write(
              `maestro: max_tokens on ${effectiveDecision.spec.model} (already top model) — no retry available\n`,
            );
          } else {
            // Cycle-breaker: hash of session + prompt to detect double-retry in one execution
            const retryHash = createHash("sha256")
              .update(session.sessionId + "\x00" + promptWithHint)
              .digest("hex");
            if (_t4RetriedHashes.has(retryHash)) {
              process.stderr.write(
                `maestro: max_tokens on ${effectiveDecision.spec.model} — skipping retry (already retried this turn)\n`,
              );
            } else {
              _t4RetriedHashes.add(retryHash);
              process.stderr.write(
                `maestro: max_tokens detected on ${effectiveDecision.spec.model} — auto-retrying on ${upgradeModel} via --resume\n`,
              );
              t4OriginalCost = earlyParsed.cost;
              const retryArgs = buildT4ResumeArgs(session.sessionId, upgradeModel);
              result = await doStream({
                args: retryArgs,
                prompt: promptWithHint,
                stdout: process.stdout,
                stderr: process.stderr,
                forwardSigint: true,
              });
            }
          }
        }
      }

      // Markov prior depends on a complete history — record the decided class
      // regardless of whether Claude returned parseable output (it may error,
      // hit a budget cap, or be interrupted — the routing decision still happened).
      await sessions.appendClass(session.sessionId, effectiveDecision.class);
      // Buffer this turn's prompt + class so the next turn can emit a correction event.
      void sessions.updateLastDecision(session.sessionId, truncate(prompt, PROMPT_TRUNCATE_CHARS), effectiveDecision.class);

      // P5: capture turn index for telemetry (after appendClass increment).
      const turnIndex = await sessions.getTurnCount(session.sessionId);

      const parsed = parseOutput(result.capturedStdout, cli.userConfig);

      // T4: when a retry happened, sum the original + retry costs so telemetry
      // reflects true spend. The stop_reason on the summed cost reflects the
      // retry's outcome (user-visible result).
      let effectiveParsed = parsed;
      if (t4OriginalCost !== null && parsed?.cost) {
        const retryCost = parsed.cost;
        const summedCost: CostBreakdown = {
          ...retryCost,
          totalCostUsd: t4OriginalCost.totalCostUsd + retryCost.totalCostUsd,
          inputTokens: t4OriginalCost.inputTokens + retryCost.inputTokens,
          outputTokens: t4OriginalCost.outputTokens + retryCost.outputTokens,
          cacheCreationInputTokens:
            t4OriginalCost.cacheCreationInputTokens + retryCost.cacheCreationInputTokens,
          cacheReadInputTokens:
            t4OriginalCost.cacheReadInputTokens + retryCost.cacheReadInputTokens,
          durationMs: t4OriginalCost.durationMs + retryCost.durationMs,
          durationApiMs: t4OriginalCost.durationApiMs + retryCost.durationApiMs,
          // stopReason reflects the retry's outcome (the user-visible result)
          stopReason: retryCost.stopReason,
        };
        effectiveParsed = {
          ...parsed,
          cost: summedCost,
        };
      }

      const telemetry = createTelemetry(
        cli.userConfig.telemetryPath ? { path: cli.userConfig.telemetryPath } : {},
      );
      // C1: Always log the routing decision — cost is optional (absent on error/interrupt/budget-cap).
      // Set cacheHit when Anthropic returned cached prefix tokens — this is the
      // ground truth for telemetry's cacheHitRate. Without this, decision.cacheHit
      // is always undefined and oracle's cache-hit-rate-accuracy check fails.
      const decisionWithCacheHit: Decision = {
        ...effectiveDecision,
        cacheHit: (effectiveParsed?.cost?.cacheReadInputTokens ?? 0) > 0,
        ...(t4OriginalCost !== null
          ? {
              diagnostics: [
                ...effectiveDecision.diagnostics,
                {
                  severity: "info" as const,
                  code: "t4.auto_resume",
                  message: `max_tokens on ${effectiveDecision.spec.model} → retried on stronger model`,
                },
              ],
            }
          : {}),
      };
      await telemetry.log({
        type: "decision",
        ts: new Date().toISOString(),
        decision: decisionWithCacheHit,
        ...(effectiveParsed?.cost ? { cost: effectiveParsed.cost } : {}),
        prompt: truncate(prompt, PROMPT_TRUNCATE_CHARS),
        sessionId: session.sessionId,
        turnIndex,
      });

      if (effectiveParsed) {
        // Outcome event: stop_reason + output token ratio reveals over/under-routing.
        if (effectiveParsed.cost) {
          void telemetry.log({
            type: "outcome",
            ts: new Date().toISOString(),
            sessionId: session.sessionId,
            decidedClass: effectiveDecision.class,
            stopReason: effectiveParsed.cost.stopReason,
            outputTokens: effectiveParsed.cost.outputTokens,
            cacheCreationTokens: effectiveParsed.cost.cacheCreationInputTokens,
            totalCostUsd: effectiveParsed.cost.totalCostUsd,
            durationApiMs: effectiveParsed.cost.durationApiMs,
          });

          // E1/E3: persist stop reason for next-turn escalation decisions
          void sessions.updateStopReason(session.sessionId, effectiveParsed.cost.stopReason);
          // Compaction advisory: persist cache_read for next turn's threshold check
          void sessions.updateLastCacheRead(session.sessionId, effectiveParsed.cost.cacheReadInputTokens);

          // E1.escalate: flag session for effort upgrade on next standard turn
          if (effectiveParsed.cost.stopReason === "max_tokens" && effectiveDecision.class === "standard") {
            void sessions.setEffortEscalated(session.sessionId);
            // K1.invalidate: drop cached classification so next identical prompt re-routes
            classifierCache.invalidate(promptHash);
          }
        }

        if (cli.userConfig.posthogApiKey) {
          const ph = createPostHogClient(cli.userConfig.posthogApiKey);
          // One-way SHA-256 of cwd — stable pseudonym, not reversible (no PII)
          const distinctId = createHash("sha256").update(process.cwd()).digest("hex").slice(0, 16);
          void ph.capture("maestro_decision", {
            distinct_id: distinctId,
            class: effectiveDecision.class,
            model: effectiveDecision.spec.model,
            effort: effectiveDecision.spec.effort,
            confidence: effectiveDecision.confidence,
            classifier: effectiveDecision.classifier,
            latency_ms: effectiveDecision.latencyMs,
            prompt_length: prompt.length,
            cost_usd: effectiveParsed.cost?.totalCostUsd ?? null,
          });

          if (effectiveParsed.cost) {
            void ph.capture("maestro_outcome", {
              distinct_id: distinctId,
              class: effectiveDecision.class,
              stop_reason: effectiveParsed.cost.stopReason,
              output_tokens: effectiveParsed.cost.outputTokens,
              cache_creation_tokens: effectiveParsed.cost.cacheCreationInputTokens,
              total_cost_usd: effectiveParsed.cost.totalCostUsd,
              duration_api_ms: effectiveParsed.cost.durationApiMs,
            });
          }

          // Emit override event when user used @fast / @deep / @think
          const overrideDiag = effectiveDecision.diagnostics.find(
            (d) => d.code === "override.matched" || d.code === "override.nl_think",
          );
          if (overrideDiag) {
            const hint = overrideDiag.message?.replace(/^@/, "") ?? "";
            const overrideProps: Record<string, unknown> = {
              distinct_id: distinctId,
              to_class: effectiveDecision.class,
              hint,
              prompt_length: prompt.length,
            };
            if (cli.userConfig.sendPromptText) {
              overrideProps["prompt"] = truncate(prompt, PROMPT_TRUNCATE_CHARS);
            }
            void ph.capture("maestro_override", overrideProps);
          }
        }

        for (const d of effectiveParsed.diagnostics) {
          if (d.severity === "hint" || d.severity === "warning") {
            process.stderr.write(`\n[maestro] ${d.code}: ${d.message}\n`);
          }
        }

        if (globalOpts.json) {
          process.stdout.write(format({ decision: effectiveDecision, cost: effectiveParsed.cost }, { json: true }) + "\n");
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
