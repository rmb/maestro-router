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
import type { Pipeline } from "../core/pipeline.js";
import type { Decision, TelemetryEvent } from "../core/types.js";

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
        telemetry: { log: async (e) => { events.push(e); }, logFallback: async () => {}, readAll: async () => events },
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
