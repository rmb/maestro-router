// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { PassThrough, Writable } from "node:stream";
import { balancedProfile } from "../core/profile.js";
import type { Pipeline } from "../core/pipeline.js";
import type { Decision, TelemetryEvent } from "../core/types.js";
import type { TelemetryWriter } from "../core/telemetry.js";
import type { SdkProxySpawn } from "./sdk-proxy.js";
import { runShellHost } from "./sdk-host.js";

function collector(): { stream: Writable; lines: string[]; text: () => string } {
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
  return { stream, lines, text: () => lines.join("\n") + buf };
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
  return { events, writer: { log: async (e) => { events.push(e); }, logFallback: async () => {}, readAll: async () => events } };
};

type FakeClaudeOpts = {
  /** Emit a can_use_tool request before the assistant reply; waits for approval. */
  toolRequest?: boolean;
  /** Emit a second can_use_tool for the same tool after the first approval. */
  twoToolRequests?: boolean;
};

/**
 * Scripted fake `claude` that speaks the stream-json control protocol:
 * answers the initialize handshake, echoes user text as an assistant frame,
 * and emits a result frame with usage. When toolRequest is true, emits a
 * can_use_tool request and waits for the approval control_response before
 * continuing — accurately modeling the real claude protocol.
 */
function fakeClaude(opts: FakeClaudeOpts = {}): {
  spawn: SdkProxySpawn;
  stdinFrames: Array<Record<string, unknown>>;
} {
  const stdinFrames: Array<Record<string, unknown>> = [];
  let stdoutListener: ((chunk: Buffer) => void) | null = null;
  let closeListener: ((code: number) => void) | null = null;
  // Resolves when the host sends a control_response to a pending tool request.
  let pendingToolApprovalResolve: (() => void) | null = null;
  let toolRequestCount = 0;

  const emit = (obj: unknown): void => {
    queueMicrotask(() => stdoutListener?.(Buffer.from(JSON.stringify(obj) + "\n")));
  };

  const replyToUser = (text: string): void => {
    emit({ type: "assistant", message: { model: "claude-haiku-4-5-20251001", content: [{ type: "text", text: `echo: ${text}` }] } });
    emit({
      type: "result",
      subtype: "success",
      duration_ms: 1200,
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    });
  };

  const child = {
    stdin: {
      write: (s: string): boolean => {
        for (const line of s.split("\n")) {
          if (!line.trim()) continue;
          let frame: Record<string, unknown>;
          try { frame = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
          stdinFrames.push(frame);

          const req = frame["request"] as { subtype?: string } | undefined;
          if (frame["type"] === "control_request" && req?.subtype === "initialize") {
            emit({ type: "control_response", response: { request_id: frame["request_id"], subtype: "success" } });
            continue;
          }

          // Host's tool approval response — release the pending Promise.
          if (frame["type"] === "control_response") {
            if (pendingToolApprovalResolve) {
              pendingToolApprovalResolve();
              pendingToolApprovalResolve = null;
            }
            continue;
          }

          const msg = frame["message"] as { content?: Array<{ type: string; text?: string }> } | undefined;
          const isUserText =
            frame["type"] === "user" &&
            Array.isArray(msg?.content) &&
            msg!.content.some((b) => b.type === "text");

          if (isUserText) {
            const text = msg!.content.find((b) => b.type === "text")!.text ?? "";
            if (opts.toolRequest && toolRequestCount < (opts.twoToolRequests ? 2 : 1)) {
              const seq = ++toolRequestCount;
              emit({ type: "control_request", request_id: `tool-${seq}`, request: { subtype: "can_use_tool", tool_name: "Bash" } });
              // Emit a second request immediately after the first when twoToolRequests.
              if (opts.twoToolRequests && seq === 1) {
                new Promise<void>(resolve => { pendingToolApprovalResolve = resolve; }).then(() => {
                  emit({ type: "control_request", request_id: "tool-2", request: { subtype: "can_use_tool", tool_name: "Bash" } });
                  new Promise<void>(resolve2 => { pendingToolApprovalResolve = resolve2; }).then(() => replyToUser(text));
                });
              } else {
                new Promise<void>(resolve => { pendingToolApprovalResolve = resolve; }).then(() => replyToUser(text));
              }
            } else {
              replyToUser(text);
            }
          }
        }
        return true;
      },
      end: (): void => { queueMicrotask(() => closeListener?.(0)); },
    },
    stdout: {
      on: (ev: string, fn: (chunk: Buffer) => void): void => { if (ev === "data") stdoutListener = fn; },
      setEncoding: (): void => {},
    },
    stderr: { on: (): void => {}, setEncoding: (): void => {} },
    on: (ev: string, fn: (code: number) => void): void => { if (ev === "close") closeListener = fn; },
    kill: (): void => {},
  };

  return { spawn: () => child as unknown as ReturnType<SdkProxySpawn>, stdinFrames };
}

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("runShellHost", () => {
  test("completes the handshake, routes a turn, renders echo + savings HUD, exits clean", async () => {
    const fc = fakeClaude();
    const tel = mockTelemetry();
    const out = collector();
    const err = collector();
    const input = new PassThrough();

    const hostPromise = runShellHost({
      realClaude: "fake",
      claudeArgs: ["--print"],
      pipeline: mockPipeline("trivial"),
      profile: balancedProfile,
      userConfig: {},
      telemetry: tel.writer,
      input,
      output: out.stream,
      errput: err.stream,
      spawn: fc.spawn,
      color: false,
    });

    // Wait for the handshake to open the prompt.
    await waitFor(() => out.text().includes("routing: auto"));
    input.write("explain recursion\n");

    // Wait for the per-turn savings HUD.
    await waitFor(() => out.text().includes("saved"));
    input.write("/exit\n");

    const code = await hostPromise;
    expect(code).toBe(0);

    // Host sent the initialize control_request first.
    expect(fc.stdinFrames[0]).toMatchObject({
      type: "control_request",
      request: { subtype: "initialize" },
    });
    // Proxy injected set_model (trivial → haiku) before the user frame.
    const setModel = fc.stdinFrames.find(
      (f) => (f["request"] as { subtype?: string } | undefined)?.subtype === "set_model",
    );
    expect((setModel?.["request"] as { model?: string })?.model).toBe("haiku");

    // Assistant text rendered, HUD shows the haiku badge with high savings.
    expect(out.text()).toContain("echo: explain recursion");
    expect(out.text()).toMatch(/\[haiku · 1\.2s · \$0\.\d+ · saved \d+%\]/);
    const m = out.text().match(/saved (\d+)%\]/);
    expect(Number(m?.[1])).toBeGreaterThan(80);

    // Telemetry captured the turn.
    expect(tel.events.some((e) => e.type === "decision")).toBe(true);
  });

  test("tool approval: 'y' sends allow control_response and turn completes", async () => {
    const fc = fakeClaude({ toolRequest: true });
    const tel = mockTelemetry();
    const out = collector();
    const err = collector();
    const input = new PassThrough();

    const hostPromise = runShellHost({
      realClaude: "fake",
      claudeArgs: ["--print"],
      pipeline: mockPipeline("trivial"),
      profile: balancedProfile,
      userConfig: {},
      telemetry: tel.writer,
      input,
      output: out.stream,
      errput: err.stream,
      spawn: fc.spawn,
      color: false,
    });

    await waitFor(() => out.text().includes("routing: auto"));
    input.write("run the tests\n");

    // Wait for the tool approval prompt.
    await waitFor(() => out.text().includes('allow tool "Bash"'));
    input.write("y\n");

    // Turn completes after approval.
    await waitFor(() => out.text().includes("saved"));
    input.write("/exit\n");
    await hostPromise;

    // An allow control_response was sent to the child.
    const allow = fc.stdinFrames.find(
      (f) =>
        f["type"] === "control_response" &&
        (f["response"] as { response?: { behavior?: string } } | undefined)?.response?.behavior ===
          "allow",
    );
    expect(allow).toBeDefined();
  });

  test("tool approval: 'n' sends deny control_response", async () => {
    const fc = fakeClaude({ toolRequest: true });
    const tel = mockTelemetry();
    const out = collector();
    const err = collector();
    const input = new PassThrough();

    const hostPromise = runShellHost({
      realClaude: "fake",
      claudeArgs: ["--print"],
      pipeline: mockPipeline("trivial"),
      profile: balancedProfile,
      userConfig: {},
      telemetry: tel.writer,
      input,
      output: out.stream,
      errput: err.stream,
      spawn: fc.spawn,
      color: false,
    });

    await waitFor(() => out.text().includes("routing: auto"));
    input.write("run the tests\n");
    await waitFor(() => out.text().includes('allow tool "Bash"'));
    input.write("n\n");

    await waitFor(() => out.text().includes("saved"));
    input.write("/exit\n");
    await hostPromise;

    const denial = fc.stdinFrames.find(
      (f) =>
        f["type"] === "control_response" &&
        (f["response"] as { response?: { behavior?: string } } | undefined)?.response?.behavior ===
          "deny",
    );
    expect(denial).toBeDefined();
  });

  test("tool approval: 'always' auto-approves the second request for the same tool", async () => {
    const fc = fakeClaude({ toolRequest: true, twoToolRequests: true });
    const tel = mockTelemetry();
    const out = collector();
    const err = collector();
    const input = new PassThrough();

    const hostPromise = runShellHost({
      realClaude: "fake",
      claudeArgs: ["--print"],
      pipeline: mockPipeline("trivial"),
      profile: balancedProfile,
      userConfig: {},
      telemetry: tel.writer,
      input,
      output: out.stream,
      errput: err.stream,
      spawn: fc.spawn,
      color: false,
    });

    await waitFor(() => out.text().includes("routing: auto"));
    input.write("run the tests\n");

    // First prompt: answer "always".
    await waitFor(() => out.text().includes('allow tool "Bash"'));
    input.write("always\n");

    // Turn completes — the second request was auto-approved (no second prompt).
    await waitFor(() => out.text().includes("saved"), 4000);
    input.write("/exit\n");
    await hostPromise;

    // Two allow control_responses were sent (first explicit, second auto).
    const allowFrames = fc.stdinFrames.filter(
      (f) =>
        f["type"] === "control_response" &&
        (f["response"] as { response?: { behavior?: string } } | undefined)?.response?.behavior ===
          "allow",
    );
    expect(allowFrames.length).toBe(2);
  });

  test("/why shows last routing decision after a turn", async () => {
    const fc = fakeClaude();
    const tel = mockTelemetry();
    const out = collector();
    const err = collector();
    const input = new PassThrough();

    const hostPromise = runShellHost({
      realClaude: "fake",
      claudeArgs: ["--print"],
      pipeline: mockPipeline("trivial"),
      profile: balancedProfile,
      userConfig: {},
      telemetry: tel.writer,
      input,
      output: out.stream,
      errput: err.stream,
      spawn: fc.spawn,
      color: false,
    });

    await waitFor(() => out.text().includes("routing: auto"));
    input.write("hello\n");
    await waitFor(() => out.text().includes("saved"));

    input.write("/why\n");
    await waitFor(() => out.text().includes("last route:"));

    expect(out.text()).toContain("trivial");
    expect(out.text()).toContain("haiku");

    input.write("/exit\n");
    await hostPromise;
  });

  test("/why before any turns reports no decisions", async () => {
    const fc = fakeClaude();
    const tel = mockTelemetry();
    const out = collector();
    const input = new PassThrough();

    const hostPromise = runShellHost({
      realClaude: "fake",
      claudeArgs: ["--print"],
      pipeline: mockPipeline("trivial"),
      profile: balancedProfile,
      userConfig: {},
      telemetry: tel.writer,
      input,
      output: out.stream,
      spawn: fc.spawn,
      color: false,
    });

    await waitFor(() => out.text().includes("routing: auto"));
    input.write("/why\n");
    await waitFor(() => out.text().includes("no routing decisions"));

    input.write("/exit\n");
    await hostPromise;
  });

  test("/pin haiku forces trivial class on next turn", async () => {
    // Pipeline returns standard by default; /pin haiku should override.
    const fc = fakeClaude();
    const tel = mockTelemetry();
    const out = collector();
    const input = new PassThrough();

    const hostPromise = runShellHost({
      realClaude: "fake",
      claudeArgs: ["--print"],
      pipeline: mockPipeline("standard"),
      profile: balancedProfile,
      userConfig: {},
      telemetry: tel.writer,
      input,
      output: out.stream,
      spawn: fc.spawn,
      color: false,
    });

    await waitFor(() => out.text().includes("routing: auto"));

    input.write("/pin haiku\n");
    await waitFor(() => out.text().includes("pinned: trivial"));

    input.write("hello\n");
    await waitFor(() => out.text().includes("saved"));

    // Proxy should have injected haiku (trivial class), not sonnet.
    const setModels = fc.stdinFrames.filter(
      (f) => (f["request"] as { subtype?: string } | undefined)?.subtype === "set_model",
    );
    const models = setModels.map((f) => (f["request"] as { model?: string })?.model);
    expect(models).toContain("haiku");
    expect(models).not.toContain("sonnet");

    input.write("/exit\n");
    await hostPromise;
  });

  test("/pin off restores auto routing", async () => {
    const fc = fakeClaude();
    const tel = mockTelemetry();
    const out = collector();
    const input = new PassThrough();

    const hostPromise = runShellHost({
      realClaude: "fake",
      claudeArgs: ["--print"],
      pipeline: mockPipeline("standard"),
      profile: balancedProfile,
      userConfig: {},
      telemetry: tel.writer,
      input,
      output: out.stream,
      spawn: fc.spawn,
      color: false,
    });

    await waitFor(() => out.text().includes("routing: auto"));

    input.write("/pin haiku\n");
    await waitFor(() => out.text().includes("pinned:"));

    input.write("/pin off\n");
    await waitFor(() => out.text().includes("unpinned:"));

    input.write("hello\n");
    await waitFor(() => out.text().includes("saved"));

    // After unpin, the pipeline's decision (standard → sonnet) is used.
    const setModels = fc.stdinFrames.filter(
      (f) => (f["request"] as { subtype?: string } | undefined)?.subtype === "set_model",
    );
    const models = setModels.map((f) => (f["request"] as { model?: string })?.model);
    expect(models).toContain("sonnet");

    input.write("/exit\n");
    await hostPromise;
  });

  test("/status shows session stats after a turn", async () => {
    const fc = fakeClaude();
    const tel = mockTelemetry();
    const out = collector();
    const input = new PassThrough();

    const hostPromise = runShellHost({
      realClaude: "fake",
      claudeArgs: ["--print"],
      pipeline: mockPipeline("trivial"),
      profile: balancedProfile,
      userConfig: {},
      telemetry: tel.writer,
      input,
      output: out.stream,
      spawn: fc.spawn,
      color: false,
    });

    await waitFor(() => out.text().includes("routing: auto"));
    input.write("hello\n");
    await waitFor(() => out.text().includes("saved"));

    input.write("/status\n");
    await waitFor(() => out.text().includes("routing: auto"));

    // Should mention the turn count.
    expect(out.text()).toMatch(/1 turn/);

    input.write("/exit\n");
    await hostPromise;
  });
});
