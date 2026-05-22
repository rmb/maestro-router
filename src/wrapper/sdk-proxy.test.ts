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

// `vi` is referenced for parity with future expansion; keep import live.
void vi;
