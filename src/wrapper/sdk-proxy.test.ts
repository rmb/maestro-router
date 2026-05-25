// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, expect, test, vi } from "vitest";
import { Readable, Writable } from "node:stream";
import { balancedProfile } from "../core/profile.js";
import type { Pipeline } from "../core/pipeline.js";
import type { Decision, TelemetryEvent } from "../core/types.js";
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
function fakeChild(_scriptedOutput: string[]): {
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
    // Emit result frame after routing so pending telemetry entry is flushed.
    setTimeout(() => {
      fc.emit('{"type":"result","subtype":"success","total_cost_usd":0}');
      fc.close(0);
    }, 10);

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
    // Emit two result frames (one per turn) then close.
    setTimeout(() => {
      fc.emit('{"type":"result","subtype":"success","total_cost_usd":0}');
      fc.emit('{"type":"result","subtype":"success","total_cost_usd":0}');
      fc.close(0);
    }, 10);

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

describe("runSdkProxy — tool_result routing via toolUseMap", () => {
  test("reads tool name from assistant stdout frame and injects set_model for subsequent tool_result", async () => {
    const tel = mockTelemetry();
    const out = collectorStream();
    const stderr = collectorStream();
    const fc = fakeChild([]);

    // Pipeline: Read → trivial (haiku), anything else → standard (sonnet).
    const pipeline: Pipeline = {
      route: async (req) => {
        const tool = req.metadata?.resolvedToolName;
        return decisionFor(tool === "Read" ? "trivial" : "standard");
      },
    };

    // Sequence: assistant emits tool_use(Read), then host sends tool_result.
    const assistantLine =
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_01","name":"Read","input":{"path":"index.ts"}}]}}';
    const toolResultLine =
      '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01","content":"file contents"}]}}';

    const proxyP = runSdkProxy({
      realClaude: "node",
      claudeArgs: [],
      pipeline,
      profile: balancedProfile,
      userConfig: {},
      telemetry: tel.writer,
      stdin: Readable.from([toolResultLine + "\n"]),
      stdout: out.stream,
      stderr: stderr.stream,
      spawn: fc.spawn,
    });

    // Emit the assistant frame from child stdout BEFORE the tool_result arrives.
    // In real usage the child processes the tool_use and we get the result on stdin.
    // In tests we emit on child stdout before closing.
    fc.emit(assistantLine);
    fc.close(0);
    await proxyP;

    // The proxy should have injected set_model (haiku) then the tool_result frame.
    expect(fc.stdinWrites).toHaveLength(2);
    const setModel = JSON.parse(fc.stdinWrites[0]!.trim()) as {
      type: string;
      request: { subtype: string; model: string };
    };
    expect(setModel.type).toBe("control_request");
    expect(setModel.request.subtype).toBe("set_model");
    expect(setModel.request.model).toBe(balancedProfile.classes.trivial.model); // haiku

    const forwarded = JSON.parse(fc.stdinWrites[1]!.trim()) as { type: string };
    expect(forwarded.type).toBe("user");
  });

  test("tool_result with unknown tool_use_id falls back to pipeline without metadata", async () => {
    const tel = mockTelemetry();
    const out = collectorStream();
    const stderr = collectorStream();
    const fc = fakeChild([]);

    const routeCalls: Array<import("../core/types.js").Request> = [];
    const pipeline: Pipeline = {
      route: async (req) => {
        routeCalls.push(req);
        return decisionFor("standard");
      },
    };

    // tool_result referencing an id that never appeared in assistant stdout.
    const toolResultLine =
      '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"unknown-id","content":"data"}]}}';

    setTimeout(() => fc.close(0), 10);

    await runSdkProxy({
      realClaude: "node",
      claudeArgs: [],
      pipeline,
      profile: balancedProfile,
      userConfig: {},
      telemetry: tel.writer,
      stdin: Readable.from([toolResultLine + "\n"]),
      stdout: out.stream,
      stderr: stderr.stream,
      spawn: fc.spawn,
    });

    // Pipeline must have been called with no resolvedToolName.
    expect(routeCalls).toHaveLength(1);
    expect(routeCalls[0]!.metadata?.resolvedToolName).toBeUndefined();

    // set_model + tool_result frame forwarded.
    expect(fc.stdinWrites).toHaveLength(2);
  });

  test("toolUseMap evicts oldest entry when size exceeds 50", async () => {
    const tel = mockTelemetry();
    const out = collectorStream();
    const stderr = collectorStream();
    const fc = fakeChild([]);

    const routeCalls: Array<import("../core/types.js").Request> = [];
    const pipeline: Pipeline = {
      route: async (req) => {
        routeCalls.push(req);
        return decisionFor("standard");
      },
    };

    // Emit 51 assistant frames, each with a different tool_use id.
    // The first one ("toolu_00") should be evicted before we send its tool_result.
    const proxyP = runSdkProxy({
      realClaude: "node",
      claudeArgs: [],
      pipeline,
      profile: balancedProfile,
      userConfig: {},
      telemetry: tel.writer,
      stdin: Readable.from([
        '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_00","content":"data"}]}}\n',
      ]),
      stdout: out.stream,
      stderr: stderr.stream,
      spawn: fc.spawn,
    });

    // Emit 51 assistant frames with unique ids; toolu_00 through toolu_50.
    for (let i = 0; i <= 50; i++) {
      fc.emit(
        `{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_${i.toString().padStart(2,"0")}","name":"Read","input":{}}]}}`,
      );
    }
    fc.close(0);
    await proxyP;

    // toolu_00 was evicted; pipeline receives no resolvedToolName.
    expect(routeCalls).toHaveLength(1);
    expect(routeCalls[0]!.metadata?.resolvedToolName).toBeUndefined();
  });

  test("tool_result routing happens but is not logged to telemetry", async () => {
    const tel = mockTelemetry();
    const out = collectorStream();
    const stderr = collectorStream();
    const fc = fakeChild([]);

    const assistantLine =
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_01","name":"Grep","input":{}}]}}';
    const toolResultLine =
      '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01","content":"12 matches"}]}}';

    const proxyP = runSdkProxy({
      realClaude: "node",
      claudeArgs: [],
      pipeline: mockPipeline("trivial"),
      profile: balancedProfile,
      userConfig: {},
      telemetry: tel.writer,
      stdin: Readable.from([toolResultLine + "\n"]),
      stdout: out.stream,
      stderr: stderr.stream,
      spawn: fc.spawn,
    });

    // assistantLine populates toolUseMap synchronously.
    // Delay result frame so the tool_result stdin line is processed first.
    fc.emit(assistantLine);
    setTimeout(() => {
      fc.emit('{"type":"result","subtype":"success","total_cost_usd":0}');
      fc.close(0);
    }, 10);
    await proxyP;

    // Tool_result messages route through the pipeline but do NOT get logged.
    // No decision events should be recorded.
    expect(tel.events).toHaveLength(0);
  });

  test("non-tool-result user message is not affected by toolUseMap logic", async () => {
    const tel = mockTelemetry();
    const out = collectorStream();
    const stderr = collectorStream();
    const fc = fakeChild([]);

    const routeCalls: Array<import("../core/types.js").Request> = [];
    const pipeline: Pipeline = {
      route: async (req) => {
        routeCalls.push(req);
        return decisionFor("standard");
      },
    };

    const userLine =
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"explain this"}]}}';

    setTimeout(() => fc.close(0), 10);

    await runSdkProxy({
      realClaude: "node",
      claudeArgs: [],
      pipeline,
      profile: balancedProfile,
      userConfig: {},
      telemetry: tel.writer,
      stdin: Readable.from([userLine + "\n"]),
      stdout: out.stream,
      stderr: stderr.stream,
      spawn: fc.spawn,
    });

    // Normal user-text path: prompt passed, no resolvedToolName.
    expect(routeCalls).toHaveLength(1);
    expect(routeCalls[0]!.metadata?.resolvedToolName).toBeUndefined();
    expect(routeCalls[0]!.prompt).toBe("explain this");
  });

  test("pending queue only enqueues user-text messages, not tool_results", async () => {
    // This test verifies that tool_result messages do NOT add to pendingQueue.
    // Only user_text messages should be queued.
    // Sequence: tool_result → tool_result → user_text (all 3 processed, but only 1 queued).
    // Expected: only 1 decision event logged (user_text only), not 3.

    const tel = mockTelemetry();
    const out = collectorStream();
    const stderr = collectorStream();
    const fc = fakeChild([]);

    const pipeline: Pipeline = {
      route: async () => decisionFor("standard"),
    };

    const assistantLine =
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_01","name":"Read","input":{}}]}}';
    const toolResult1 =
      '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01","content":"file 1"}]}}';
    const toolResult2 =
      '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01","content":"file 2"}]}}';
    const userText =
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}';

    const proxyP = runSdkProxy({
      realClaude: "node",
      claudeArgs: [],
      pipeline,
      profile: balancedProfile,
      userConfig: {},
      telemetry: tel.writer,
      stdin: Readable.from([toolResult1 + "\n", toolResult2 + "\n", userText + "\n"]),
      stdout: out.stream,
      stderr: stderr.stream,
      spawn: fc.spawn,
    });

    // Populate toolUseMap, then emit result frames to flush pending telemetry.
    // Three result frames to flush the pending queue after each input.
    fc.emit(assistantLine);
    setTimeout(() => {
      fc.emit('{"type":"result","subtype":"success","total_cost_usd":0}');
      fc.emit('{"type":"result","subtype":"success","total_cost_usd":0}');
      fc.emit('{"type":"result","subtype":"success","total_cost_usd":0}');
      fc.close(0);
    }, 10);
    await proxyP;

    // Only user_text should be in pendingQueue; tool_results do not queue.
    // Tool_result frames route but do not add to queue, so we expect:
    // - 0 events from first result frame (no pending entry for tool_result 1)
    // - 0 events from second result frame (no pending entry for tool_result 2)
    // - 1 event from third result frame (pending entry for user_text)
    // Total: 1 decision event, not 3.
    const decisionEvents = tel.events.filter((e) => e.type === "decision");
    expect(decisionEvents).toHaveLength(1);
    // The decision event should be for the user_text message (has "hello" prompt).
    expect((decisionEvents[0] as { prompt?: string }).prompt).toBe("hello");
  });

  test("I1: strips line-number prefixes from tool result content", async () => {
    const tel = mockTelemetry();
    const out = collectorStream();
    const stderr = collectorStream();
    const fc = fakeChild([]);

    // Simulate a Read tool result with line numbers (e.g., "1\tline 1\n2\tline 2").
    const toolResultWithLineNumbers =
      '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"read-123","content":"1\\timport foo from \\\"bar\\\";\\n2\\texport const x = 1;\\n3\\tconst y = { a: 1 };"}]}}';

    const routeCalls: Array<import("../core/types.js").Request> = [];
    const pipeline: Pipeline = {
      route: async (req) => {
        routeCalls.push(req);
        return decisionFor("trivial");
      },
    };

    const proxyP = runSdkProxy({
      realClaude: "node",
      claudeArgs: [],
      pipeline,
      profile: balancedProfile,
      userConfig: {},
      telemetry: tel.writer,
      stdin: Readable.from([toolResultWithLineNumbers + "\n"]),
      stdout: out.stream,
      stderr: stderr.stream,
      spawn: fc.spawn,
      rtkPresent: false,
    });

    fc.close(0);
    await proxyP;

    // The proxy should have injected set_model and forwarded the tool_result.
    // stdinWrites[0] = set_model, stdinWrites[1] = stripped tool_result
    expect(fc.stdinWrites).toHaveLength(2);

    // Parse the forwarded tool_result frame and verify line numbers are stripped.
    const strippedFrame = JSON.parse(fc.stdinWrites[1]!.trim()) as {
      type: string;
      message: { content: Array<{ type: string; content: string }> };
    };
    expect(strippedFrame.type).toBe("user");

    const toolResultBlock = strippedFrame.message.content.find(
      (b: { type: string }) => b.type === "tool_result",
    ) as { type: string; content: string } | undefined;
    expect(toolResultBlock).toBeDefined();
    expect(toolResultBlock!.content).toBe(
      "import foo from \"bar\";\nexport const x = 1;\nconst y = { a: 1 };",
    );
  });
});
