// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0
//
// SDK-aware bidirectional stream-json proxy. Speaks the Claude Code SDK
// control protocol: passes initialize / MCP / hook / etc. control frames
// through to a long-running real claude subprocess, intercepts user text
// messages to inject a set_model control_request based on the pipeline's
// routing decision, and filters our injected control_responses out of
// the SDK-host-facing stdout.
//
// Per-tool routing (C12): when an assistant frame contains tool_use blocks,
// we record tool_use_id → tool_name in a bounded map. When the host later
// sends a tool_result user message, we look up the tool name and inject it
// as metadata.resolvedToolName into the Request so the tool-override
// classifier can return conf=1.0 decisions for known tools.

import { spawn as nodeSpawn, execFileSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { Pipeline } from "../core/pipeline.js";
import type { TelemetryWriter } from "../core/telemetry.js";
import { PROMPT_TRUNCATE_CHARS } from "../core/types.js";
import type { Decision, Profile, Request, UserConfig } from "../core/types.js";
import { parseOutput } from "./output.js";
import { stripLineNumbers } from "./line-stripper.js";
import { compressToolEnvelope } from "./tool-envelope.js";
import { createBatchHintState, recordPromptAndMaybeAdvise } from "./batch-hint.js";
import type { SessionStore } from "./session.js";
import {
  createToolVolumeState,
  incrementToolVolume,
  isHighVolumeTurn,
  resetToolVolume,
  upgradeModel,
} from "./tool-volume.js";
import { applyFirstTurnGuard } from "./first-turn-guard.js";

// I1: skip line-number stripping when RTK (rtk-ai/rtk) is already on PATH — it
// performs the same compression at a lower level, so duplicating the work wastes
// CPU and can corrupt multi-digit prefixes if the regex fires twice.
function rtkOnPath(): boolean {
  try {
    execFileSync("rtk", ["--version"], { stdio: "ignore", timeout: 500 });
    return true;
  } catch {
    return false;
  }
}
const RTK_PRESENT = rtkOnPath();
import {
  buildSetModelRequest,
  buildSetThinkingTokensRequest,
  effortToThinkingTokens,
  extractPromptText,
  extractRateLimitInfo,
  extractToolUseBlocks,
  extractToolResultInfo,
  extractToolUseIds,
  isToolResultMessage,
  isUserTextMessage,
  matchesInjectedRequestId,
  parseFrame,
  transformToolResults,
} from "./stream-json-frames.js";

export type SdkProxySpawn = (
  binary: string,
  args: ReadonlyArray<string>,
) => ChildProcess;

export type SdkProxyOptions = {
  realClaude: string;
  claudeArgs: ReadonlyArray<string>;
  pipeline: Pipeline;
  profile: Profile;
  userConfig: UserConfig;
  telemetry: TelemetryWriter;
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  /** Injectable spawn for tests. Defaults to node:child_process.spawn. */
  spawn?: SdkProxySpawn;
  /** Override RTK detection for tests. Defaults to module-level RTK_PRESENT. */
  rtkPresent?: boolean;
  /** Session store for Track Z / Markov persistence across VSCode panel turns. */
  sessions?: SessionStore;
  /** Session ID to append classes to after each routing decision. */
  sessionId?: string;
  /** Initial recentClasses from prior session, for Markov context on turn 1. */
  recentClasses?: string[];
};

const defaultSpawn: SdkProxySpawn = (binary, args) =>
  nodeSpawn(binary, [...args], { stdio: ["pipe", "pipe", "pipe"] });

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s;
}

/** P6: emergency model downgrade ladder for rate-limit pressure. */
function downgradeUnderPressure(model: string): string {
  if (model.includes("opus")) return "sonnet";
  if (model.includes("sonnet")) return "haiku";
  return model;
}

/** Maximum number of tool_use_id entries to keep in the tracking map. */
const TOOL_USE_MAP_MAX = 50;

export async function runSdkProxy(opts: SdkProxyOptions): Promise<number> {
  const spawn = opts.spawn ?? defaultSpawn;
  const skipI1 = opts.rtkPresent ?? RTK_PRESENT;
  const child = spawn(opts.realClaude, opts.claudeArgs);

  let injectedSeq = 0;
  let exitCode = 0;

  // Markov context: evolves as turns complete within this proxy session.
  // Seeded from prior session state so the first turn already benefits from history.
  const recentClasses: string[] = [...(opts.recentClasses ?? [])];

  /** Append class to in-memory window and persist to session store. */
  function recordClass(cls: string): void {
    recentClasses.push(cls);
    if (recentClasses.length > 5) recentClasses.shift();
    if (opts.sessions && opts.sessionId) {
      opts.sessions.appendClass(opts.sessionId, cls).catch(() => {});
    }
  }

  /**
   * Maps tool_use_id → tool_name, populated from assistant stdout frames.
   * Bounded to TOOL_USE_MAP_MAX entries; oldest entry evicted on overflow.
   * Used to resolve which tool triggered each tool_result turn on stdin.
   */
  const toolUseMap = new Map<string, string>();

  /**
   * Queue of pending telemetry entries. Each user/tool_result turn pushes one
   * entry; each result frame on stdout shifts the oldest off and logs it with
   * cost data. Deferred logging captures token counts even on subscription
   * plans where total_cost_usd is always 0.
   */
  const pendingQueue: Array<{
    decision: Decision;
    ts: string;
    prompt: string;
    turnIndex?: number;
  }> = [];

  // P5: count turns in this sdk-proxy run for telemetry.turnIndex
  let panelTurnCount = 0;

  // P9: batch-hint state — emits one-shot advisory on quick-fire short prompts
  const batchHint = createBatchHintState();

  // P6: track rate-limit pressure. When the 5h window is within 5 minutes of
  // exhaustion, force-downgrade subsequent set_model requests to haiku.
  // Resets when the rate_limit_event reports `status: "allowed"`.
  let rateLimitPressure = false;
  let rateLimitWarned = false;

  // P10: track cumulative cache_read tokens for session-bloat warnings.
  // Empirical thresholds from real telemetry analysis:
  //   500k → ~5-10× boot cost; soft warning (suggest /compact)
  //   2M   → 30-100× boot cost; hard warning (suggest restart)
  let maxCacheReadSeen = 0;
  let compactSuggested = false;
  let restartSuggested = false;

  // T2: track tool_use volume per turn; escalate model on high-volume turns.
  const toolVolumeState = createToolVolumeState();

  // ── stdout: filter injected control_responses, populate toolUseMap,
  // flush pending telemetry entries when result frames arrive.
  if (child.stdout) {
    child.stdout.setEncoding("utf8");
    let buf = "";
    child.stdout.on("data", (chunk: string) => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const frame = parseFrame(line);
        if (frame !== null) {
          if (matchesInjectedRequestId(frame)) continue;

          // P6: rate-limit signal — proactively pressure-downgrade when quota
          // is close to exhaustion or overage is disabled.
          const rli = extractRateLimitInfo(frame);
          if (rli !== null) {
            const secondsToReset = rli.resetsAt - Math.floor(Date.now() / 1000);
            const isLimited = rli.status === "limited";
            const isCloseToReset = secondsToReset > 0 && secondsToReset < 300;
            const overageBlocked =
              rli.overageStatus === "rejected" || rli.overageDisabledReason !== undefined;
            rateLimitPressure = isLimited || isCloseToReset;
            if ((rateLimitPressure || overageBlocked) && !rateLimitWarned) {
              rateLimitWarned = true;
              const detail = overageBlocked
                ? `overage blocked (${rli.overageDisabledReason ?? "rejected"})`
                : `${rli.rateLimitType} window resets in ${Math.max(secondsToReset, 0)}s`;
              opts.stderr.write(
                `maestro: rate limit pressure — ${detail}; downgrading expensive models.\n`,
              );
            }
          }

          // Track tool_use blocks from assistant frames for per-tool routing.
          const toolUseBlocks = extractToolUseBlocks(frame);
          for (const { id, name } of toolUseBlocks) {
            if (toolUseMap.size >= TOOL_USE_MAP_MAX) {
              // Evict the oldest entry (Map preserves insertion order).
              const firstKey = toolUseMap.keys().next().value;
              if (firstKey !== undefined) toolUseMap.delete(firstKey);
            }
            toolUseMap.set(id, name);
          }
          // T2: accumulate tool call count for volume-based model escalation.
          if (toolUseBlocks.length > 0) {
            incrementToolVolume(toolVolumeState, toolUseBlocks.length);
          }
          // Flush oldest pending entry with cost data when a turn result arrives.
          if (frame.type === "result") {
            const p = pendingQueue.shift();
            if (p !== undefined) {
              const parsed = parseOutput(JSON.stringify(frame), opts.userConfig);
              const cacheHit = (parsed?.cost?.cacheReadInputTokens ?? 0) > 0;

              // P10: session-bloat warnings keyed on cache_read tokens.
              const cacheRead = parsed?.cost?.cacheReadInputTokens ?? 0;
              if (cacheRead > maxCacheReadSeen) maxCacheReadSeen = cacheRead;
              if (!compactSuggested && maxCacheReadSeen > 500_000) {
                compactSuggested = true;
                opts.stderr.write(
                  `maestro: session context now ${(maxCacheReadSeen / 1000).toFixed(0)}k cache_read tokens (~5-10× boot cost). Consider /compact.\n`,
                );
              }
              if (!restartSuggested && maxCacheReadSeen > 2_000_000) {
                restartSuggested = true;
                opts.stderr.write(
                  `maestro: session context now ${(maxCacheReadSeen / 1_000_000).toFixed(1)}M cache_read tokens (30-100× boot cost). Cheaper to restart than continue.\n`,
                );
              }

              opts.telemetry.log({
                type: "decision",
                ts: p.ts,
                decision: { ...p.decision, cacheHit },
                ...(parsed ? { cost: parsed.cost } : {}),
                ...(p.prompt ? { prompt: p.prompt } : {}),
                ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
                ...(p.turnIndex !== undefined ? { turnIndex: p.turnIndex } : {}),
              }).catch(() => { /* telemetry must never block routing */ });
            }
          }
        }
        opts.stdout.write(line + "\n");
      }
    });
  }

  if (child.stderr) {
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => opts.stderr.write(chunk));
  }

  // ── child lifecycle: capture exit code, propagate to caller.
  const closed = new Promise<void>((resolve) => {
    child.on("close", (code) => {
      exitCode = code ?? 0;
      resolve();
    });
  });

  // ── stdin: parse line-by-line, intercept user text messages, forward everything else.
  const rl = readline.createInterface({ input: opts.stdin, crlfDelay: Infinity });

  for await (const line of rl) {
    const frame = parseFrame(line);

    // tool_result check MUST come before isUserTextMessage: mixed frames
    // (tool_result block + text sidechain) satisfy both predicates; checking
    // user-text first would skip tool routing entirely via the continue below.
    if (frame !== null && isToolResultMessage(frame)) {
      const ids = extractToolUseIds(frame);
      const resolvedToolName =
        ids.length > 0 ? toolUseMap.get(ids[0]!) : undefined;

      const trInfo = extractToolResultInfo(frame);
      const request: Request = {
        prompt: "",
        metadata: {
          ...(resolvedToolName !== undefined ? { resolvedToolName } : {}),
          ...(trInfo !== null
            ? {
                toolResultContentLength: trInfo.contentLength,
                toolResultContentSample: trInfo.content,
              }
            : {}),
        },
      };

      const decision: Decision = await opts.pipeline.route(request, {
        sessionContext: { recentClasses: [...recentClasses] },
      });

      // First-turn guard: recentClasses.length === 0 means no prior interaction in this session.
      const guardEnabled = opts.userConfig.disableFirstTurnGuard !== true;
      const toolResultIsFirstTurn = recentClasses.length === 0;
      const guardedDecision = guardEnabled
        ? applyFirstTurnGuard(decision, toolResultIsFirstTurn)
        : decision;
      if (guardedDecision.spec.model !== decision.spec.model) {
        opts.stderr.write(
          `maestro: first-turn guard: ${decision.spec.model} → ${guardedDecision.spec.model} (avoid $3-12 boot cost)\n`,
        );
      }

      recordClass(guardedDecision.class);

      // T2: upgrade model one tier when this turn has exceeded the tool volume threshold.
      const finalModel = isHighVolumeTurn(toolVolumeState)
        ? upgradeModel(guardedDecision.spec.model)
        : guardedDecision.spec.model;
      if (finalModel !== guardedDecision.spec.model) {
        opts.stderr.write(
          `maestro: tool-volume escalation (${toolVolumeState.toolCallsThisTurn} tool calls) → ${finalModel}\n`,
        );
      }

      injectedSeq += 1;
      const setModel = buildSetModelRequest(finalModel, injectedSeq);
      child.stdin?.write(JSON.stringify(setModel) + "\n");

      // P3: inject set_max_thinking_tokens so effort routing actually works in
      // sdk-proxy mode (spawn-time --effort isn't available here).
      if (opts.userConfig.injectSetMaxThinkingTokens !== false) {
        injectedSeq += 1;
        const setThink = buildSetThinkingTokensRequest(
          effortToThinkingTokens(guardedDecision.spec.effort),
          injectedSeq,
        );
        child.stdin?.write(JSON.stringify(setThink) + "\n");
      }

      // I1 + P7: chain transforms. I1 strips line-numbers (skipped when RTK on PATH).
      // P7 collapses Claude-Code-specific envelope boilerplate (file ack, todo ack,
      // file-state footer, stream-closed noise) — orthogonal to RTK, always on.
      let transformed = frame;
      if (!skipI1) transformed = transformToolResults(transformed, stripLineNumbers);
      transformed = transformToolResults(transformed, compressToolEnvelope);
      const strippedLine = JSON.stringify(transformed);
      child.stdin?.write(strippedLine + "\n");

      // Tool result routing: classifier runs, set_model injected, but decision
      // events only logged for user-text turns (cost tracking per-tool, not per-use).

      continue;
    }

    if (frame !== null && isUserTextMessage(frame)) {
      const promptText = extractPromptText(frame) ?? "";
      const t0 = Date.now();
      // T2: reset tool volume counter — a new user turn begins.
      resetToolVolume(toolVolumeState);

      // Slash commands (/model, /clear, /compact, etc.) are interactive
      // directives handled by the SDK host. Don't classify them, and
      // don't inject set_model — they should reach the SDK host's command
      // handler unmodified.
      if (promptText.startsWith("/")) {
        child.stdin?.write(line + "\n");
        continue;
      }

      const decision: Decision = await opts.pipeline.route(
        { prompt: promptText },
        { sessionContext: { recentClasses: [...recentClasses] } },
      );

      // First-turn guard: panelTurnCount === 0 means this is the first user turn.
      const userTurnGuardEnabled = opts.userConfig.disableFirstTurnGuard !== true;
      const isFirstUserTurn = panelTurnCount === 0;
      const guardedDecision = userTurnGuardEnabled
        ? applyFirstTurnGuard(decision, isFirstUserTurn)
        : decision;
      if (guardedDecision.spec.model !== decision.spec.model) {
        opts.stderr.write(
          `maestro: first-turn guard: ${decision.spec.model} → ${guardedDecision.spec.model} (avoid $3-12 boot cost)\n`,
        );
      }

      // Inject set_model BEFORE forwarding the user message so claude
      // honors the new model on this turn. P6: under rate-limit pressure,
      // force-downgrade to the cheapest model that still serves the class.
      const modelToUse = rateLimitPressure
        ? downgradeUnderPressure(guardedDecision.spec.model)
        : guardedDecision.spec.model;
      injectedSeq += 1;
      const setModel = buildSetModelRequest(modelToUse, injectedSeq);
      child.stdin?.write(JSON.stringify(setModel) + "\n");

      // P3: inject set_max_thinking_tokens for real effort control in panel mode.
      // Cap thinking under rate-limit pressure regardless of decision effort.
      // Opt-out via userConfig.injectSetMaxThinkingTokens=false (protocol is
      // reverse-engineered from cli.js — could change across CC versions).
      if (opts.userConfig.injectSetMaxThinkingTokens !== false) {
        const effortForThink = rateLimitPressure ? "low" : guardedDecision.spec.effort;
        injectedSeq += 1;
        const setThink = buildSetThinkingTokensRequest(
          effortToThinkingTokens(effortForThink),
          injectedSeq,
        );
        child.stdin?.write(JSON.stringify(setThink) + "\n");
      }

      child.stdin?.write(line + "\n");

      // Persist routing class for Markov context on subsequent turns.
      recordClass(guardedDecision.class);
      panelTurnCount += 1;

      // P9: emit batch-hint advisory on quick-fire clusters (one-shot per run)
      const hint = recordPromptAndMaybeAdvise(batchHint, guardedDecision.class);
      if (hint) opts.stderr.write(`${hint}\n`);

      // Defer telemetry: flush when result frame arrives on stdout.
      pendingQueue.push({
        decision: { ...guardedDecision, latencyMs: Date.now() - t0 },
        ts: new Date().toISOString(),
        prompt: truncate(promptText, PROMPT_TRUNCATE_CHARS),
        turnIndex: panelTurnCount,
      });

      continue;
    }

    // Control frame, assistant message, result, anything else: pass through.
    child.stdin?.write(line + "\n");
  }

  // Stdin closed by caller — end the child's stdin to let it terminate.
  child.stdin?.end();

  await closed;
  return exitCode;
}
