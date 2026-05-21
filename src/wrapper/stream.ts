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
  /** Single prompt to write then close stdin. Mutually exclusive with `inheritStdin`. */
  prompt?: string;
  /**
   * If true, the child inherits the parent's stdin directly (no prompt write).
   * Required for `--input-format stream-json` invocations where the parent
   * keeps writing JSON messages over the lifetime of the call (VSCode panel UI).
   */
  inheritStdin?: boolean;
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
      // For stream-json input (VSCode panel UI), inherit parent stdin so the
      // long-lived JSON message stream flows through. Otherwise pipe so we
      // can write a single prompt and close.
      stdio: [opts.inheritStdin ? "inherit" : "pipe", "pipe", "pipe"],
    });

    let capturedStdout = "";
    let settled = false;

    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        capturedStdout += chunk;
        outStream.write(chunk);
      });
    }
    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        errStream.write(chunk);
      });
    }

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

    if (!opts.inheritStdin) {
      try {
        if (child.stdin) {
          child.stdin.write(opts.prompt ?? "");
          child.stdin.end();
        }
      } catch (err) {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err as Error);
      }
    }
  });
}
