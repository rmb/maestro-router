# SDK-aware stream-json proxy (per-turn routing in VSCode panel) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Maestro classify and route every VSCode-panel prompt to the cheapest model+effort without breaking the panel — by speaking the Claude SDK control protocol instead of treating stdin as a flat user-message queue.

**Architecture:** Spawn ONE long-running real-claude subprocess for the whole session. Wrap its stdin/stdout. On stdin, intercept ONLY user messages — classify each, inject a `{subtype:"set_model"}` control request just before the user message, then forward. On stdout, pass everything through except control-responses to our injected requests (filter by request_id prefix `maestro-`). Control protocol traffic (initialize, MCP, hooks, etc.) passes through unchanged.

**Tech Stack:** Node ≥ 20, TypeScript strict (ESM, verbatimModuleSyntax, exactOptionalPropertyTypes), vitest, `node:child_process.spawn`, `node:readline`. Zero new runtime deps.

---

## Why the previous approaches failed

| Attempt | Mode | Failure |
|---------|------|---------|
| Per-turn proxy (`runStreamJsonProxy`) | spawn `claude --print --resume` per user turn | Drops SDK control frames (`initialize`, `set_model`, MCP), VSCode never gets `initialize_response`, fires 60s timeout |
| Passthrough (commit `704f9a7`) | exec real claude with original args | Works but **no per-turn routing** — VSCode panel can't get cost savings |
| Synthetic init line | pre-emit `{type:"system","subtype":"init"}` | Irrelevant — VSCode waits for SDK control_response, not stdout-init parsing |

## Why this approach works

Insight from decompiling `~/.vscode/extensions/anthropic.claude-code-*/extension.js`:

- VSCode SDK speaks bidirectional control protocol over stdin/stdout (request/response with `request_id`).
- The SDK exposes `setModel(z)` which sends `{subtype:"set_model", model:z}` and awaits the matching response. **This means model can be changed mid-session via control frame.**
- Per-turn routing then becomes: classify → inject `set_model` → forward user message. Real claude handles everything else.

## File Structure

**New files (single responsibility each):**

- `src/wrapper/stream-json-frames.ts` — stream-json line parsing + frame type detection (pure). NO i/o.
- `src/wrapper/stream-json-frames.test.ts` — unit tests for frame detection.
- `src/wrapper/sdk-proxy.ts` — the SDK-aware proxy: spawn claude, run stdin filter, run stdout filter, manage telemetry. Depends on stream-json-frames.
- `src/wrapper/sdk-proxy.test.ts` — integration tests with a fake spawn.

**Files modified:**

- `src/cli/wire-compat.ts` — replace the stream-json branch (currently passthrough) with a call to `runSdkProxy`. Remove the `MAESTRO_STREAM_JSON_PROXY=1` opt-in (it gated a now-removed broken mode).
- `src/wrapper/stream-json-proxy.ts` — DELETE. The per-turn proxy is gone; nothing imports it after the wire-compat change.
- `src/wrapper/stream-json-proxy.test.ts` — DELETE alongside the source.

**File responsibilities:**

- `stream-json-frames.ts` knows the protocol shape and nothing else. Pure functions: `parseFrame(line) → Frame | null`, `isUserMessage(frame)`, `isControlRequest(frame)`, `extractPromptText(userFrame)`, etc.
- `sdk-proxy.ts` knows the i/o lifecycle: spawn child, pipe streams, route lines through the frames module, talk to the pipeline + telemetry.
- `wire-compat.ts` keeps the args/binary detection and selects the proxy mode.

---

## Task 1: Stream-json frame parser

**Files:**
- Create: `src/wrapper/stream-json-frames.ts`
- Test: `src/wrapper/stream-json-frames.test.ts`

- [ ] **Step 1: Write failing tests for frame parsing**

```typescript
// src/wrapper/stream-json-frames.test.ts
// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import {
  parseFrame,
  isUserTextMessage,
  isControlRequest,
  extractPromptText,
  buildSetModelRequest,
  matchesInjectedRequestId,
  MAESTRO_REQUEST_ID_PREFIX,
} from "./stream-json-frames.js";

describe("parseFrame", () => {
  test("returns null on non-JSON lines", () => {
    expect(parseFrame("")).toBeNull();
    expect(parseFrame("   ")).toBeNull();
    expect(parseFrame("not json")).toBeNull();
    expect(parseFrame("{broken")).toBeNull();
  });

  test("parses valid JSON object", () => {
    const f = parseFrame('{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}');
    expect(f).not.toBeNull();
    expect(f?.type).toBe("user");
  });

  test("returns null for JSON arrays / primitives", () => {
    expect(parseFrame("[]")).toBeNull();
    expect(parseFrame('"string"')).toBeNull();
    expect(parseFrame("42")).toBeNull();
  });
});

describe("isUserTextMessage", () => {
  test("recognizes well-formed user text frame", () => {
    const f = parseFrame('{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}')!;
    expect(isUserTextMessage(f)).toBe(true);
  });

  test("rejects user frames whose content is only a tool_result", () => {
    const f = parseFrame('{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"x","content":"ok"}]}}')!;
    expect(isUserTextMessage(f)).toBe(false);
  });

  test("rejects non-user frames", () => {
    const f = parseFrame('{"type":"assistant","message":{}}')!;
    expect(isUserTextMessage(f)).toBe(false);
  });
});

describe("isControlRequest", () => {
  test("recognizes a control_request frame", () => {
    const f = parseFrame('{"type":"control_request","request_id":"r1","request":{"subtype":"initialize"}}')!;
    expect(isControlRequest(f)).toBe(true);
  });

  test("rejects user and assistant frames", () => {
    const f1 = parseFrame('{"type":"user","message":{"role":"user","content":[]}}')!;
    const f2 = parseFrame('{"type":"assistant","message":{}}')!;
    expect(isControlRequest(f1)).toBe(false);
    expect(isControlRequest(f2)).toBe(false);
  });
});

describe("extractPromptText", () => {
  test("returns the first text block content", () => {
    const f = parseFrame('{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hello world"}]}}')!;
    expect(extractPromptText(f)).toBe("hello world");
  });

  test("returns the text even when other content blocks precede", () => {
    const f = parseFrame('{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"x","content":"ok"},{"type":"text","text":"second"}]}}')!;
    expect(extractPromptText(f)).toBe("second");
  });

  test("returns null when no text block exists", () => {
    const f = parseFrame('{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"x","content":"ok"}]}}')!;
    expect(extractPromptText(f)).toBeNull();
  });
});

describe("buildSetModelRequest", () => {
  test("emits a control_request with maestro-prefixed request_id", () => {
    const r = buildSetModelRequest("haiku", 7);
    expect(r.type).toBe("control_request");
    expect(r.request_id.startsWith(MAESTRO_REQUEST_ID_PREFIX)).toBe(true);
    expect(r.request.subtype).toBe("set_model");
    expect(r.request.model).toBe("haiku");
  });

  test("each call produces a unique request_id", () => {
    const a = buildSetModelRequest("haiku", 1);
    const b = buildSetModelRequest("haiku", 2);
    expect(a.request_id).not.toBe(b.request_id);
  });
});

describe("matchesInjectedRequestId", () => {
  test("true when control_response request_id has the maestro prefix", () => {
    const f = parseFrame(`{"type":"control_response","response":{"request_id":"${MAESTRO_REQUEST_ID_PREFIX}5","subtype":"success"}}`)!;
    expect(matchesInjectedRequestId(f)).toBe(true);
  });

  test("false when control_response request_id is from the SDK host", () => {
    const f = parseFrame('{"type":"control_response","response":{"request_id":"sdk-host-id","subtype":"success"}}')!;
    expect(matchesInjectedRequestId(f)).toBe(false);
  });

  test("false for non-control-response frames", () => {
    const f = parseFrame('{"type":"user","message":{"role":"user","content":[{"type":"text","text":"x"}]}}')!;
    expect(matchesInjectedRequestId(f)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm vitest run src/wrapper/stream-json-frames.test.ts`

Expected: every test FAILs (module doesn't exist).

- [ ] **Step 3: Implement the frames module**

```typescript
// src/wrapper/stream-json-frames.ts
// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0
//
// Pure stream-json frame parsing for the SDK-aware proxy. No i/o — just
// JSON shape detection. The proxy uses these to decide which lines to
// classify, which to inject around, and which to filter from output.

export const MAESTRO_REQUEST_ID_PREFIX = "maestro-";

export type Frame = Record<string, unknown> & { type?: string };

export type SetModelRequest = {
  type: "control_request";
  request_id: string;
  request: { subtype: "set_model"; model: string };
};

/** Parse a single line as a JSON object frame. Returns null on garbage. */
export function parseFrame(line: string): Frame | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const obj = JSON.parse(trimmed) as unknown;
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return null;
    return obj as Frame;
  } catch {
    return null;
  }
}

/** A user-role message whose content array contains at least one text block. */
export function isUserTextMessage(frame: Frame): boolean {
  if (frame.type !== "user") return false;
  const message = frame.message;
  if (typeof message !== "object" || message === null) return false;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return false;
  return content.some(
    (b) =>
      typeof b === "object" &&
      b !== null &&
      (b as { type?: unknown }).type === "text" &&
      typeof (b as { text?: unknown }).text === "string",
  );
}

export function isControlRequest(frame: Frame): boolean {
  return frame.type === "control_request";
}

export function isControlResponse(frame: Frame): boolean {
  return frame.type === "control_response";
}

/** Pull the first text block from a user message. Caller pre-checks isUserTextMessage. */
export function extractPromptText(frame: Frame): string | null {
  const content = (frame.message as { content?: unknown })?.content;
  if (!Array.isArray(content)) return null;
  for (const b of content) {
    if (
      typeof b === "object" &&
      b !== null &&
      (b as { type?: unknown }).type === "text" &&
      typeof (b as { text?: unknown }).text === "string"
    ) {
      return (b as { text: string }).text;
    }
  }
  return null;
}

/** Build a set_model control_request with a maestro-prefixed id. */
export function buildSetModelRequest(model: string, seq: number): SetModelRequest {
  return {
    type: "control_request",
    request_id: `${MAESTRO_REQUEST_ID_PREFIX}${seq}`,
    request: { subtype: "set_model", model },
  };
}

/** True when a control_response is responding to one of our injected requests. */
export function matchesInjectedRequestId(frame: Frame): boolean {
  if (frame.type !== "control_response") return false;
  const response = frame.response;
  if (typeof response !== "object" || response === null) return false;
  const id = (response as { request_id?: unknown }).request_id;
  return typeof id === "string" && id.startsWith(MAESTRO_REQUEST_ID_PREFIX);
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm vitest run src/wrapper/stream-json-frames.test.ts`

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/wrapper/stream-json-frames.ts src/wrapper/stream-json-frames.test.ts
git commit -m "wrapper: stream-json frame parser for SDK control protocol

Pure module — parses lines, identifies user-text vs control frames,
extracts prompt text, builds maestro-tagged set_model requests, and
detects responses to our injected requests so we can filter them out
of the VSCode-facing stdout.

Single-responsibility precursor to the SDK-aware proxy (next commit).
Zero i/o, no deps.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: SDK-aware proxy — happy path (user message routing)

**Files:**
- Create: `src/wrapper/sdk-proxy.ts`
- Test: `src/wrapper/sdk-proxy.test.ts`

- [ ] **Step 1: Write failing test for routing a single user turn**

```typescript
// src/wrapper/sdk-proxy.test.ts
// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, expect, test, vi } from "vitest";
import { Readable, Writable } from "node:stream";
import { balancedProfile } from "../core/profile.js";
import type { Decision, Pipeline, TelemetryEvent } from "../core/types.js";
import type { TelemetryWriter } from "../core/telemetry.js";
import { runSdkProxy, type SdkProxySpawn } from "./sdk-proxy.js";
import { MAESTRO_REQUEST_ID_PREFIX } from "./stream-json-frames.js";

function collectorStream(): { stream: Writable; lines: string[] } {
  const lines: string[] = [];
  let buf = "";
  const stream = new Writable({
    write(chunk, _enc, cb) {
      buf += chunk.toString();
      const parts = buf.split("\n");
      buf = parts.pop() ?? "";
      for (const p of parts) lines.push(p);
      cb();
    },
  });
  return { stream, lines };
}

function decisionFor(cls: "trivial" | "standard"): Decision {
  return {
    class: cls,
    classifier: "test",
    confidence: 1.0,
    spec: balancedProfile.classes[cls],
    latencyMs: 0,
    diagnostics: [],
  };
}

const mockPipeline = (cls: "trivial" | "standard" = "trivial"): Pipeline => ({
  route: async () => decisionFor(cls),
});

const mockTelemetry = (): { writer: TelemetryWriter; events: TelemetryEvent[] } => {
  const events: TelemetryEvent[] = [];
  return {
    events,
    writer: {
      log: async (e) => { events.push(e); },
      readAll: async () => events,
    },
  };
};

/**
 * Fake child process: collects what's written to its stdin, emits scripted
 * lines on its stdout. Mirrors the subset of node:child_process.ChildProcess
 * shape that sdk-proxy uses.
 */
function fakeChild(scriptedOutput: string[]): {
  spawn: SdkProxySpawn;
  stdinWrites: string[];
  emit: (line: string) => void;
  close: (code: number) => void;
} {
  const stdinWrites: string[] = [];
  let stdoutListener: ((chunk: Buffer) => void) | null = null;
  let closeListener: ((code: number) => void) | null = null;

  const child = {
    stdin: {
      write: (s: string) => { stdinWrites.push(s); return true; },
      end: () => {},
    },
    stdout: {
      on: (ev: string, fn: (chunk: Buffer) => void) => { if (ev === "data") stdoutListener = fn; },
      setEncoding: () => {},
    },
    stderr: { on: () => {}, setEncoding: () => {}, pipe: () => {} },
    on: (ev: string, fn: (code: number) => void) => { if (ev === "close") closeListener = fn; },
    kill: () => {},
  };

  return {
    spawn: () => child as unknown as ReturnType<SdkProxySpawn>,
    stdinWrites,
    emit: (line: string) => {
      stdoutListener?.(Buffer.from(line + "\n"));
    },
    close: (code: number) => closeListener?.(code),
  };
}

describe("runSdkProxy — user message routing", () => {
  test("injects set_model control_request before forwarding the user message", async () => {
    const tel = mockTelemetry();
    const out = collectorStream();
    const stderr = collectorStream();

    const fc = fakeChild([]);
    const userLine =
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"format this file"}]}}';
    const stdin = Readable.from([userLine + "\n"]);

    // Schedule the child to close shortly after stdin ends.
    setTimeout(() => fc.close(0), 10);

    await runSdkProxy({
      realClaude: "node",
      claudeArgs: ["--input-format", "stream-json", "--output-format", "stream-json", "--print"],
      pipeline: mockPipeline("trivial"),
      profile: balancedProfile,
      userConfig: {},
      telemetry: tel.writer,
      stdin,
      stdout: out.stream,
      stderr: stderr.stream,
      spawn: fc.spawn,
    });

    // The proxy must have written the set_model request BEFORE the user message.
    expect(fc.stdinWrites.length).toBe(2);
    const setModel = JSON.parse(fc.stdinWrites[0]!.trim()) as {
      type: string;
      request_id: string;
      request: { subtype: string; model: string };
    };
    expect(setModel.type).toBe("control_request");
    expect(setModel.request.subtype).toBe("set_model");
    // trivial → haiku per balancedProfile
    expect(setModel.request.model).toBe("haiku");
    expect(setModel.request_id.startsWith(MAESTRO_REQUEST_ID_PREFIX)).toBe(true);

    const userForwarded = JSON.parse(fc.stdinWrites[1]!.trim()) as { type: string };
    expect(userForwarded.type).toBe("user");
  });

  test("logs a decision event per user turn including the prompt text", async () => {
    const tel = mockTelemetry();
    const out = collectorStream();
    const stderr = collectorStream();
    const fc = fakeChild([]);

    const stdin = Readable.from([
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}\n',
    ]);
    setTimeout(() => fc.close(0), 10);

    await runSdkProxy({
      realClaude: "node",
      claudeArgs: [],
      pipeline: mockPipeline("trivial"),
      profile: balancedProfile,
      userConfig: {},
      telemetry: tel.writer,
      stdin,
      stdout: out.stream,
      stderr: stderr.stream,
      spawn: fc.spawn,
    });

    expect(tel.events).toHaveLength(1);
    const e = tel.events[0]!;
    expect(e.type).toBe("decision");
    expect((e as { prompt?: string }).prompt).toBe("hello");
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm vitest run src/wrapper/sdk-proxy.test.ts`

Expected: FAIL — `sdk-proxy.ts` doesn't exist.

- [ ] **Step 3: Implement sdk-proxy.ts — happy path only**

```typescript
// src/wrapper/sdk-proxy.ts
// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0
//
// SDK-aware bidirectional stream-json proxy. Speaks the Claude Code SDK
// control protocol: passes initialize / MCP / hook / etc. control frames
// through to a long-running real claude subprocess, intercepts user text
// messages to inject a set_model control_request based on the pipeline's
// routing decision, and filters our injected control_responses out of
// the SDK-host-facing stdout.

import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { TelemetryWriter } from "../core/telemetry.js";
import { PROMPT_TRUNCATE_CHARS } from "../core/types.js";
import type { Decision, Pipeline, Profile, UserConfig } from "../core/types.js";
import {
  buildSetModelRequest,
  extractPromptText,
  isUserTextMessage,
  matchesInjectedRequestId,
  parseFrame,
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
};

const defaultSpawn: SdkProxySpawn = (binary, args) =>
  nodeSpawn(binary, [...args], { stdio: ["pipe", "pipe", "pipe"] });

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s;
}

export async function runSdkProxy(opts: SdkProxyOptions): Promise<number> {
  const spawn = opts.spawn ?? defaultSpawn;
  const child = spawn(opts.realClaude, opts.claudeArgs);

  let injectedSeq = 0;
  let exitCode: number = 0;

  // ── stdout: filter our injected control_responses, forward everything else.
  if (child.stdout) {
    child.stdout.setEncoding("utf8");
    let buf = "";
    child.stdout.on("data", (chunk: string) => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const frame = parseFrame(line);
        if (frame && matchesInjectedRequestId(frame)) continue;
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

    if (frame !== null && isUserTextMessage(frame)) {
      const promptText = extractPromptText(frame) ?? "";
      const t0 = Date.now();
      const decision: Decision = await opts.pipeline.route({ prompt: promptText });

      // Inject set_model BEFORE forwarding the user message so claude
      // honors the new model on this turn.
      injectedSeq += 1;
      const setModel = buildSetModelRequest(decision.spec.model, injectedSeq);
      child.stdin?.write(JSON.stringify(setModel) + "\n");
      child.stdin?.write(line + "\n");

      try {
        await opts.telemetry.log({
          type: "decision",
          ts: new Date().toISOString(),
          decision: { ...decision, latencyMs: Date.now() - t0 },
          prompt: truncate(promptText, PROMPT_TRUNCATE_CHARS),
        });
      } catch { /* telemetry must never block routing */ }

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
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm vitest run src/wrapper/sdk-proxy.test.ts`

Expected: both tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/wrapper/sdk-proxy.ts src/wrapper/sdk-proxy.test.ts
git commit -m "wrapper: SDK-aware proxy with per-turn set_model injection

Spawns one long-running real claude. Forwards stdin and stdout
verbatim EXCEPT:
- user text messages → classify, inject set_model control_request,
  then forward the user message
- our injected control_responses (maestro- prefixed request_id) →
  dropped from the SDK-host-facing stdout

Telemetry records each turn with the prompt text (truncated 500
chars) and the routing decision.

Happy path only this commit: control-frame passthrough + injected-
response filter + lifecycle. Next commits add error paths and the
wire-compat integration.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: SDK-aware proxy — control frame passthrough + response filter

**Files:**
- Modify: `src/wrapper/sdk-proxy.test.ts` (add tests; no new file)

- [ ] **Step 1: Write failing tests for control passthrough and response filtering**

Append to `src/wrapper/sdk-proxy.test.ts`:

```typescript
describe("runSdkProxy — control protocol passthrough", () => {
  test("forwards control_request frames to the child unchanged", async () => {
    const tel = mockTelemetry();
    const out = collectorStream();
    const stderr = collectorStream();
    const fc = fakeChild([]);

    const initLine =
      '{"type":"control_request","request_id":"sdk-host-1","request":{"subtype":"initialize","hooks":{},"sdkMcpServers":[]}}';
    const stdin = Readable.from([initLine + "\n"]);
    setTimeout(() => fc.close(0), 10);

    await runSdkProxy({
      realClaude: "node",
      claudeArgs: [],
      pipeline: mockPipeline(),
      profile: balancedProfile,
      userConfig: {},
      telemetry: tel.writer,
      stdin,
      stdout: out.stream,
      stderr: stderr.stream,
      spawn: fc.spawn,
    });

    expect(fc.stdinWrites).toHaveLength(1);
    expect(fc.stdinWrites[0]!.trim()).toBe(initLine);
    expect(tel.events).toHaveLength(0); // no user message → no decision
  });

  test("forwards child stdout lines to host stdout unchanged", async () => {
    const tel = mockTelemetry();
    const out = collectorStream();
    const stderr = collectorStream();
    const fc = fakeChild([]);

    const stdin = Readable.from([]); // empty — just verifying stdout passthrough

    const proxyP = runSdkProxy({
      realClaude: "node",
      claudeArgs: [],
      pipeline: mockPipeline(),
      profile: balancedProfile,
      userConfig: {},
      telemetry: tel.writer,
      stdin,
      stdout: out.stream,
      stderr: stderr.stream,
      spawn: fc.spawn,
    });

    fc.emit('{"type":"system","subtype":"init","session_id":"abc"}');
    fc.emit('{"type":"result","subtype":"success","total_cost_usd":0.001,"result":"ok"}');
    fc.close(0);
    await proxyP;

    expect(out.lines).toEqual([
      '{"type":"system","subtype":"init","session_id":"abc"}',
      '{"type":"result","subtype":"success","total_cost_usd":0.001,"result":"ok"}',
    ]);
  });

  test("drops control_response frames matching maestro-prefixed request_ids", async () => {
    const tel = mockTelemetry();
    const out = collectorStream();
    const stderr = collectorStream();
    const fc = fakeChild([]);

    const proxyP = runSdkProxy({
      realClaude: "node",
      claudeArgs: [],
      pipeline: mockPipeline(),
      profile: balancedProfile,
      userConfig: {},
      telemetry: tel.writer,
      stdin: Readable.from([]),
      stdout: out.stream,
      stderr: stderr.stream,
      spawn: fc.spawn,
    });

    fc.emit('{"type":"control_response","response":{"request_id":"maestro-1","subtype":"success"}}');
    fc.emit('{"type":"control_response","response":{"request_id":"sdk-host-x","subtype":"success"}}');
    fc.emit('{"type":"result","subtype":"success","result":"done"}');
    fc.close(0);
    await proxyP;

    expect(out.lines).toEqual([
      '{"type":"control_response","response":{"request_id":"sdk-host-x","subtype":"success"}}',
      '{"type":"result","subtype":"success","result":"done"}',
    ]);
  });

  test("propagates child exit code to the proxy return value", async () => {
    const tel = mockTelemetry();
    const out = collectorStream();
    const stderr = collectorStream();
    const fc = fakeChild([]);

    setTimeout(() => fc.close(7), 10);

    const code = await runSdkProxy({
      realClaude: "node",
      claudeArgs: [],
      pipeline: mockPipeline(),
      profile: balancedProfile,
      userConfig: {},
      telemetry: tel.writer,
      stdin: Readable.from([]),
      stdout: out.stream,
      stderr: stderr.stream,
      spawn: fc.spawn,
    });

    expect(code).toBe(7);
  });
});
```

- [ ] **Step 2: Run tests to verify they already pass against current implementation**

Run: `pnpm vitest run src/wrapper/sdk-proxy.test.ts`

Expected: all tests PASS (Task 2's implementation already handles these — this commit just locks the contract with tests).

- [ ] **Step 3: Commit**

```bash
git add src/wrapper/sdk-proxy.test.ts
git commit -m "wrapper: lock the SDK proxy contract with passthrough + filter tests

Pins the behaviors that prevent regressions:
- control_request frames pass through verbatim
- child stdout lines forward unchanged
- only maestro-tagged control_responses are dropped
- child exit code propagates

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 4: Multi-turn + slash command bypass

**Files:**
- Modify: `src/wrapper/sdk-proxy.ts` (add slash-prefix bypass)
- Modify: `src/wrapper/sdk-proxy.test.ts` (add multi-turn + slash tests)

- [ ] **Step 1: Write failing tests**

Append to `src/wrapper/sdk-proxy.test.ts`:

```typescript
describe("runSdkProxy — multi-turn + slash commands", () => {
  test("handles two user turns in sequence with separate set_model injections", async () => {
    const tel = mockTelemetry();
    const out = collectorStream();
    const stderr = collectorStream();
    const fc = fakeChild([]);

    // First "format" → trivial, second "design a sharding strategy" → standard.
    let callCount = 0;
    const pipeline: Pipeline = {
      route: async () => {
        callCount += 1;
        return decisionFor(callCount === 1 ? "trivial" : "standard");
      },
    };

    const stdin = Readable.from([
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"format file"}]}}\n',
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"design sharding"}]}}\n',
    ]);
    setTimeout(() => fc.close(0), 10);

    await runSdkProxy({
      realClaude: "node",
      claudeArgs: [],
      pipeline,
      profile: balancedProfile,
      userConfig: {},
      telemetry: tel.writer,
      stdin,
      stdout: out.stream,
      stderr: stderr.stream,
      spawn: fc.spawn,
    });

    // Order: set_model(haiku), user1, set_model(sonnet), user2
    expect(fc.stdinWrites).toHaveLength(4);
    const sm1 = JSON.parse(fc.stdinWrites[0]!.trim());
    const sm2 = JSON.parse(fc.stdinWrites[2]!.trim());
    expect(sm1.request.model).toBe(balancedProfile.classes.trivial.model);
    expect(sm2.request.model).toBe(balancedProfile.classes.standard.model);
    expect(sm1.request_id).not.toBe(sm2.request_id);
    expect(tel.events).toHaveLength(2);
  });

  test("slash-prefixed user messages bypass the classifier and use standard class", async () => {
    const tel = mockTelemetry();
    const out = collectorStream();
    const stderr = collectorStream();
    const fc = fakeChild([]);

    const routeMock = vi.fn();
    const pipeline: Pipeline = { route: routeMock };

    const stdin = Readable.from([
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"/model haiku"}]}}\n',
    ]);
    setTimeout(() => fc.close(0), 10);

    await runSdkProxy({
      realClaude: "node",
      claudeArgs: [],
      pipeline,
      profile: balancedProfile,
      userConfig: {},
      telemetry: tel.writer,
      stdin,
      stdout: out.stream,
      stderr: stderr.stream,
      spawn: fc.spawn,
    });

    // pipeline.route must NOT have been called for a slash command.
    expect(routeMock).not.toHaveBeenCalled();
    // No set_model injected — slash commands route at "standard" with passthrough classifier.
    // We still forward the user message untouched.
    expect(fc.stdinWrites).toHaveLength(1);
    const fwd = JSON.parse(fc.stdinWrites[0]!.trim());
    expect(fwd.type).toBe("user");
  });
});
```

- [ ] **Step 2: Run tests to verify failure on the slash test**

Run: `pnpm vitest run src/wrapper/sdk-proxy.test.ts`

Expected: multi-turn test PASSES already; slash test FAILS (pipeline.route is currently called).

- [ ] **Step 3: Add slash bypass to sdk-proxy.ts**

Edit `src/wrapper/sdk-proxy.ts`:

Replace:
```typescript
    if (frame !== null && isUserTextMessage(frame)) {
      const promptText = extractPromptText(frame) ?? "";
      const t0 = Date.now();
      const decision: Decision = await opts.pipeline.route({ prompt: promptText });

      // Inject set_model BEFORE forwarding the user message so claude
      // honors the new model on this turn.
      injectedSeq += 1;
      const setModel = buildSetModelRequest(decision.spec.model, injectedSeq);
      child.stdin?.write(JSON.stringify(setModel) + "\n");
      child.stdin?.write(line + "\n");
```

With:
```typescript
    if (frame !== null && isUserTextMessage(frame)) {
      const promptText = extractPromptText(frame) ?? "";
      const t0 = Date.now();

      // Slash commands (/model, /clear, /compact, etc.) are interactive
      // directives handled by the SDK host. Don't classify them, and
      // don't inject set_model — they should reach the SDK host's command
      // handler unmodified.
      if (promptText.startsWith("/")) {
        child.stdin?.write(line + "\n");
        continue;
      }

      const decision: Decision = await opts.pipeline.route({ prompt: promptText });

      // Inject set_model BEFORE forwarding the user message so claude
      // honors the new model on this turn.
      injectedSeq += 1;
      const setModel = buildSetModelRequest(decision.spec.model, injectedSeq);
      child.stdin?.write(JSON.stringify(setModel) + "\n");
      child.stdin?.write(line + "\n");
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm vitest run src/wrapper/sdk-proxy.test.ts`

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/wrapper/sdk-proxy.ts src/wrapper/sdk-proxy.test.ts
git commit -m "wrapper: bypass classifier for slash commands and verify multi-turn

/model, /clear, /compact and friends are SDK-host directives. Don't
classify them and don't inject set_model — they need to reach the
host unmodified.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 5: Wire the proxy into wire-compat; delete the old per-turn proxy

**Files:**
- Modify: `src/cli/wire-compat.ts`
- Delete: `src/wrapper/stream-json-proxy.ts`
- Delete: `src/wrapper/stream-json-proxy.test.ts`

- [ ] **Step 1: Delete the old proxy**

```bash
git rm src/wrapper/stream-json-proxy.ts src/wrapper/stream-json-proxy.test.ts
```

- [ ] **Step 2: Edit wire-compat.ts**

Open `src/cli/wire-compat.ts`. Find the imports block and replace:

```typescript
import { runStreamJsonProxy } from "../wrapper/stream-json-proxy.js";
```

with:

```typescript
import { runSdkProxy } from "../wrapper/sdk-proxy.js";
```

Find the `if (argsContainStreamJsonInput(claudeArgs)) { ... }` block (currently the passthrough + opt-in MAESTRO_STREAM_JSON_PROXY=1 path). Replace it with:

```typescript
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
```

- [ ] **Step 3: Run typecheck + tests**

Run: `pnpm typecheck && pnpm test`

Expected: all green. The old proxy's tests are gone; the new proxy's tests pass.

- [ ] **Step 4: Rebuild + reinstall + smoke test**

Run:
```bash
rm -f maestro-router-*.tgz
pnpm build
pnpm pack >/dev/null
npm install -g ./maestro-router-0.2.0.tgz
```

Smoke test with a fake claude binary:

```bash
cat > /tmp/fake-claude.sh <<'EOF'
#!/usr/bin/env bash
# Echo stdin lines, emit a fake init + result.
echo '{"type":"system","subtype":"init","session_id":"smoke","cwd":"/tmp","tools":[],"mcp_servers":[]}'
while IFS= read -r line; do
  # Echo back any control_request as a success control_response (mimics real claude).
  if [[ "$line" == *"\"control_request\""* ]]; then
    request_id=$(echo "$line" | python3 -c 'import json,sys; print(json.load(sys.stdin)["request_id"])' 2>/dev/null)
    if [[ -n "$request_id" ]]; then
      echo "{\"type\":\"control_response\",\"response\":{\"request_id\":\"$request_id\",\"subtype\":\"success\"}}"
    fi
  fi
done
echo '{"type":"result","subtype":"success","total_cost_usd":0.001,"result":"smoke ok"}'
EOF
mkdir -p /tmp/fake-bin && cp /tmp/fake-claude.sh /tmp/fake-bin/claude && chmod +x /tmp/fake-bin/claude

printf '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"format this file"}]}}\n' | \
  maestro /tmp/fake-bin/claude --input-format stream-json --output-format stream-json --print --verbose 2>&1 | head -10
```

Expected output (order matters):
- `{"type":"system","subtype":"init",...}` — from fake claude
- `{"type":"result","subtype":"success","total_cost_usd":0.001,"result":"smoke ok"}`
- The `maestro-1` control_response is NOT visible (filtered).

- [ ] **Step 5: Commit**

```bash
git add src/cli/wire-compat.ts
git commit -m "wrapper: switch stream-json mode to the SDK-aware proxy

Replaces the per-turn-spawn proxy (broken — drops SDK control frames,
caused 'Failed to load config cache' 60s timeout in VSCode panel) and
the temporary passthrough (working but no per-turn routing) with the
new SDK-aware proxy.

The SDK-aware proxy:
- Spawns ONE long-running real claude
- Passes through every control frame (initialize / MCP / hooks / etc.)
- Intercepts user text messages, classifies them, injects
  {subtype:'set_model', model:routed} as a control_request before
  forwarding the user message
- Filters our injected control_responses out of the SDK-host-facing
  stdout (recognized by maestro-prefixed request_id)
- Logs per-turn telemetry with prompt text

Effect on VSCode panel:
- Init/MCP/hooks work (no 60s timeout)
- Every user turn gets routed (cost savings restored)
- Telemetry captures every prompt (real-prompt corpus grows)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 6: Real-claude integration test (one round-trip against a scripted fake)

**Files:**
- Create: `src/wrapper/sdk-proxy.integration.test.ts`

- [ ] **Step 1: Write the integration test**

```typescript
// src/wrapper/sdk-proxy.integration.test.ts
// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0
//
// End-to-end test using a real node:child_process spawn of a scripted
// "fake claude" — exercises the actual stream wiring (data events,
// timing, ordering) that unit tests with injected spawns can't cover.
// Still uses NO real Claude calls — the fake binary is a node script.

import { describe, expect, test } from "vitest";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { runSdkProxy } from "./sdk-proxy.js";
import { balancedProfile } from "../core/profile.js";
import type { Decision, Pipeline, TelemetryEvent } from "../core/types.js";

function collector(): { stream: Writable; lines: string[] } {
  const lines: string[] = [];
  let buf = "";
  const stream = new Writable({
    write(chunk, _enc, cb) {
      buf += chunk.toString();
      const parts = buf.split("\n");
      buf = parts.pop() ?? "";
      for (const p of parts) lines.push(p);
      cb();
    },
  });
  return { stream, lines };
}

describe("runSdkProxy — integration", () => {
  test("end-to-end with a scripted fake claude", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-sdk-proxy-"));
    try {
      const fakeClaude = join(dir, "claude");
      await writeFile(
        fakeClaude,
        `#!/usr/bin/env node
process.stdout.write('{"type":"system","subtype":"init","session_id":"int-1"}\\n');
let buf = "";
process.stdin.on("data", (c) => {
  buf += c.toString();
  const lines = buf.split("\\n");
  buf = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === "control_request") {
        process.stdout.write(JSON.stringify({
          type: "control_response",
          response: { request_id: obj.request_id, subtype: "success" }
        }) + "\\n");
      }
    } catch {}
  }
});
process.stdin.on("end", () => {
  process.stdout.write('{"type":"result","subtype":"success","total_cost_usd":0.001,"result":"int ok"}\\n');
  process.exit(0);
});
`,
        "utf8",
      );
      await chmod(fakeClaude, 0o755);

      const out = collector();
      const stderr = collector();
      const events: TelemetryEvent[] = [];

      const decision: Decision = {
        class: "trivial",
        classifier: "test",
        confidence: 1.0,
        spec: balancedProfile.classes.trivial,
        latencyMs: 0,
        diagnostics: [],
      };
      const pipeline: Pipeline = { route: async () => decision };

      const stdin = Readable.from([
        '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"format me"}]}}\n',
      ]);

      const code = await runSdkProxy({
        realClaude: fakeClaude,
        claudeArgs: [],
        pipeline,
        profile: balancedProfile,
        userConfig: {},
        telemetry: { log: async (e) => { events.push(e); }, readAll: async () => events },
        stdin,
        stdout: out.stream,
        stderr: stderr.stream,
      });

      expect(code).toBe(0);
      // Init forwarded, control_response filtered, result forwarded.
      expect(out.lines.some((l) => l.includes('"subtype":"init"'))).toBe(true);
      expect(out.lines.some((l) => l.includes('"subtype":"success"') && l.includes('maestro-'))).toBe(false);
      expect(out.lines.some((l) => l.includes('"subtype":"success"') && l.includes('"result"'))).toBe(true);
      // Telemetry captured the turn with prompt.
      expect(events).toHaveLength(1);
      expect((events[0] as { prompt?: string }).prompt).toBe("format me");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the integration test**

Run: `pnpm vitest run src/wrapper/sdk-proxy.integration.test.ts`

Expected: PASS.

- [ ] **Step 3: Run the full suite**

Run: `pnpm test`

Expected: all tests pass. Number should be `(unit-test-count) + (sdk-proxy unit) + 1 (integration)`.

- [ ] **Step 4: Commit**

```bash
git add src/wrapper/sdk-proxy.integration.test.ts
git commit -m "wrapper: end-to-end SDK proxy test against a scripted fake claude

Exercises the real node:child_process spawn path — covers the stream
wiring (data event timing, ordering, child lifecycle) that the
injected-spawn unit tests can't observe. Still NO real Claude calls;
the fake binary is a node script.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 7: Manual VSCode validation + cleanup

**Files:** N/A — this is verification.

- [ ] **Step 1: Refresh the global binary**

```bash
rm -f maestro-router-*.tgz
pnpm pack >/dev/null
npm install -g ./maestro-router-0.2.0.tgz
maestro --version
```

Expected: `0.2.0`.

- [ ] **Step 2: User reloads VSCode**

User action: Cmd+Shift+P → "Developer: Reload Window".

- [ ] **Step 3: User sends a prompt in the panel**

User action: type "hello" in the VSCode panel.

Expected: response arrives without 60s timeout. No "Failed to load config cache" errors in the VSCode log.

- [ ] **Step 4: Verify telemetry captured the turn**

```bash
tail -1 ~/.maestro/decisions.jsonl | python3 -c 'import json,sys; e=json.load(sys.stdin); print(f"class={e[\"decision\"][\"class\"]}  classifier={e[\"decision\"][\"classifier\"]}  prompt={e.get(\"prompt\",\"<missing>\")[:60]}")'
```

Expected: a fresh event with a non-empty `prompt` field, today's timestamp.

- [ ] **Step 5: Verify maestro stats counts the new event**

```bash
maestro stats --since 1
```

Expected: at least 1 new event since the last reload.

- [ ] **Step 6: Run a 3-turn conversation in the panel**

User action: send 3 messages of varying complexity (e.g. "ping", "implement a debounce utility", "design a sharding strategy").

Expected:
- All 3 produce responses.
- `~/.maestro/decisions.jsonl` gains 3 entries with different classes (trivial / standard / reasoning, depending on heuristic + embedding routing).
- `maestro stats` reflects the new diversity.

If all steps pass, this plan is done.

---

## Self-review notes (resolved before finalizing)

- **Spec coverage:** every requirement (per-turn routing in VSCode, no 60s timeout, control protocol preserved, telemetry captures prompt) maps to a task. ✓
- **Placeholders:** none. Every step has either a code block, an exact command, or a concrete expected output. ✓
- **Type consistency:** `SdkProxySpawn`, `SdkProxyOptions`, `Frame`, `SetModelRequest` are defined in Task 1/2 and referenced consistently in Tasks 3-6. The function `runSdkProxy` name doesn't drift. ✓
- **Telemetry coupling:** the `prompt?` field on the decision event already exists from commit 07ba06c — no schema change needed. ✓
- **Tests don't spawn real claude:** all tests use either injected spawn (units) or a node-script fake (integration). ✓

## Risks & rollback

- **Risk:** real claude rejects `set_model` mid-session for some plans (e.g. opus-not-available). **Mitigation:** the maestro-prefixed control_response would carry a subtype other than "success"; the proxy currently filters all maestro-prefixed responses regardless, so the SDK host never sees the error. claude continues with its previous model and the user's prompt is processed at that model. Not catastrophic.
- **Risk:** `set_model` semantic differs slightly from the original `--model` arg path (e.g. doesn't update effort). **Mitigation:** add `set_max_thinking_tokens` or `apply_flag_settings` injection in a follow-up if needed; the current MVP just routes the model.
- **Rollback:** `git revert` the Task-5 commit reverts to the passthrough mode (panel works, no per-turn routing). The proxy module stays in place for fixing forward.
