// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { Command } from "commander";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Class } from "../core/types.js";
import { collectRows, registerExportPromptsCommand } from "./export-prompts.js";

type DecisionLine = {
  type: "decision";
  ts: string;
  prompt?: string;
  decision: { class: Class; classifier?: string; confidence?: number };
};

function decisionLine(opts: Partial<DecisionLine> & { decisionClass: Class; ts: string }): string {
  const obj: DecisionLine = {
    type: "decision",
    ts: opts.ts,
    decision: { class: opts.decisionClass },
  };
  if (opts.prompt !== undefined) obj.prompt = opts.prompt;
  return JSON.stringify(obj);
}

async function writeJsonl(path: string, lines: ReadonlyArray<string>): Promise<void> {
  await writeFile(path, lines.join("\n") + "\n", "utf8");
}

async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "maestro-export-"));
}

describe("collectRows", () => {
  let dir = "";
  let telemetryPath = "";

  beforeEach(async () => {
    dir = await tmpDir();
    telemetryPath = join(dir, "decisions.jsonl");
  });

  afterEach(() => {
    dir = "";
  });

  test("filters out decision events without a prompt field", async () => {
    await writeJsonl(telemetryPath, [
      decisionLine({ ts: "2026-05-22T00:00:00Z", decisionClass: "trivial" }),
      decisionLine({
        ts: "2026-05-22T00:00:01Z",
        decisionClass: "simple",
        prompt: "format this file",
      }),
    ]);
    const r = await collectRows(telemetryPath, { dedupe: true, limit: null });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.prompt).toBe("format this file");
    expect(r.rows[0]?.expectedClass).toBe("simple");
    expect(r.rows[0]?.decidedClass).toBe("simple");
    expect(r.rows[0]?.source).toBe("telemetry-export");
  });

  test("filters out non-decision events and malformed JSON", async () => {
    await writeJsonl(telemetryPath, [
      JSON.stringify({
        type: "override",
        ts: "2026-05-22T00:00:00Z",
        from: "simple",
        to: "hard",
        prompt: "do the thing",
      }),
      JSON.stringify({
        type: "feedback",
        ts: "2026-05-22T00:00:01Z",
        sessionId: "s1",
        rating: 5,
      }),
      "{not valid json",
      decisionLine({
        ts: "2026-05-22T00:00:02Z",
        decisionClass: "hard",
        prompt: "design the cache layer",
      }),
    ]);
    const r = await collectRows(telemetryPath, { dedupe: true, limit: null });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.prompt).toBe("design the cache layer");
    expect(r.skipped).toBe(1);
  });

  test("deduplicates by prompt text by default", async () => {
    await writeJsonl(telemetryPath, [
      decisionLine({ ts: "2026-05-22T00:00:00Z", decisionClass: "trivial", prompt: "rename foo" }),
      decisionLine({ ts: "2026-05-22T00:00:01Z", decisionClass: "simple", prompt: "rename foo" }),
      decisionLine({
        ts: "2026-05-22T00:00:02Z",
        decisionClass: "hard",
        prompt: "rewrite parser",
      }),
    ]);
    const r = await collectRows(telemetryPath, { dedupe: true, limit: null });
    expect(r.rows).toHaveLength(2);
    expect(r.rows.map((x) => x.prompt)).toEqual(["rename foo", "rewrite parser"]);
  });

  test("keepDuplicates disables dedupe", async () => {
    await writeJsonl(telemetryPath, [
      decisionLine({ ts: "2026-05-22T00:00:00Z", decisionClass: "trivial", prompt: "rename foo" }),
      decisionLine({ ts: "2026-05-22T00:00:01Z", decisionClass: "simple", prompt: "rename foo" }),
    ]);
    const r = await collectRows(telemetryPath, { dedupe: false, limit: null });
    expect(r.rows).toHaveLength(2);
  });

  test("limit caps the output count", async () => {
    await writeJsonl(telemetryPath, [
      decisionLine({ ts: "2026-05-22T00:00:00Z", decisionClass: "trivial", prompt: "a" }),
      decisionLine({ ts: "2026-05-22T00:00:01Z", decisionClass: "simple", prompt: "b" }),
      decisionLine({ ts: "2026-05-22T00:00:02Z", decisionClass: "hard", prompt: "c" }),
    ]);
    const r = await collectRows(telemetryPath, { dedupe: true, limit: 2 });
    expect(r.rows).toHaveLength(2);
    expect(r.rows.map((x) => x.prompt)).toEqual(["a", "b"]);
  });

  test("missing telemetry file returns empty result", async () => {
    const r = await collectRows(join(dir, "does-not-exist.jsonl"), {
      dedupe: true,
      limit: null,
    });
    expect(r.rows).toHaveLength(0);
    expect(r.totalEvents).toBe(0);
  });
});

describe("export-prompts CLI", () => {
  let dir = "";
  let telemetryPath = "";
  let outputPath = "";
  let configPath = "";

  beforeEach(async () => {
    dir = await tmpDir();
    telemetryPath = join(dir, "decisions.jsonl");
    outputPath = join(dir, "out.jsonl");
    configPath = join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({ telemetryPath }), "utf8");
  });

  afterEach(() => {
    dir = "";
    vi.restoreAllMocks();
  });

  function makeProgram(): Command {
    const program = new Command();
    program
      .name("maestro")
      .option("-q, --quiet", "suppress informational output")
      .option("--json", "JSON output")
      .option("--config <path>", "config override")
      .exitOverride();
    registerExportPromptsCommand(program);
    return program;
  }

  test("writes JSONL with expected shape to --output", async () => {
    await writeJsonl(telemetryPath, [
      decisionLine({
        ts: "2026-05-22T00:00:00Z",
        decisionClass: "trivial",
        prompt: "rename foo",
      }),
      decisionLine({
        ts: "2026-05-22T00:00:01Z",
        decisionClass: "simple",
        prompt: "format this file",
      }),
      decisionLine({
        ts: "2026-05-22T00:00:02Z",
        decisionClass: "hard",
        prompt: "design the cache layer",
      }),
    ]);

    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const program = makeProgram();
    await program.parseAsync(
      ["--config", configPath, "export-prompts", "--output", outputPath],
      { from: "user" },
    );

    const written = await readFile(outputPath, "utf8");
    const lines = written.split("\n").filter(Boolean);
    expect(lines).toHaveLength(3);
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    for (const row of parsed) {
      expect(row).toHaveProperty("prompt");
      expect(row).toHaveProperty("expectedClass");
      expect(row).toHaveProperty("decidedClass");
      expect(row).toHaveProperty("ts");
      expect(row.source).toBe("telemetry-export");
      expect(row.expectedClass).toBe(row.decidedClass);
    }

    const summary = stderrWrite.mock.calls.map((c) => String(c[0])).join("");
    // Summary counts add up to wrote count.
    expect(summary).toContain("wrote");
    expect(summary).toContain("3");
    // Per-class breakdown mentions every class that has at least one row.
    expect(summary).toMatch(/1 trivial/);
    expect(summary).toMatch(/1 simple/);
    expect(summary).toMatch(/1 hard/);
  });

  test("--keep-duplicates flag preserves duplicates", async () => {
    await writeJsonl(telemetryPath, [
      decisionLine({ ts: "2026-05-22T00:00:00Z", decisionClass: "trivial", prompt: "x" }),
      decisionLine({ ts: "2026-05-22T00:00:01Z", decisionClass: "simple", prompt: "x" }),
    ]);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const program = makeProgram();
    await program.parseAsync(
      [
        "--config",
        configPath,
        "export-prompts",
        "--output",
        outputPath,
        "--keep-duplicates",
      ],
      { from: "user" },
    );
    const lines = (await readFile(outputPath, "utf8")).split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
  });

  test("--limit caps emitted prompts", async () => {
    await writeJsonl(telemetryPath, [
      decisionLine({ ts: "2026-05-22T00:00:00Z", decisionClass: "trivial", prompt: "a" }),
      decisionLine({ ts: "2026-05-22T00:00:01Z", decisionClass: "simple", prompt: "b" }),
      decisionLine({ ts: "2026-05-22T00:00:02Z", decisionClass: "hard", prompt: "c" }),
    ]);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const program = makeProgram();
    await program.parseAsync(
      [
        "--config",
        configPath,
        "export-prompts",
        "--output",
        outputPath,
        "--limit",
        "1",
      ],
      { from: "user" },
    );
    const lines = (await readFile(outputPath, "utf8")).split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
  });
});
