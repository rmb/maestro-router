// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, expect, test, vi } from "vitest";
import { Readable, Writable } from "node:stream";
import {
  buildTurnArgs,
  extractSessionId,
  readNextUserTurn,
  runStreamJsonProxy,
  streamClaudeForTurn,
} from "./stream-json-proxy.js";
import { balancedProfile } from "../core/profile.js";
import type { Decision, TelemetryEvent } from "../core/types.js";
import type { Pipeline } from "../core/pipeline.js";
import type { TelemetryWriter } from "../core/telemetry.js";

const testDecision = (cls: keyof typeof balancedProfile.classes = "standard"): Decision => ({
  class: cls,
  classifier: "test",
  confidence: 1.0,
  spec: balancedProfile.classes[cls],
  latencyMs: 0,
  diagnostics: [],
});

function collector(): { stream: Writable; buf: string } {
  const ctx = { stream: null as unknown as Writable, buf: "" };
  ctx.stream = new Writable({
    write(chunk, _enc, cb) { ctx.buf += chunk.toString(); cb(); },
  });
  return ctx as { stream: Writable; buf: string };
}

async function* toLines(lines: string[]): AsyncGenerator<string> {
  for (const line of lines) yield line;
}

// ─── extractSessionId ───────────────────────────────────────────────────────

describe("extractSessionId", () => {
  test("returns UUID when --session-id is present", () => {
    expect(extractSessionId(["--print", "--session-id", "abc-123", "--model", "haiku"]))
      .toBe("abc-123");
  });

  test("returns null when --session-id is absent", () => {
    expect(extractSessionId(["--print", "--model", "sonnet"])).toBeNull();
  });

  test("returns null when --session-id has no value (treated as flag collision)", () => {
    // "--resume" starts with "-" so it's not treated as a value
    expect(extractSessionId(["--session-id", "--resume"])).toBeNull();
  });

  test("returns null for empty args", () => {
    expect(extractSessionId([])).toBeNull();
  });
});

// ─── buildTurnArgs ──────────────────────────────────────────────────────────

describe("buildTurnArgs", () => {
  const base = [
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--session-id", "orig-uuid",
    "--model", "opus",
    "--effort", "high",
    "--max-budget-usd", "1.0",
  ];
  const decision = testDecision("standard");

  test("strips --input-format stream-json and adds --output-format stream-json", () => {
    const args = buildTurnArgs(base, decision, "s1", true, false, undefined);
    expect(args).not.toContain("--input-format");
    expect(args).toContain("--output-format");
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
  });

  test("isFirstTurn=true has no --resume when base had no --resume", () => {
    const args = buildTurnArgs(base, decision, "s1", true, false, undefined);
    expect(args).not.toContain("--resume");
    expect(args).toContain("--session-id");
  });

  test("isFirstTurn=false has --resume", () => {
    const args = buildTurnArgs(base, decision, "s1", false, false, undefined);
    expect(args).toContain("--resume");
  });

  test("isFirstTurn=true with --resume in base preserves --resume", () => {
    const baseWithResume = [...base, "--resume"];
    const args = buildTurnArgs(baseWithResume, decision, "s1", true, false, undefined);
    expect(args).toContain("--resume");
  });

  test("routing flags replaced by decision spec", () => {
    const args = buildTurnArgs(base, decision, "s1", true, false, undefined);
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe(balancedProfile.classes.standard.model);
    expect(args).toContain("--effort");
    expect(args[args.indexOf("--effort") + 1]).toBe(balancedProfile.classes.standard.effort);
    expect(args).toContain("--max-budget-usd");
  });

  test("never adds --bare even when decision spec has bare=true", () => {
    const bareDecision: Decision = {
      ...testDecision("trivial"),
      spec: { ...balancedProfile.classes.trivial, bare: true },
    };
    const args = buildTurnArgs(base, bareDecision, "s1", true, true, undefined);
    expect(args).not.toContain("--bare");
  });

  test("adds --exclude-dynamic-system-prompt-sections by default", () => {
    const args = buildTurnArgs(base, decision, "s1", true, false, undefined);
    expect(args).toContain("--exclude-dynamic-system-prompt-sections");
  });

  test("strips --bare from base args", () => {
    const baseWithBare = [...base, "--bare"];
    const args = buildTurnArgs(baseWithBare, decision, "s1", true, false, undefined);
    expect(args).not.toContain("--bare");
  });

  test("adds --print when not in base", () => {
    const args = buildTurnArgs(base, decision, "s1", true, false, undefined);
    expect(args).toContain("--print");
  });
});

// ─── readNextUserTurn ────────────────────────────────────────────────────────

describe("readNextUserTurn", () => {
  const userLine = (text: string) =>
    JSON.stringify({ type: "user", message: { content: [{ type: "text", text }] } });
  const systemLine = () =>
    JSON.stringify({ type: "system", subtype: "init", session_id: "abc" });
  const toolResultLine = () =>
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] } });

  test("returns promptText from a user text turn", async () => {
    const iter = toLines([systemLine(), userLine("what is 2+2?")]);
    const result = await readNextUserTurn(iter);
    expect(result).not.toBeNull();
    expect(result!.promptText).toBe("what is 2+2?");
  });

  test("skips system lines", async () => {
    const iter = toLines([systemLine(), systemLine(), userLine("hello")]);
    const result = await readNextUserTurn(iter);
    expect(result!.promptText).toBe("hello");
  });

  test("skips tool_result-only user messages", async () => {
    const iter = toLines([toolResultLine(), userLine("follow up")]);
    const result = await readNextUserTurn(iter);
    expect(result!.promptText).toBe("follow up");
  });

  test("skips non-JSON lines without throwing", async () => {
    const iter = toLines(["not json", "{bad json", userLine("clean prompt")]);
    const result = await readNextUserTurn(iter);
    expect(result!.promptText).toBe("clean prompt");
  });

  test("returns null when stream closes without a user turn", async () => {
    const iter = toLines([systemLine()]);
    const result = await readNextUserTurn(iter);
    expect(result).toBeNull();
  });

  test("returns null on empty stream", async () => {
    const iter = toLines([]);
    const result = await readNextUserTurn(iter);
    expect(result).toBeNull();
  });

  test("extracts session_id from the user message when present", async () => {
    const line = JSON.stringify({
      type: "user",
      session_id: "sid-xyz",
      message: { content: [{ type: "text", text: "hi" }] },
    });
    const iter = toLines([line]);
    const result = await readNextUserTurn(iter);
    expect(result!.sessionId).toBe("sid-xyz");
  });

  test("returns sessionId=null when not in message", async () => {
    const iter = toLines([userLine("hello")]);
    const result = await readNextUserTurn(iter);
    expect(result!.sessionId).toBeNull();
  });
});

// ─── streamClaudeForTurn ─────────────────────────────────────────────────────

const initEvent = JSON.stringify({ type: "system", subtype: "init", session_id: "s1", tools: [] });
const assistantEvent = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } });
const resultEvent = JSON.stringify({
  type: "result",
  subtype: "success",
  session_id: "s1",
  total_cost_usd: 0.001,
  duration_ms: 100,
  duration_api_ms: 90,
  stop_reason: "end_turn",
  usage: { input_tokens: 5, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, service_tier: "standard" },
  modelUsage: { "claude-haiku-4-5-20251001": { inputTokens: 5, outputTokens: 10, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, costUSD: 0.001 } },
});

// Script that writes fake NDJSON events and echoes stdin
function makeNodeScript(events: string[]): string {
  const json = JSON.stringify(events);
  return `
    const events = ${json};
    for (const e of events) process.stdout.write(e + '\\n');
    process.exit(0);
  `;
}

describe("streamClaudeForTurn", () => {
  test("forwards all events to stdout on first turn (init not suppressed)", async () => {
    const out = collector();
    const script = makeNodeScript([initEvent, assistantEvent, resultEvent]);
    const result = await streamClaudeForTurn("node", ["-e", script], "hello", out.stream, true);
    expect(out.buf).toContain('"type":"system"');
    expect(out.buf).toContain('"subtype":"init"');
    expect(out.buf).toContain('"type":"assistant"');
    expect(result.exitCode).toBe(0);
  });

  test("suppresses init event on turns 2+", async () => {
    const out = collector();
    const script = makeNodeScript([initEvent, assistantEvent, resultEvent]);
    await streamClaudeForTurn("node", ["-e", script], "hello", out.stream, false);
    expect(out.buf).not.toContain('"subtype":"init"');
    expect(out.buf).toContain('"type":"assistant"');
  });

  test("parses cost from result event", async () => {
    const out = collector();
    const script = makeNodeScript([initEvent, resultEvent]);
    const result = await streamClaudeForTurn("node", ["-e", script], "hello", out.stream, true);
    expect(result.cost).not.toBeNull();
    expect(result.cost!.totalCostUsd).toBeCloseTo(0.001);
    expect(result.cost!.inputTokens).toBe(5);
    expect(result.cost!.outputTokens).toBe(10);
    expect(result.cost!.modelUsed).toBe("claude-haiku-4-5-20251001");
  });

  test("returns sessionId from result event", async () => {
    const out = collector();
    const script = makeNodeScript([initEvent, resultEvent]);
    const result = await streamClaudeForTurn("node", ["-e", script], "hello", out.stream, true);
    expect(result.sessionId).toBe("s1");
  });

  test("returns cost=null when no result event emitted", async () => {
    const out = collector();
    const script = makeNodeScript([assistantEvent]);
    const result = await streamClaudeForTurn("node", ["-e", script], "hello", out.stream, true);
    expect(result.cost).toBeNull();
  });
});

// ─── runStreamJsonProxy ──────────────────────────────────────────────────────

describe("runStreamJsonProxy", () => {
  const mockPipeline = (cls: "standard" | "hard" = "standard"): Pipeline => ({
    route: async () => testDecision(cls),
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

  const userLine = (text: string) =>
    JSON.stringify({ type: "user", message: { content: [{ type: "text", text }] } });

  test("processes multiple turns and logs per-turn decisions", async () => {
    const tel = mockTelemetry();
    const out = collector();
    const stderr = collector();

    const mockSpawn = vi.fn().mockResolvedValue({ exitCode: 0, cost: null, sessionId: "s1" });

    const stdinData = [userLine("turn 1"), userLine("turn 2")].join("\n") + "\n";
    const stdin = Readable.from([stdinData]);

    const exitCode = await runStreamJsonProxy({
      realClaude: "node",
      claudeArgs: ["--input-format", "stream-json"],
      pipeline: mockPipeline(),
      profile: balancedProfile,
      userConfig: {},
      telemetry: tel.writer,
      stdin,
      stdout: out.stream,
      stderr: stderr.stream,
      spawnTurn: mockSpawn,
    });

    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(tel.events).toHaveLength(2);
    expect(tel.events.every((e) => e.type === "decision")).toBe(true);
    expect(exitCode).toBe(0);
  });

  test("first turn has no --resume, second turn has --resume", async () => {
    const tel = mockTelemetry();
    const out = collector();
    const stderr = collector();
    const capturedArgs: string[][] = [];

    const mockSpawn = vi.fn().mockImplementation(
      (_binary: string, args: ReadonlyArray<string>) => {
        capturedArgs.push([...args]);
        return Promise.resolve({ exitCode: 0, cost: null, sessionId: "s1" });
      },
    );

    const stdinData = [userLine("first"), userLine("second")].join("\n") + "\n";
    const stdin = Readable.from([stdinData]);

    await runStreamJsonProxy({
      realClaude: "node",
      claudeArgs: ["--input-format", "stream-json", "--session-id", "fixed-uuid"],
      pipeline: mockPipeline(),
      profile: balancedProfile,
      userConfig: {},
      telemetry: tel.writer,
      stdin,
      stdout: out.stream,
      stderr: stderr.stream,
      spawnTurn: mockSpawn,
    });

    expect(capturedArgs[0]).not.toContain("--resume");
    expect(capturedArgs[1]).toContain("--resume");
  });

  test("exits cleanly when stdin closes with no user turns", async () => {
    const tel = mockTelemetry();
    const out = collector();
    const err = collector();
    const mockSpawn = vi.fn().mockResolvedValue({ exitCode: 0, cost: null, sessionId: null });
    const stdin = Readable.from([""]);

    const exitCode = await runStreamJsonProxy({
      realClaude: "node",
      claudeArgs: ["--input-format", "stream-json"],
      pipeline: mockPipeline(),
      profile: balancedProfile,
      userConfig: {},
      telemetry: tel.writer,
      stdin,
      stdout: out.stream,
      stderr: err.stream,
      spawnTurn: mockSpawn,
    });

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(exitCode).toBe(0);
  });

  test("session ID from first turn result is reused in subsequent turns", async () => {
    const tel = mockTelemetry();
    const out = collector();
    const err = collector();
    const capturedArgs: string[][] = [];
    let callCount = 0;

    const mockSpawn = vi.fn().mockImplementation(
      (_binary: string, args: ReadonlyArray<string>) => {
        capturedArgs.push([...args]);
        callCount++;
        return Promise.resolve({
          exitCode: 0,
          cost: null,
          sessionId: callCount === 1 ? "discovered-uuid" : null,
        });
      },
    );

    // No --session-id in claudeArgs — session ID comes from turn 1 result
    const stdinData = [userLine("hi"), userLine("there")].join("\n") + "\n";
    const stdin = Readable.from([stdinData]);

    await runStreamJsonProxy({
      realClaude: "node",
      claudeArgs: ["--input-format", "stream-json"],
      pipeline: mockPipeline(),
      profile: balancedProfile,
      userConfig: {},
      telemetry: tel.writer,
      stdin,
      stdout: out.stream,
      stderr: err.stream,
      spawnTurn: mockSpawn,
    });

    // Turn 2 args should include the session ID discovered from turn 1
    const turn2SessionIdx = capturedArgs[1]?.indexOf("--session-id") ?? -1;
    expect(turn2SessionIdx).toBeGreaterThanOrEqual(0);
    expect(capturedArgs[1]?.[turn2SessionIdx + 1]).toBe("discovered-uuid");
  });

  test("slash command turns bypass pipeline and use standard class", async () => {
    const tel = mockTelemetry();
    const out = collector();
    const err = collector();
    const capturedDecisions: string[] = [];

    // Pipeline should NOT be called for slash commands
    const spyPipeline: Pipeline = {
      route: async (req) => {
        capturedDecisions.push(req.prompt);
        return testDecision("trivial"); // would misroute if called
      },
    };

    const mockSpawn = vi.fn().mockImplementation(
      (_binary: string, _args: ReadonlyArray<string>, prompt: string) => {
        return Promise.resolve({ exitCode: 0, cost: null, sessionId: "s1" });
      },
    );

    const slashLine = JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "/model haiku" }] } });
    const realLine = JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "real question" }] } });
    const stdinData = [slashLine, realLine].join("\n") + "\n";
    const stdin = Readable.from([stdinData]);

    await runStreamJsonProxy({
      realClaude: "node",
      claudeArgs: ["--input-format", "stream-json"],
      pipeline: spyPipeline,
      profile: balancedProfile,
      userConfig: {},
      telemetry: tel.writer,
      stdin,
      stdout: out.stream,
      stderr: err.stream,
      spawnTurn: mockSpawn,
    });

    // Pipeline called only for the real question, not the slash command
    expect(capturedDecisions).toHaveLength(1);
    expect(capturedDecisions[0]).toBe("real question");
    // Both turns still spawned (slash command gets standard model passthrough)
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    // Slash command turn logged with classifier=passthrough
    const slashEvent = tel.events.find((e) =>
      e.type === "decision" && (e as { decision: { classifier: string } }).decision.classifier === "passthrough",
    );
    expect(slashEvent).toBeDefined();
  });
});
