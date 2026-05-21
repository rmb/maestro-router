// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { Writable } from "node:stream";
import { streamClaude } from "./stream.js";

function collector(): { stream: Writable; buf: string } {
  const ctx = { stream: null as unknown as Writable, buf: "" };
  ctx.stream = new Writable({
    write(chunk, _enc, cb) {
      ctx.buf += chunk.toString();
      cb();
    },
  });
  return ctx as { stream: Writable; buf: string };
}

describe("streamClaude", () => {
  test("pipes stdout to provided writer and captures it", async () => {
    const out = collector();
    const err = collector();
    const result = await streamClaude({
      binary: "node",
      args: ["-e", "process.stdin.on('data', d => process.stdout.write(d))"],
      prompt: "streamed",
      stdout: out.stream,
      stderr: err.stream,
    });
    expect(result.exitCode).toBe(0);
    expect(out.buf).toBe("streamed");
    expect(result.capturedStdout).toBe("streamed");
  });

  test("pipes stderr separately from stdout", async () => {
    const out = collector();
    const err = collector();
    await streamClaude({
      binary: "node",
      args: ["-e", "process.stderr.write('warn')"],
      prompt: "",
      stdout: out.stream,
      stderr: err.stream,
    });
    expect(out.buf).toBe("");
    expect(err.buf).toBe("warn");
  });

  test("captures non-zero exit code without rejecting", async () => {
    const out = collector();
    const err = collector();
    const result = await streamClaude({
      binary: "node",
      args: ["-e", "process.exit(13)"],
      prompt: "",
      stdout: out.stream,
      stderr: err.stream,
    });
    expect(result.exitCode).toBe(13);
  });

  test("rejects on missing binary", async () => {
    const out = collector();
    const err = collector();
    await expect(
      streamClaude({
        binary: "/no-such-binary-xyz",
        args: [],
        prompt: "",
        stdout: out.stream,
        stderr: err.stream,
      }),
    ).rejects.toBeInstanceOf(Error);
  });

  test("honors AbortSignal", async () => {
    const out = collector();
    const err = collector();
    const ac = new AbortController();
    const promise = streamClaude({
      binary: "node",
      args: ["-e", "setTimeout(() => {}, 30000)"],
      prompt: "",
      stdout: out.stream,
      stderr: err.stream,
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 50);
    const result = await promise;
    expect(result.exitCode).not.toBe(0);
  });

  test("pre-aborted signal kills before run", async () => {
    const out = collector();
    const err = collector();
    const ac = new AbortController();
    ac.abort();
    const result = await streamClaude({
      binary: "node",
      args: ["-e", "setTimeout(() => {}, 10000)"],
      prompt: "",
      stdout: out.stream,
      stderr: err.stream,
      signal: ac.signal,
    });
    expect(result.exitCode).not.toBe(0);
  });

  test("streams large output incrementally", async () => {
    const chunks: number[] = [];
    const out = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(chunk.length);
        cb();
      },
    });
    const err = collector();
    await streamClaude({
      binary: "node",
      args: [
        "-e",
        "let i=0; const t=setInterval(()=>{process.stdout.write('x'.repeat(1000)); if(++i>=3){clearInterval(t); process.exit(0)}},10)",
      ],
      prompt: "",
      stdout: out,
      stderr: err.stream,
    });
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    const total = chunks.reduce((s, n) => s + n, 0);
    expect(total).toBe(3000);
  });
});
