// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { spawn as nodeSpawn } from "node:child_process";
import type { Writable } from "node:stream";

export type StreamResult = {
  exitCode: number | null;
  /** Full captured stdout. Useful for parsing the trailing --output-format json blob. */
  capturedStdout: string;
};

export type StreamClaudeOptions = {
  binary?: string;
  args: ReadonlyArray<string>;
  prompt: string;
  signal?: AbortSignal;
  /** Where to pipe live subprocess stdout. Defaults to process.stdout. */
  stdout?: Writable;
  /** Where to pipe live subprocess stderr. Defaults to process.stderr. */
  stderr?: Writable;
  /**
   * If true, register a SIGINT handler on the parent process that forwards
   * to the child. Default false in tests; the wrapper CLI sets it true.
   */
  forwardSigint?: boolean;
};

/**
 * Spawn the Claude CLI with streaming stdout/stderr piped to the caller's
 * writers (terminal by default). Captures stdout into capturedStdout for
 * downstream JSON parsing while still streaming to the user. Cleans up
 * abort + SIGINT handlers on completion.
 */
export function streamClaude(opts: StreamClaudeOptions): Promise<StreamResult> {
  return new Promise((resolve, reject) => {
    const binary = opts.binary ?? "claude";
    const outStream: Writable = opts.stdout ?? process.stdout;
    const errStream: Writable = opts.stderr ?? process.stderr;

    const child = nodeSpawn(binary, [...opts.args], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let capturedStdout = "";
    let settled = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      capturedStdout += chunk;
      outStream.write(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      errStream.write(chunk);
    });

    const onAbort = (): void => {
      if (!child.killed) child.kill("SIGTERM");
    };
    const onSigint = (): void => {
      if (!child.killed) child.kill("SIGINT");
    };

    const cleanup = (): void => {
      opts.signal?.removeEventListener("abort", onAbort);
      if (opts.forwardSigint) process.off("SIGINT", onSigint);
    };

    if (opts.signal) {
      if (opts.signal.aborted) {
        onAbort();
      } else {
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }
    }
    if (opts.forwardSigint) {
      process.on("SIGINT", onSigint);
    }

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ exitCode: code, capturedStdout });
    });

    try {
      child.stdin.write(opts.prompt);
      child.stdin.end();
    } catch (err) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err as Error);
    }
  });
}
