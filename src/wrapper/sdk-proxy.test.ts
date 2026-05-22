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
