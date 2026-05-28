// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  collectCorrectionRows,
  type CorrectionRow,
} from "./export-corrections.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "maestro-export-corrections-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeCorrection(overrides: Partial<{
  prevClass: string;
  correctedToClass: string;
  hint: string;
  prevPrompt: string;
  ts: string;
}> = {}): string {
  return JSON.stringify({
    type: "correction",
    ts: overrides.ts ?? "2026-01-01T00:00:00.000Z",
    sessionId: "sess-abc",
    prevClass: overrides.prevClass ?? "trivial",
    correctedToClass: overrides.correctedToClass ?? "standard",
    hint: overrides.hint ?? "@deep",
    prevPrompt: overrides.prevPrompt ?? "explain this concept in depth",
  });
}

function makeDecision(prompt = "hello"): string {
  return JSON.stringify({
    type: "decision",
    ts: "2026-01-01T00:00:00.000Z",
    prompt,
    decision: { class: "trivial", classifier: "heuristic", confidence: 0.9 },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("collectCorrectionRows — basic shape", () => {
  test("reads correction events and outputs correct shape", async () => {
    const jsonlPath = join(tmpDir, "decisions.jsonl");
    const lines = [
      makeDecision("some prompt"),
      makeCorrection({ prevClass: "trivial", correctedToClass: "standard", hint: "@deep" }),
      makeCorrection({ prevClass: "simple", correctedToClass: "hard", hint: "@think", prevPrompt: "design the auth layer" }),
    ].join("\n") + "\n";
    await writeFile(jsonlPath, lines, "utf8");

    const result = await collectCorrectionRows(jsonlPath, { limit: null, minCount: 1 });

    expect(result.correctionEvents).toBe(2);
    expect(result.totalEvents).toBe(3);
    expect(result.skipped).toBe(0);
    expect(result.rows).toHaveLength(2);

    const first = result.rows[0] as CorrectionRow;
    expect(first.prevClass).toBe("trivial");
    expect(first.correctClass).toBe("standard");
    expect(first.hint).toBe("@deep");
    expect(first.prompt).toBe("explain this concept in depth");
    expect(typeof first.ts).toBe("string");

    const second = result.rows[1] as CorrectionRow;
    expect(second.prevClass).toBe("simple");
    expect(second.correctClass).toBe("hard");
    expect(second.hint).toBe("@think");
  });
});

describe("collectCorrectionRows — --limit flag", () => {
  test("--limit caps output count", async () => {
    const jsonlPath = join(tmpDir, "decisions.jsonl");
    const lines = [
      makeCorrection({ prevPrompt: "prompt one" }),
      makeCorrection({ prevPrompt: "prompt two" }),
      makeCorrection({ prevPrompt: "prompt three" }),
    ].join("\n") + "\n";
    await writeFile(jsonlPath, lines, "utf8");

    const result = await collectCorrectionRows(jsonlPath, { limit: 2, minCount: 1 });

    expect(result.rows).toHaveLength(2);
    expect(result.correctionEvents).toBe(3);
  });
});

describe("collectCorrectionRows — empty telemetry", () => {
  test("returns empty array when no corrections in telemetry", async () => {
    const jsonlPath = join(tmpDir, "decisions.jsonl");
    // Only decision events, no corrections
    const lines = [
      makeDecision("prompt a"),
      makeDecision("prompt b"),
    ].join("\n") + "\n";
    await writeFile(jsonlPath, lines, "utf8");

    const result = await collectCorrectionRows(jsonlPath, { limit: null, minCount: 1 });

    expect(result.rows).toHaveLength(0);
    expect(result.correctionEvents).toBe(0);
    expect(result.totalEvents).toBe(2);
  });

  test("returns empty array when telemetry file does not exist", async () => {
    const jsonlPath = join(tmpDir, "nonexistent.jsonl");
    const result = await collectCorrectionRows(jsonlPath, { limit: null, minCount: 1 });

    expect(result.rows).toHaveLength(0);
    expect(result.totalEvents).toBe(0);
    expect(result.correctionEvents).toBe(0);
    expect(result.skipped).toBe(0);
  });
});

describe("collectCorrectionRows — --min-count filter", () => {
  test("minCount=2 only emits prompts corrected at least twice", async () => {
    const jsonlPath = join(tmpDir, "decisions.jsonl");
    const lines = [
      // "repeated prompt" appears twice
      makeCorrection({ prevPrompt: "repeated prompt", ts: "2026-01-01T00:00:00.000Z" }),
      makeCorrection({ prevPrompt: "repeated prompt", ts: "2026-01-02T00:00:00.000Z" }),
      // "once-only prompt" appears once — should be excluded
      makeCorrection({ prevPrompt: "once-only prompt" }),
    ].join("\n") + "\n";
    await writeFile(jsonlPath, lines, "utf8");

    const result = await collectCorrectionRows(jsonlPath, { limit: null, minCount: 2 });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.prompt).toBe("repeated prompt");
    expect(result.correctionEvents).toBe(3);
  });
});

describe("export-corrections command registration", () => {
  test('"export-corrections" is registered as a subcommand via buildProgram', async () => {
    const { buildProgram } = await import("./index.js");
    const program = await buildProgram();
    const names = program.commands.map((c) => c.name());
    expect(names).toContain("export-corrections");
  });
});
