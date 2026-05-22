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
import type { Pipeline } from "../core/pipeline.js";
import type { TelemetryWriter } from "../core/telemetry.js";
import { PROMPT_TRUNCATE_CHARS } from "../core/types.js";
import type { Decision, Profile, UserConfig } from "../core/types.js";
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
  let exitCode = 0;

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
