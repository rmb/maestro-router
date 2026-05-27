// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0
//
// Human-facing SDK host for `maestro shell`. Terminal-side counterpart of the
// VSCode panel: speaks the Claude Code stream-json control protocol to drive a
// real `claude` subprocess interactively, routing every turn through runSdkProxy
// (per-turn set_model injection, effort, first-turn guard, auto-compact,
// telemetry — all reused untouched).
//
// Topology:
//
//   readline(user) ──► hostToProxy (PassThrough) ──► runSdkProxy.stdin
//                                                       │
//                                                       ▼ (spawns real claude,
//                                                          injects set_model)
//   terminal      ◄── proxyToHost (PassThrough) ◄── runSdkProxy.stdout
//
// Handshake (verified against claude 2.1.112): the host sends an `initialize`
// control_request FIRST; claude replies with a `control_response` (request_id
// "sdk-host-1"), which is our gate to start prompting.
//
// Phase 2 features: interactive tool permission prompts (y/n/always per session),
// /why (last routing decision), /pin [model] (lock routing class), /status.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { PassThrough } from "node:stream";
import type { Readable, Writable } from "node:stream";
import { runSdkProxy } from "./sdk-proxy.js";
import type { SdkProxySpawn } from "./sdk-proxy.js";
import { KNOWN_SLASH_COMMANDS } from "./passthrough.js";
import { parseFrame, extractRateLimitInfo } from "./stream-json-frames.js";
import type { Frame } from "./stream-json-frames.js";
import { computeOpusBaseline, computeTurnCost, modelAlias } from "../core/pricing.js";
import type { Pipeline } from "../core/pipeline.js";
import type { Decision, Profile, UserConfig, Class } from "../core/types.js";
import type { TelemetryWriter } from "../core/telemetry.js";
import type { SessionStore } from "./session.js";

export const HOST_INIT_REQUEST_ID = "sdk-host-1";

export type ShellHostOptions = {
  realClaude: string;
  /** Full claude args incl. --print --input-format/--output-format stream-json --verbose --model --session-id [--resume]. */
  claudeArgs: ReadonlyArray<string>;
  pipeline: Pipeline;
  profile: Profile;
  userConfig: UserConfig;
  telemetry: TelemetryWriter;
  /** User keystroke source (process.stdin in production). */
  input: Readable;
  /** Terminal sink (process.stdout in production). */
  output: Writable;
  /** Diagnostics sink (process.stderr); defaults to output. */
  errput?: Writable;
  /** Injectable spawn forwarded to runSdkProxy — tests pass a fake claude. */
  spawn?: SdkProxySpawn;
  sessions?: SessionStore;
  sessionId?: string;
  recentClasses?: string[];
  /** Emit ANSI color. Defaults to output.isTTY. */
  color?: boolean;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
};

type Usage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  haiku: "\x1b[32m", // green
  sonnet: "\x1b[36m", // cyan
  opus: "\x1b[35m", // magenta
} as const;

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function badgeColor(alias: "haiku" | "sonnet" | "opus"): string {
  return COLORS[alias];
}

/** Pull concatenated text from an assistant message frame's content blocks. */
function assistantText(frame: Frame): string {
  const message = frame["message"];
  if (typeof message !== "object" || message === null) return "";
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const b of content) {
    if (
      typeof b === "object" &&
      b !== null &&
      (b as { type?: unknown }).type === "text" &&
      typeof (b as { text?: unknown }).text === "string"
    ) {
      out += (b as { text: string }).text;
    }
  }
  return out;
}

/** Concatenated thinking content from an assistant frame's thinking blocks. */
function assistantThinking(frame: Frame): string {
  const message = frame["message"];
  if (typeof message !== "object" || message === null) return "";
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const b of content) {
    if (
      typeof b === "object" &&
      b !== null &&
      (b as { type?: unknown }).type === "thinking" &&
      typeof (b as { thinking?: unknown }).thinking === "string"
    ) {
      out += (b as { thinking: string }).thinking;
    }
  }
  return out;
}

/** Model id from an assistant frame, e.g. "claude-haiku-4-5-20251001". */
function assistantModel(frame: Frame): string | null {
  const message = frame["message"];
  if (typeof message !== "object" || message === null) return null;
  const model = (message as { model?: unknown }).model;
  return typeof model === "string" ? model : null;
}

function usageFrom(frame: Frame): Usage | null {
  const u = frame["usage"];
  if (typeof u === "object" && u !== null) return u as Usage;
  return null;
}

/**
 * Extract request_id and tool_name from a can_use_tool control_request.
 * Returns null for any other frame type.
 */
function canUseToolInfo(frame: Frame): { reqId: string; toolName: string } | null {
  if (frame["type"] !== "control_request") return null;
  const req = frame["request"];
  if (typeof req !== "object" || req === null) return null;
  if ((req as { subtype?: unknown }).subtype !== "can_use_tool") return null;
  const reqId =
    typeof frame["request_id"] === "string" ? frame["request_id"] : `host-tool-${Date.now()}`;
  const toolName =
    typeof (req as { tool_name?: unknown }).tool_name === "string"
      ? (req as { tool_name: string }).tool_name
      : "unknown";
  return { reqId, toolName };
}

function controlResponseId(frame: Frame): string | null {
  if (frame["type"] !== "control_response") return null;
  const response = frame["response"];
  if (typeof response !== "object" || response === null) return null;
  const id = (response as { request_id?: unknown }).request_id;
  return typeof id === "string" ? id : null;
}

/** Enumerate slash-completions from skills, plugin skills, custom commands, and built-ins. */
async function loadCompletions(): Promise<string[]> {
  const home = process.env["HOME"] ?? "";
  const seen = new Set<string>();
  const add = (s: string): void => { seen.add(s); };

  ["/exit", "/quit", "/help", "/why", "/status", "/pin"].forEach(add);
  KNOWN_SLASH_COMMANDS.forEach(add);

  try {
    const entries = await readdir(path.join(home, ".claude", "skills"), { withFileTypes: true });
    for (const e of entries) {
      if (!e.name.startsWith(".") && e.name !== "README.md") add("/" + e.name);
    }
  } catch { /* no skills dir */ }

  try {
    const raw = await readFile(path.join(home, ".claude", "plugins", "installed_plugins.json"), "utf8");
    const data = JSON.parse(raw) as { plugins?: Record<string, Array<{ installPath: string }>> };
    for (const [key, installs] of Object.entries(data.plugins ?? {})) {
      const name = key.split("@")[0] ?? key;
      for (const install of installs) {
        try {
          const subs = await readdir(path.join(install.installPath, "skills"), { withFileTypes: true });
          for (const s of subs) { if (s.isDirectory()) add(`/${name}:${s.name}`); }
        } catch { /* plugin has no skills/ */ }
      }
    }
  } catch { /* no plugins.json */ }

  try {
    const entries = await readdir(path.join(home, ".claude", "commands"), { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith(".md")) add("/" + e.name.slice(0, -3));
    }
  } catch { /* no commands dir */ }

  return [...seen].sort();
}

function makeCompleter(completions: string[]): (line: string) => [string[], string] {
  const overrides = ["@fast ", "@think ", "@deep ", "@fast+context "];
  return function completer(line: string): [string[], string] {
    const words = line.split(/\s+/);
    const last = words[words.length - 1] ?? "";
    if (last.startsWith("/")) {
      const hits = completions.filter((c) => c.startsWith(last));
      return [hits, last];
    }
    if (line.startsWith("@") && !line.includes(" ")) {
      const hits = overrides.filter((o) => o.startsWith(line));
      return [hits.length ? hits : overrides, line];
    }
    return [[], line];
  };
}

/** Compute the dim ghost suffix to show after the cursor, or null if no suggestion. */
function computeGhost(line: string, completions: string[]): string | null {
  const overrides = ["@fast", "@think", "@deep", "@fast+context"];
  const words = line.split(/\s+/);
  const last = words[words.length - 1] ?? "";
  if (last.startsWith("/") && last.length >= 2) {
    const hits = completions.filter((c) => c.startsWith(last));
    if (hits.length > 0 && hits[0] !== last) return hits[0]!.slice(last.length);
  }
  if (line.startsWith("@") && !line.includes(" ") && line.length >= 2) {
    const hits = overrides.filter((o) => o.startsWith(line));
    if (hits.length > 0 && hits[0] !== line) return hits[0]!.slice(line.length);
  }
  return null;
}

/**
 * Patches rl._refreshLine to append a dim ghost-text suggestion after the
 * cursor whenever the current word is a unique-prefix match. The cursor is
 * moved back so the user types over the ghost. Only active when isTTY + color.
 */
function installGhostText(
  rl: readline.Interface,
  completions: string[],
  output: Writable,
): void {
  type RlInternal = { _refreshLine(): void; line: string; cursor: number };
  const iface = rl as unknown as RlInternal;
  const orig = iface._refreshLine.bind(rl);
  iface._refreshLine = function refreshWithGhost(): void {
    orig();
    // Only show ghost when cursor is at end of line.
    if (iface.cursor !== iface.line.length) return;
    const ghost = computeGhost(iface.line, completions);
    if (ghost && ghost.length > 0) {
      // Write dim ghost, then move cursor left back past it.
      output.write(`\x1b[2m${ghost}\x1b[0m\x1b[${ghost.length}D`);
    }
  };
}

/**
 * Run the interactive shell host. Resolves with the child's exit code once
 * the user exits (/exit, EOF) and the proxy/claude subprocess terminates.
 */
export async function runShellHost(opts: ShellHostOptions): Promise<number> {
  const errput = opts.errput ?? opts.output;
  const now = opts.now ?? Date.now;
  const useColor =
    opts.color ?? (opts.output as { isTTY?: boolean }).isTTY === true;
  const paint = (s: string, code: string): string =>
    useColor ? `${code}${s}${COLORS.reset}` : s;
  const isTTY = (opts.input as { isTTY?: boolean }).isTTY === true;
  const completionList = isTTY ? await loadCompletions() : [];
  const completer = isTTY ? makeCompleter(completionList) : undefined;

  // Streams bridging the host (here) and runSdkProxy.
  const hostToProxy = new PassThrough();
  const proxyToHost = new PassThrough();
  const proxyErr = new PassThrough();

  // Forward proxy diagnostics (first-turn guard, rate-limit, compact) dimmed.
  proxyErr.setEncoding("utf8");
  proxyErr.on("data", (chunk: string) => {
    errput.write(useColor ? paint(chunk, COLORS.dim) : chunk);
  });

  // Per-turn state.
  let turnModel: string | null = null;
  let turnStart = 0;
  let inTurn = false;
  let handshakeDone = false;
  let turnOutputStarted = false;
  // Lines typed/piped before the handshake or mid-turn are queued, then drained
  // one turn at a time. Prevents dropped input on fast typing, paste, or pipes.
  const inputQueue: string[] = [];

  // Phase 2 routing state.
  let lastDecision: Decision | null = null;
  let pinnedClass: Class | null = null;
  const allowedTools = new Set<string>();
  let pendingApproval: {
    reqId: string;
    toolName: string;
    resolve: (allow: boolean) => void;
  } | null = null;

  // Pipeline wrapper: captures lastDecision for /why and enforces /pin override.
  const routingPipeline: Pipeline = {
    route: async (req, ctx) => {
      if (pinnedClass !== null) {
        const spec = opts.profile.classes[pinnedClass];
        if (spec) {
          const d: Decision = {
            class: pinnedClass,
            classifier: "pin",
            confidence: 1.0,
            spec,
            latencyMs: 0,
            diagnostics: [],
          };
          lastDecision = d;
          return d;
        }
      }
      const d = await opts.pipeline.route(req, ctx);
      lastDecision = d;
      return d;
    },
  };

  // Spinner — runs between prompt submission and first streamed content.
  let spinnerTimer: ReturnType<typeof setInterval> | null = null;
  let spinnerIdx = 0;
  function startSpinner(): void {
    if (!useColor) return;
    spinnerIdx = 0;
    spinnerTimer = setInterval(() => {
      opts.output.write(`\r${paint(SPINNER[spinnerIdx % SPINNER.length]! + " thinking…", COLORS.dim)}`);
      spinnerIdx++;
    }, 100);
  }
  function clearSpinner(): void {
    if (spinnerTimer) { clearInterval(spinnerTimer); spinnerTimer = null; }
    if (useColor) opts.output.write("\r\x1b[K");
  }

  // Cumulative session economics (token-derived; never total_cost_usd).
  let sessionCost = 0;
  let sessionBaseline = 0;
  let turns = 0;

  const rl = readline.createInterface({
    input: opts.input,
    output: opts.output,
    prompt: paint("> ", COLORS.dim),
    terminal: isTTY,
    ...(completer ? { completer } : {}),
  });

  if (isTTY && useColor && completionList.length > 0) {
    installGhostText(rl, completionList, opts.output);
  }

  function writeUserFrame(text: string): void {
    const frame = {
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
    };
    hostToProxy.write(JSON.stringify(frame) + "\n");
  }

  function renderHud(usage: Usage, durationMs: number): void {
    const model = turnModel ?? "claude-sonnet";
    const alias = modelAlias(model);
    const inTok = usage.input_tokens ?? 0;
    const outTok = usage.output_tokens ?? 0;
    const ccTok = usage.cache_creation_input_tokens ?? 0;
    const crTok = usage.cache_read_input_tokens ?? 0;
    const cost = computeTurnCost(model, inTok, outTok, ccTok, crTok, false);
    const baseline = computeOpusBaseline(inTok, outTok, ccTok, crTok, 0, 0, 0);
    sessionCost += cost;
    sessionBaseline += baseline;
    turns += 1;
    const savedPct = baseline > 0 ? Math.round((1 - cost / baseline) * 100) : 0;
    const secs = (durationMs / 1000).toFixed(1);
    const badge =
      `[${alias} · ${secs}s · $${cost.toFixed(4)} · saved ${savedPct}%]`;
    const sessTotal =
      sessionBaseline > 0
        ? ` ${paint(
            `(session: $${sessionCost.toFixed(4)} vs $${sessionBaseline.toFixed(4)} all-Opus · ${Math.round((1 - sessionCost / sessionBaseline) * 100)}% saved over ${turns} turns)`,
            COLORS.dim,
          )}`
        : "";
    opts.output.write(paint(badge, badgeColor(alias)) + sessTotal + "\n");
  }

  // ── Lifecycle. On input EOF we stop prompting but let any in-flight turn
  // and already-queued lines drain before ending the proxy's stdin.
  let inputEnded = false;
  let proxyEnded = false;
  const endProxy = (): void => {
    if (proxyEnded) return;
    proxyEnded = true;
    hostToProxy.end();
  };
  const safePrompt = (): void => {
    if (!inputEnded) rl.prompt();
  };
  const maybeFinish = (): void => {
    if (inputEnded && !inTurn && inputQueue.length === 0) endProxy();
  };

  // ── Read frames coming back from the proxy/claude.
  let buf = "";
  proxyToHost.setEncoding("utf8");
  proxyToHost.on("data", (chunk: string) => {
    buf += chunk;
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const frame = parseFrame(line);
      if (frame === null) continue;

      // Handshake gate: our init control_response.
      if (!handshakeDone && controlResponseId(frame) === HOST_INIT_REQUEST_ID) {
        handshakeDone = true;
        const tabHint = completionList.length > 0 ? ` · tab-complete /skills (${completionList.length})` : "";
        opts.output.write(
          paint(`routing: auto · type /exit to quit, /help for commands${tabHint}\n`, COLORS.dim),
        );
        safePrompt();
        pump();
        continue;
      }

      // Phase 2: interactive tool-use permission prompt.
      const toolInfo = canUseToolInfo(frame);
      if (toolInfo !== null) {
        // Already approved for the session — silently allow.
        if (allowedTools.has(toolInfo.toolName)) {
          hostToProxy.write(
            JSON.stringify({
              type: "control_response",
              response: {
                request_id: toolInfo.reqId,
                subtype: "success",
                response: { behavior: "allow" },
              },
            }) + "\n",
          );
          continue;
        }
        // Ask the user.
        clearSpinner();
        opts.output.write(
          paint(`\nallow tool "${toolInfo.toolName}"? [y/n/always] `, COLORS.dim),
        );
        pendingApproval = {
          reqId: toolInfo.reqId,
          toolName: toolInfo.toolName,
          resolve: (allow) => {
            hostToProxy.write(
              JSON.stringify({
                type: "control_response",
                response: {
                  request_id: toolInfo.reqId,
                  subtype: "success",
                  response: { behavior: allow ? "allow" : "deny" },
                },
              }) + "\n",
            );
          },
        };
        continue;
      }

      if (frame["type"] === "assistant") {
        const model = assistantModel(frame);
        if (model) turnModel = model;
        const thinking = assistantThinking(frame);
        if (thinking) {
          clearSpinner();
          turnOutputStarted = true;
          const approxTokens = Math.round(thinking.length / 4);
          opts.output.write(paint(`\n  ▸ thinking (≈${approxTokens} tokens)\n\n`, COLORS.dim));
        }
        const text = assistantText(frame);
        if (text) {
          clearSpinner();
          turnOutputStarted = true;
          opts.output.write(text);
        }
        continue;
      }

      if (frame["type"] === "result") {
        clearSpinner();
        const usage = usageFrom(frame) ?? {};
        const frameDur = frame["duration_ms"];
        const durationMs = typeof frameDur === "number" ? frameDur : now() - turnStart;
        // Close the streamed text line, then a blank separator before the HUD.
        opts.output.write(turnOutputStarted ? "\n\n" : "\n");
        renderHud(usage, durationMs);
        turnOutputStarted = false;
        inTurn = false;
        safePrompt();
        pump();
        maybeFinish();
        continue;
      }

      if (frame["type"] === "rate_limit_event") {
        const info = extractRateLimitInfo(frame);
        if (info) {
          const resetsAt = new Date(info.resetsAt).toLocaleTimeString();
          errput.write(paint(`maestro: rate limited (${info.rateLimitType}) — resets at ${resetsAt}\n`, COLORS.dim));
        }
        continue;
      }

      // system/init, control_request passthrough, etc.: ignore.
    }
  });

  // ── User input loop. Lines are queued and drained one turn at a time so a
  // turn in flight never races the next prompt (and piped input works).
  // A pending tool approval intercepts the next line before the queue.
  function pump(): void {
    if (!handshakeDone || inTurn) return;
    const raw = inputQueue.shift();
    if (raw === undefined) return;
    const text = raw.trim();

    if (text.length === 0) {
      safePrompt();
      pump();
      return;
    }
    if (text === "/exit" || text === "/quit") {
      inputEnded = true;
      inputQueue.length = 0;
      endProxy();
      return;
    }
    if (text === "/help") {
      opts.output.write(
        paint(
          "commands: /exit quit · /help this list · /why last route · /pin [model|off] pin routing · /status session\n",
          COLORS.dim,
        ),
      );
      safePrompt();
      pump();
      return;
    }

    if (text === "/why") {
      if (lastDecision) {
        const alias = modelAlias(opts.profile.classes[lastDecision.class]?.model ?? "unknown");
        opts.output.write(
          paint(
            `last route: ${lastDecision.class} via ${lastDecision.classifier} (${Math.round(lastDecision.confidence * 100)}% conf, ${lastDecision.latencyMs}ms) → ${alias}\n`,
            COLORS.dim,
          ),
        );
      } else {
        opts.output.write(paint("no routing decisions yet this session\n", COLORS.dim));
      }
      safePrompt();
      pump();
      return;
    }

    if (text.startsWith("/pin")) {
      const arg = text.slice(4).trim().toLowerCase();
      if (arg === "off" || arg === "unpin") {
        pinnedClass = null;
        opts.output.write(paint("unpinned: routing is auto\n", COLORS.dim));
      } else if (arg === "" || arg === "current") {
        if (lastDecision) {
          pinnedClass = lastDecision.class;
          const alias = modelAlias(opts.profile.classes[pinnedClass]?.model ?? "unknown");
          opts.output.write(paint(`pinned: ${pinnedClass} → ${alias}\n`, COLORS.dim));
        } else {
          opts.output.write(
            paint("no turns yet — try /pin haiku, /pin sonnet, or /pin opus\n", COLORS.dim),
          );
        }
      } else if (arg === "haiku" || arg === "h") {
        pinnedClass = "trivial";
        opts.output.write(paint("pinned: trivial → haiku\n", COLORS.dim));
      } else if (arg === "sonnet" || arg === "s") {
        pinnedClass = "standard";
        opts.output.write(paint("pinned: standard → sonnet\n", COLORS.dim));
      } else if (arg === "opus" || arg === "o") {
        pinnedClass = "hard";
        opts.output.write(paint("pinned: hard → opus\n", COLORS.dim));
      } else {
        opts.output.write(
          paint(`unknown: "${arg}" — try haiku, sonnet, opus, off\n`, COLORS.dim),
        );
      }
      safePrompt();
      pump();
      return;
    }

    if (text === "/status") {
      const pinStr = pinnedClass
        ? `pinned: ${pinnedClass} → ${modelAlias(opts.profile.classes[pinnedClass]?.model ?? "unknown")}`
        : "routing: auto";
      const costStr =
        turns > 0
          ? `$${sessionCost.toFixed(4)} vs $${sessionBaseline.toFixed(4)} all-Opus · ${Math.round((1 - sessionCost / sessionBaseline) * 100)}% saved · ${turns} turn${turns === 1 ? "" : "s"}`
          : "no turns yet";
      opts.output.write(paint(`${pinStr} · ${costStr}\n`, COLORS.dim));
      safePrompt();
      pump();
      return;
    }

    // Real prompt: hand to the proxy. It classifies + injects set_model.
    inTurn = true;
    turnModel = null;
    turnOutputStarted = false;
    turnStart = now();
    writeUserFrame(text);
    startSpinner();
  }

  rl.on("line", (raw) => {
    // Tool approval intercept: the pending approval consumes the next line.
    if (pendingApproval) {
      const ans = raw.trim().toLowerCase();
      const allow = ans === "y" || ans === "yes" || ans === "always";
      if (ans === "always") allowedTools.add(pendingApproval.toolName);
      pendingApproval.resolve(allow);
      pendingApproval = null;
      // Resume spinner since the turn is still in flight.
      if (inTurn) startSpinner();
      return;
    }
    inputQueue.push(raw);
    pump();
  });

  // Input EOF (pipe end or Ctrl-D): stop prompting, drain, then end the proxy.
  rl.on("close", () => {
    inputEnded = true;
    maybeFinish();
  });

  // ── Launch the proxy. It owns the real claude subprocess.
  const proxyDone = runSdkProxy({
    realClaude: opts.realClaude,
    claudeArgs: opts.claudeArgs,
    pipeline: routingPipeline,
    profile: opts.profile,
    userConfig: opts.userConfig,
    telemetry: opts.telemetry,
    stdin: hostToProxy,
    stdout: proxyToHost,
    stderr: proxyErr,
    ...(opts.spawn ? { spawn: opts.spawn } : {}),
    ...(opts.sessions ? { sessions: opts.sessions } : {}),
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    ...(opts.recentClasses ? { recentClasses: opts.recentClasses } : {}),
  });

  // Send the initialize control_request FIRST — claude waits for it before
  // emitting system/init (verified against claude 2.1.112).
  const initReq = {
    type: "control_request",
    request_id: HOST_INIT_REQUEST_ID,
    request: { subtype: "initialize", hooks: {}, sdkMcpServers: [] },
  };
  hostToProxy.write(JSON.stringify(initReq) + "\n");

  return await proxyDone;
}
