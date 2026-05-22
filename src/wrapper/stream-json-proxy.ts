// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import readline from "node:readline";
import { spawn as nodeSpawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { CostBreakdown, Decision, Profile, UserConfig } from "../core/types.js";
import { PROMPT_TRUNCATE_CHARS } from "../core/types.js";
import type { Pipeline } from "../core/pipeline.js";
import type { TelemetryWriter } from "../core/telemetry.js";
import { isSlashPrefix } from "./passthrough.js";

const truncate = (s: string, max: number): string =>
  s.length > max ? s.slice(0, max) : s;

export type UserTurn = {
  promptText: string;
  sessionId: string | null;
};

export type TurnResult = {
  exitCode: number | null;
  cost: CostBreakdown | null;
  sessionId: string | null;
};

export type SpawnTurnFn = (
  binary: string,
  args: ReadonlyArray<string>,
  prompt: string,
  stdout: Writable,
  isFirstTurn: boolean,
  stderr?: Writable,
) => Promise<TurnResult>;

export type StreamJsonProxyOptions = {
  realClaude: string;
  claudeArgs: ReadonlyArray<string>;
  pipeline: Pipeline;
  /** Active profile, used to construct the pass-through decision for slash commands. */
  profile: Profile;
  userConfig: UserConfig;
  telemetry: TelemetryWriter;
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  /** Injectable for testing — defaults to streamClaudeForTurn. */
  spawnTurn?: SpawnTurnFn;
};

const ROUTING_FLAGS_WITH_VALUE = new Set(["--model", "--effort", "--max-budget-usd"]);

/**
 * Scans args for --session-id <value>. Returns the UUID or null.
 */
export function extractSessionId(args: ReadonlyArray<string>): string | null {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--session-id") {
      const val = args[i + 1];
      return typeof val === "string" && !val.startsWith("-") ? val : null;
    }
  }
  return null;
}

/**
 * Constructs the CLI args for one --print turn.
 * Strips: --input-format stream-json, --output-format <any>, routing flags,
 *         --session-id, --resume, --bare.
 * Adds:   --print, --output-format stream-json, --session-id, --resume (turns 2+),
 *         routing flags, --exclude-dynamic-system-prompt-sections.
 * Never adds --bare (panel needs full structured output).
 */
export function buildTurnArgs(
  base: ReadonlyArray<string>,
  decision: Decision,
  sessionId: string | null,
  isFirstTurn: boolean,
  _bareSupported: boolean,
  excludeDynamic: boolean | undefined,
): string[] {
  const hadResume = base.includes("--resume");
  const filtered: string[] = [];

  for (let i = 0; i < base.length; i++) {
    const a = base[i]!;
    if (a === "--input-format") { i++; continue; }
    if (a === "--output-format") { i++; continue; }
    if (ROUTING_FLAGS_WITH_VALUE.has(a)) { i++; continue; }
    if (a === "--session-id") { i++; continue; }
    if (a === "--resume") continue;
    if (a === "--bare") continue;
    filtered.push(a);
  }

  if (!filtered.includes("--print")) filtered.push("--print");
  filtered.push("--output-format", "stream-json");

  if (sessionId) filtered.push("--session-id", sessionId);
  // Turn 1: add --resume only if the extension already sent --resume (resuming a prior session).
  // Turn 2+: always resume to continue the session established in turn 1.
  if (!isFirstTurn || hadResume) filtered.push("--resume");

  const spec = decision.spec;
  filtered.push("--model", spec.model);
  filtered.push("--effort", spec.effort);
  filtered.push("--max-budget-usd", String(spec.maxBudgetUsd));

  const exclude =
    spec.excludeDynamicSections !== undefined
      ? spec.excludeDynamicSections
      : (excludeDynamic ?? true);
  if (exclude && !filtered.includes("--exclude-dynamic-system-prompt-sections")) {
    filtered.push("--exclude-dynamic-system-prompt-sections");
  }

  return filtered;
}

type RawUserMsg = {
  type?: string;
  session_id?: string;
  message?: { content?: Array<{ type?: string; text?: string }> };
};

/**
 * Advances the iterator until a routeable user text turn is found.
 * Skips: system, assistant, tool_result-only user messages, non-JSON lines.
 * Returns null when the stream closes.
 */
export async function readNextUserTurn(
  lines: AsyncIterator<string>,
): Promise<UserTurn | null> {
  while (true) {
    const { done, value } = await lines.next();
    if (done) return null;
    const line = value.trim();
    if (!line.startsWith("{")) continue;
    let msg: RawUserMsg;
    try {
      msg = JSON.parse(line) as RawUserMsg;
    } catch {
      continue;
    }
    if (msg.type !== "user") continue;
    const content = msg.message?.content;
    if (!Array.isArray(content)) continue;
    const textBlock = content.find((c) => c.type === "text" && typeof c.text === "string");
    if (!textBlock?.text) continue;
    return {
      promptText: textBlock.text,
      sessionId: typeof msg.session_id === "string" ? msg.session_id : null,
    };
  }
}

type RawResultLine = {
  type?: string;
  session_id?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    service_tier?: string;
  };
  modelUsage?: Record<string, {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    costUSD?: number;
  }>;
};

function isInitLine(line: string): boolean {
  try {
    const obj = JSON.parse(line) as { type?: string; subtype?: string };
    return obj.type === "system" && obj.subtype === "init";
  } catch {
    return false;
  }
}

function parseResultLine(line: string): { cost: CostBreakdown; sessionId: string | null } | null {
  try {
    const obj = JSON.parse(line) as RawResultLine;
    if (obj.type !== "result") return null;
    const modelKeys = obj.modelUsage ? Object.keys(obj.modelUsage) : [];
    const modelEntry = modelKeys[0] ? (obj.modelUsage![modelKeys[0]] ?? null) : null;
    const usage = obj.usage ?? {};
    const inp = (usage.input_tokens ?? 0) > 0 ? usage.input_tokens! : (modelEntry?.inputTokens ?? 0);
    const out = (usage.output_tokens ?? 0) > 0 ? usage.output_tokens! : (modelEntry?.outputTokens ?? 0);
    const cw = (usage.cache_creation_input_tokens ?? 0) > 0
      ? usage.cache_creation_input_tokens!
      : (modelEntry?.cacheCreationInputTokens ?? 0);
    const cr = (usage.cache_read_input_tokens ?? 0) > 0
      ? usage.cache_read_input_tokens!
      : (modelEntry?.cacheReadInputTokens ?? 0);
    return {
      cost: {
        totalCostUsd: obj.total_cost_usd ?? modelEntry?.costUSD ?? 0,
        inputTokens: inp,
        outputTokens: out,
        cacheCreationInputTokens: cw,
        cacheReadInputTokens: cr,
        durationMs: obj.duration_ms ?? 0,
        durationApiMs: obj.duration_api_ms ?? 0,
        stopReason: obj.stop_reason ?? "unknown",
        modelUsed: modelKeys[0] ?? "unknown",
        serviceTier: usage.service_tier ?? "unknown",
      },
      sessionId: typeof obj.session_id === "string" ? obj.session_id : null,
    };
  } catch {
    return null;
  }
}

/**
 * Spawns claude --print for one turn. Writes prompt to stdin, forwards NDJSON
 * events to stdout. Suppresses the {"type":"system","subtype":"init"} event on
 * turns 2+ (the extension already has one from turn 1). Parses the result event
 * for telemetry.
 */
export async function streamClaudeForTurn(
  binary: string,
  args: ReadonlyArray<string>,
  prompt: string,
  stdout: Writable,
  isFirstTurn: boolean,
  stderr?: Writable,
): Promise<TurnResult> {
  return new Promise((resolve, reject) => {
    const child = nodeSpawn(binary, [...args], { stdio: ["pipe", "pipe", "pipe"] });
    let lastResult: { cost: CostBreakdown; sessionId: string | null } | null = null;
    let buffer = "";
    let settled = false;

    const flushLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (!isFirstTurn && trimmed.startsWith("{") && isInitLine(trimmed)) return;
      stdout.write(line + "\n");
      if (trimmed.startsWith("{")) {
        const parsed = parseResultLine(trimmed);
        if (parsed) lastResult = parsed;
      }
    };

    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) flushLine(line);
      });
      child.stdout.on("end", () => {
        if (buffer) flushLine(buffer);
      });
    }

    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      if (stderr) {
        child.stderr.on("data", (chunk: string) => stderr.write(chunk));
      } else {
        child.stderr.resume();
      }
    }

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      resolve({
        exitCode: code,
        cost: lastResult?.cost ?? null,
        sessionId: lastResult?.sessionId ?? null,
      });
    });

    try {
      if (child.stdin) {
        child.stdin.write(prompt);
        child.stdin.end();
      }
    } catch (err) {
      if (settled) return;
      settled = true;
      reject(err as Error);
    }
  });
}

/**
 * Per-turn stream-json proxy. Reads user turns from stdin, classifies each,
 * spawns claude --print --resume per turn, forwards streaming output to stdout.
 * Session continuity is maintained via --session-id + --resume across all turns.
 */
export async function runStreamJsonProxy(opts: StreamJsonProxyOptions): Promise<number> {
  const { realClaude, claudeArgs, pipeline, profile, userConfig, telemetry, stdin, stdout, stderr } = opts;
  const spawnTurn = opts.spawnTurn ?? streamClaudeForTurn;

  let sessionId = extractSessionId(claudeArgs);
  let isFirstTurn = true;
  let exitCode = 0;

  const rl = readline.createInterface({ input: stdin, crlfDelay: Infinity });
  const lines = rl[Symbol.asyncIterator]() as AsyncIterator<string>;

  try {
    while (true) {
      const turn = await readNextUserTurn(lines);
      if (turn === null) break;

      if (sessionId === null && turn.sessionId !== null) {
        sessionId = turn.sessionId;
      }

      const t0 = Date.now();
      // Slash commands (/model, /compact, /clear, etc.) are interactive-session
      // directives handled by the extension UI. They should not be classified
      // by the pipeline (a short token like "/model haiku" would likely misroute
      // to Haiku). Route at standard class without touching any classifier.
      const decision: Decision = isSlashPrefix(turn.promptText)
        ? {
            class: "standard",
            classifier: "passthrough",
            confidence: 1.0,
            spec: profile.classes.standard,
            latencyMs: 0,
            diagnostics: [],
          }
        : await pipeline.route({ prompt: turn.promptText });

      const args = buildTurnArgs(
        claudeArgs,
        decision,
        sessionId,
        isFirstTurn,
        false,
        userConfig.excludeDynamicSections,
      );

      const result = await spawnTurn(realClaude, args, turn.promptText, stdout, isFirstTurn, stderr);

      // Capture session ID from turn 1 output when it was not in the original args.
      if (result.sessionId !== null && sessionId === null) {
        sessionId = result.sessionId;
      }

      try {
        await telemetry.log({
          type: "decision",
          ts: new Date().toISOString(),
          decision: { ...decision, latencyMs: Date.now() - t0 },
          ...(result.cost ? { cost: result.cost } : {}),
          prompt: truncate(turn.promptText, PROMPT_TRUNCATE_CHARS),
        });
      } catch { /* never blocks routing */ }

      isFirstTurn = false;
      exitCode = result.exitCode ?? 0;
    }
  } finally {
    rl.close();
  }

  return exitCode;
}
