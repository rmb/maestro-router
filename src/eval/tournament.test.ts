// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { balancedProfile } from "../core/profile.js";
import type { Class, ClassSpec } from "../core/types.js";
import {
  buildJudgeArgs,
  buildProposedHeuristics,
  buildResponseArgs,
  DOWNGRADE,
  JUDGE_JSON_SCHEMA,
  JUDGE_PROMPT_TEMPLATE,
  JUDGE_SYSTEM_PROMPT,
  runTournament,
  type TournamentInput,
  type TournamentRowResult,
  type TournamentSpawn,
  type TournamentSpawnResult,
} from "./tournament.js";

type Call = {
  args: ReadonlyArray<string>;
  input: string;
  timeoutMs: number;
};

type MockSpawn = TournamentSpawn & { calls: Call[] };

function envelope(result: unknown, costUsd = 0.05): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    total_cost_usd: costUsd,
    result: typeof result === "string" ? result : JSON.stringify(result),
  });
}

function judgeEnvelope(winner: "A" | "B" | "tie", reason = "ok", costUsd = 0.02): string {
  return envelope({ winner, reason }, costUsd);
}

/**
 * Claude CLI ≥ 2.1.x envelope shape: --json-schema output goes in
 * `structured_output`, leaving `result` empty. Mirrors the shape we
 * observed in production tournament runs (commit f9d3474).
 */
function judgeEnvelopeStructuredOutput(
  winner: "A" | "B" | "tie",
  reason = "ok",
  costUsd = 0.02,
): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    total_cost_usd: costUsd,
    result: "",
    structured_output: { winner, reason },
  });
}

function ok(stdout: string): TournamentSpawnResult {
  return { stdout, exitCode: 0, timedOut: false };
}

function getSpec(c: Class): ClassSpec {
  return balancedProfile.classes[c];
}

/**
 * Build a mock spawn from a scripted list of responses keyed by call order.
 * Tournament order per row is: A, B, judge.
 */
function makeMockSpawn(
  responses: ReadonlyArray<TournamentSpawnResult | (() => TournamentSpawnResult)>,
): MockSpawn {
  const calls: Call[] = [];
  let idx = 0;
  const fn = (async (args, opts) => {
    calls.push({ args, input: opts.input, timeoutMs: opts.timeoutMs });
    const r = responses[idx++];
    if (r === undefined) {
      throw new Error(`mock spawn exhausted after ${idx} calls`);
    }
    return typeof r === "function" ? r() : r;
  }) as MockSpawn;
  fn.calls = calls;
  return fn;
}

describe("runTournament — skip semantics", () => {
  test("trivial input is skipped with reason 'no cheaper tier'", async () => {
    const spawn = makeMockSpawn([]); // never called
    const report = await runTournament(
      [{ prompt: "rename foo", currentClass: "trivial", currentSpec: getSpec("trivial") }],
      { spawn, getSpec },
    );
    expect(report.rows).toHaveLength(1);
    const row = report.rows[0]!;
    expect(row.skipped).toBe(true);
    expect(row.skipReason).toBe("no cheaper tier");
    expect(row.downgradedClass).toBeNull();
    expect(spawn.calls).toHaveLength(0);
    expect(report.skipped).toBe(1);
    expect(report.ran).toBe(0);
  });

  test("DOWNGRADE map is complete and one tier cheaper", () => {
    expect(DOWNGRADE.trivial).toBeNull();
    expect(DOWNGRADE.simple).toBe("trivial");
    expect(DOWNGRADE.standard).toBe("simple");
    expect(DOWNGRADE.hard).toBe("standard");
    expect(DOWNGRADE.reasoning).toBe("hard");
    expect(DOWNGRADE.max).toBe("reasoning");
  });
});

describe("runTournament — verdicts", () => {
  test("A wins → recommendDowngrade false, judgeVerdict A_wins", async () => {
    const spawn = makeMockSpawn([
      ok(envelope("response A")),
      ok(envelope("response B")),
      ok(judgeEnvelope("A", "A is more correct")),
    ]);
    const report = await runTournament(
      [{ prompt: "design a cache", currentClass: "standard", currentSpec: getSpec("standard") }],
      { spawn, getSpec },
    );
    const row = report.rows[0]!;
    expect(row.skipped).toBe(false);
    expect(row.judgeVerdict).toBe("A_wins");
    expect(row.recommendDowngrade).toBe(false);
    expect(row.judgeReason).toBe("A is more correct");
  });

  test("B wins → recommendDowngrade true, judgeVerdict B_wins", async () => {
    const spawn = makeMockSpawn([
      ok(envelope("response A")),
      ok(envelope("response B")),
      ok(judgeEnvelope("B", "B is just as good")),
    ]);
    const report = await runTournament(
      [{ prompt: "add a docstring", currentClass: "simple", currentSpec: getSpec("simple") }],
      { spawn, getSpec },
    );
    const row = report.rows[0]!;
    expect(row.judgeVerdict).toBe("B_wins");
    expect(row.recommendDowngrade).toBe(true);
  });

  test("tie → recommendDowngrade true (cheaper tier tie = cost win)", async () => {
    const spawn = makeMockSpawn([
      ok(envelope("response A")),
      ok(envelope("response B")),
      ok(judgeEnvelope("tie", "equivalent")),
    ]);
    const report = await runTournament(
      [{ prompt: "format file", currentClass: "simple", currentSpec: getSpec("simple") }],
      { spawn, getSpec },
    );
    const row = report.rows[0]!;
    expect(row.judgeVerdict).toBe("tie");
    expect(row.recommendDowngrade).toBe(true);
  });

  test("structured_output payload (CLI ≥ 2.1.x) is read correctly", async () => {
    // Regression: real-money tournament run on 2026-05-22 produced
    // judge_failed on every row because Claude CLI now routes
    // --json-schema results to `structured_output` instead of `result`.
    const spawn = makeMockSpawn([
      ok(envelope("response A")),
      ok(envelope("response B")),
      ok(judgeEnvelopeStructuredOutput("B", "downgrade safe")),
    ]);
    const report = await runTournament(
      [{ prompt: "add a comment", currentClass: "simple", currentSpec: getSpec("simple") }],
      { spawn, getSpec },
    );
    const row = report.rows[0]!;
    expect(row.judgeVerdict).toBe("B_wins");
    expect(row.judgeReason).toBe("downgrade safe");
    expect(row.recommendDowngrade).toBe(true);
  });
});

describe("runTournament — failure modes", () => {
  test("A spawn fails → row skipped with reason a_failed, no judge call", async () => {
    const spawn = makeMockSpawn([
      { stdout: "", exitCode: 1, timedOut: false },
    ]);
    const report = await runTournament(
      [{ prompt: "x", currentClass: "simple", currentSpec: getSpec("simple") }],
      { spawn, getSpec },
    );
    const row = report.rows[0]!;
    expect(row.skipped).toBe(true);
    expect(row.skipReason).toBe("a_failed");
    expect(spawn.calls).toHaveLength(1); // only A attempted
  });

  test("B spawn fails → row skipped with reason b_failed, A cost still recorded", async () => {
    const spawn = makeMockSpawn([
      ok(envelope("response A", 0.05)),
      { stdout: "", exitCode: 2, timedOut: false },
    ]);
    const report = await runTournament(
      [{ prompt: "x", currentClass: "simple", currentSpec: getSpec("simple") }],
      { spawn, getSpec },
    );
    const row = report.rows[0]!;
    expect(row.skipped).toBe(true);
    expect(row.skipReason).toBe("b_failed");
    expect(row.costAUsd).toBe(0.05);
    expect(spawn.calls).toHaveLength(2); // A + B; no judge
  });

  test("judge timeout → judgeVerdict judge_failed, skipped false, no recommendDowngrade", async () => {
    const spawn = makeMockSpawn([
      ok(envelope("A")),
      ok(envelope("B")),
      { stdout: "", exitCode: null, timedOut: true },
    ]);
    const report = await runTournament(
      [{ prompt: "x", currentClass: "simple", currentSpec: getSpec("simple") }],
      { spawn, getSpec },
    );
    const row = report.rows[0]!;
    expect(row.skipped).toBe(false);
    expect(row.judgeVerdict).toBe("judge_failed");
    expect(row.recommendDowngrade).toBeUndefined();
  });

  test("A spawn throws → row skipped with reason a_failed", async () => {
    const spawn = makeMockSpawn([
      () => {
        throw new Error("ENOENT");
      },
    ]);
    const report = await runTournament(
      [{ prompt: "x", currentClass: "simple", currentSpec: getSpec("simple") }],
      { spawn, getSpec },
    );
    expect(report.rows[0]!.skipped).toBe(true);
    expect(report.rows[0]!.skipReason).toBe("a_failed");
  });
});

describe("runTournament — budget cap", () => {
  test("budgetCap=$0.10 with $0.05/call → first row runs, third+ marked budget_cap_reached", async () => {
    // Each row spends $0.05 A + $0.05 B + $0.02 judge = $0.12 per row.
    // After row 1, totalCost = 0.12 > 0.10 cap. Row 2+ should be aborted.
    const spawn = makeMockSpawn([
      ok(envelope("A", 0.05)),
      ok(envelope("B", 0.05)),
      ok(judgeEnvelope("B", "ok", 0.02)),
    ]);
    const inputs: TournamentInput[] = [
      { prompt: "p1", currentClass: "simple", currentSpec: getSpec("simple") },
      { prompt: "p2", currentClass: "simple", currentSpec: getSpec("simple") },
      { prompt: "p3", currentClass: "simple", currentSpec: getSpec("simple") },
    ];
    const report = await runTournament(inputs, { spawn, getSpec, budgetCapUsd: 0.1 });
    expect(report.rows[0]!.skipped).toBe(false);
    expect(report.rows[1]!.skipped).toBe(true);
    expect(report.rows[1]!.skipReason).toBe("budget_cap_reached");
    expect(report.rows[2]!.skipped).toBe(true);
    expect(report.rows[2]!.skipReason).toBe("budget_cap_reached");
    // No spawn calls beyond row 1's three.
    expect(spawn.calls).toHaveLength(3);
  });
});

describe("runTournament — pattern mining", () => {
  test("3 rows in same simple→trivial group sharing 'docstring' → recommended", async () => {
    const spawn = makeMockSpawn([
      ok(envelope("A")),
      ok(envelope("B")),
      ok(judgeEnvelope("B", "shorter is fine")),
      ok(envelope("A")),
      ok(envelope("B")),
      ok(judgeEnvelope("B", "trivial change")),
      ok(envelope("A")),
      ok(envelope("B")),
      ok(judgeEnvelope("tie", "equivalent")),
    ]);
    const report = await runTournament(
      [
        {
          prompt: "add a docstring to foo",
          currentClass: "simple",
          currentSpec: getSpec("simple"),
        },
        {
          prompt: "update the docstring for bar",
          currentClass: "simple",
          currentSpec: getSpec("simple"),
        },
        {
          prompt: "write a docstring header",
          currentClass: "simple",
          currentSpec: getSpec("simple"),
        },
      ],
      { spawn, getSpec },
    );
    const docstring = report.recommendedDowngrades.find(
      (r) => r.promptPattern === "\\bdocstring\\b",
    );
    expect(docstring).toBeDefined();
    expect(docstring!.from).toBe("simple");
    expect(docstring!.to).toBe("trivial");
    expect(docstring!.matchedCount).toBe(3);
    expect(typeof docstring!.sampleReason).toBe("string");
  });

  test("group with <3 occurrences yields no recommendation", async () => {
    const spawn = makeMockSpawn([
      ok(envelope("A")),
      ok(envelope("B")),
      ok(judgeEnvelope("B")),
    ]);
    const report = await runTournament(
      [{ prompt: "rare token here", currentClass: "simple", currentSpec: getSpec("simple") }],
      { spawn, getSpec },
    );
    expect(report.recommendedDowngrades).toHaveLength(0);
  });

  test("buildProposedHeuristics maps recommendations to HeuristicRule[]", () => {
    const rules = buildProposedHeuristics([
      {
        from: "simple",
        to: "trivial",
        promptPattern: "\\bdocstring\\b",
        matchedCount: 3,
        sampleReason: "ok",
      },
    ]);
    expect(rules).toEqual([
      {
        pattern: "\\bdocstring\\b",
        class: "trivial",
        confidence: 0.85,
        source: "auto",
      },
    ]);
  });
});

describe("runTournament — aggregate stats", () => {
  test("perClassWinRates counts correctly", async () => {
    const spawn = makeMockSpawn([
      // row 1: simple, B wins
      ok(envelope("A")),
      ok(envelope("B")),
      ok(judgeEnvelope("B", "r1")),
      // row 2: simple, tie
      ok(envelope("A")),
      ok(envelope("B")),
      ok(judgeEnvelope("tie", "r2")),
      // row 3: simple, A wins
      ok(envelope("A")),
      ok(envelope("B")),
      ok(judgeEnvelope("A", "r3")),
      // row 4: hard, B wins
      ok(envelope("A")),
      ok(envelope("B")),
      ok(judgeEnvelope("B", "r4")),
    ]);
    const report = await runTournament(
      [
        { prompt: "p1", currentClass: "simple", currentSpec: getSpec("simple") },
        { prompt: "p2", currentClass: "simple", currentSpec: getSpec("simple") },
        { prompt: "p3", currentClass: "simple", currentSpec: getSpec("simple") },
        { prompt: "p4", currentClass: "hard", currentSpec: getSpec("hard") },
      ],
      { spawn, getSpec },
    );
    expect(report.perClassWinRates.simple).toEqual({
      ran: 3,
      downgradeWins: 1,
      ties: 1,
      aLosses: 1,
    });
    expect(report.perClassWinRates.hard).toEqual({
      ran: 1,
      downgradeWins: 1,
      ties: 0,
      aLosses: 0,
    });
    expect(report.perClassWinRates.trivial).toEqual({
      ran: 0,
      downgradeWins: 0,
      ties: 0,
      aLosses: 0,
    });
    expect(report.ran).toBe(4);
    expect(report.totalPrompts).toBe(4);
  });
});

describe("runTournament — judge input shape", () => {
  test("judge spawn receives prompt + responses wrapped in tags", async () => {
    const spawn = makeMockSpawn([
      ok(envelope("This is A's response")),
      ok(envelope("This is B's response")),
      ok(judgeEnvelope("B")),
    ]);
    await runTournament(
      [{ prompt: "what is 2+2", currentClass: "simple", currentSpec: getSpec("simple") }],
      { spawn, getSpec },
    );
    const judgeCall = spawn.calls[2]!;
    expect(judgeCall.input).toContain("<TASK>what is 2+2</TASK>");
    expect(judgeCall.input).toContain("<RESPONSE_A>This is A's response</RESPONSE_A>");
    expect(judgeCall.input).toContain("<RESPONSE_B>This is B's response</RESPONSE_B>");
  });

  test("judge args include --json-schema, --system-prompt, and --model sonnet by default", async () => {
    const spawn = makeMockSpawn([
      ok(envelope("A")),
      ok(envelope("B")),
      ok(judgeEnvelope("B")),
    ]);
    await runTournament(
      [{ prompt: "x", currentClass: "simple", currentSpec: getSpec("simple") }],
      { spawn, getSpec },
    );
    const judgeArgs = spawn.calls[2]!.args;
    expect(judgeArgs).toContain("--json-schema");
    expect(judgeArgs).toContain("--system-prompt");
    expect(judgeArgs[judgeArgs.indexOf("--system-prompt") + 1]).toBe(JUDGE_SYSTEM_PROMPT);
    expect(judgeArgs[judgeArgs.indexOf("--model") + 1]).toBe("sonnet");
    expect(judgeArgs[judgeArgs.indexOf("--output-format") + 1]).toBe("json");
  });

  test("custom judge model is honored", async () => {
    const spawn = makeMockSpawn([
      ok(envelope("A")),
      ok(envelope("B")),
      ok(judgeEnvelope("B")),
    ]);
    await runTournament(
      [{ prompt: "x", currentClass: "simple", currentSpec: getSpec("simple") }],
      { spawn, getSpec, judgeModel: "opus" },
    );
    const judgeArgs = spawn.calls[2]!.args;
    expect(judgeArgs[judgeArgs.indexOf("--model") + 1]).toBe("opus");
  });
});

describe("buildResponseArgs", () => {
  test("includes core flags for a class spec", () => {
    const args = buildResponseArgs(getSpec("standard"));
    expect(args).toContain("--print");
    expect(args[args.indexOf("--output-format") + 1]).toBe("json");
    expect(args[args.indexOf("--model") + 1]).toBe(getSpec("standard").model);
    expect(args[args.indexOf("--max-budget-usd") + 1]).toBe(
      String(getSpec("standard").maxBudgetUsd),
    );
    // Never --bare on tournament calls (full context required).
    expect(args).not.toContain("--bare");
  });

  test("trivial spec yields --tools and --strict-mcp-config but not --bare", () => {
    const args = buildResponseArgs(getSpec("trivial"));
    expect(args).toContain("--tools");
    expect(args).toContain("--strict-mcp-config");
    expect(args).not.toContain("--bare");
  });
});

describe("buildJudgeArgs", () => {
  test("contains --print, --output-format json, --json-schema, --max-budget-usd", () => {
    const args = buildJudgeArgs({ model: "sonnet", systemPrompt: "any text" });
    expect(args).toContain("--print");
    expect(args[args.indexOf("--output-format") + 1]).toBe("json");
    expect(args).toContain("--json-schema");
    expect(args).toContain("--max-budget-usd");
  });

  test("includes the frozen JSON schema string", () => {
    const args = buildJudgeArgs({ model: "sonnet", systemPrompt: "any text" });
    expect(args[args.indexOf("--json-schema") + 1]).toBe(JUDGE_JSON_SCHEMA);
  });

  test("contains --system-prompt followed by the system prompt text", () => {
    const args = buildJudgeArgs({ model: "sonnet", systemPrompt: "RUBRIC" });
    const idx = args.indexOf("--system-prompt");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("RUBRIC");
  });
});

describe("JUDGE_PROMPT_TEMPLATE", () => {
  test("wraps prompt + responses in the expected tags, omits rubric", () => {
    const out = JUDGE_PROMPT_TEMPLATE("the task", "a-text", "b-text");
    expect(out).toContain("<TASK>the task</TASK>");
    expect(out).toContain("<RESPONSE_A>a-text</RESPONSE_A>");
    expect(out).toContain("<RESPONSE_B>b-text</RESPONSE_B>");
    expect(out).not.toContain("evaluating");
    expect(out).not.toContain("Respond with JSON");
  });
});

describe("runTournament resume", () => {
  const SAMPLE_SPEC = getSpec("standard");

  test("skips prompts already present in the resume file", async () => {
    const tmpFile = join(tmpdir(), `tournament-resume-${Date.now()}.jsonl`);
    const prior: TournamentRowResult = {
      prompt: "already-done",
      currentClass: "standard",
      downgradedClass: "simple",
      skipped: false,
      costAUsd: 0.001,
      costBUsd: 0.001,
      costJudgeUsd: 0.001,
      judgeVerdict: "B_wins",
      judgeReason: "prior verdict",
      recommendDowngrade: true,
    };
    writeFileSync(tmpFile, JSON.stringify(prior) + "\n");

    try {
      let spawnCallCount = 0;
      const spawn: TournamentSpawn = async () => {
        spawnCallCount++;
        return {
          stdout: JSON.stringify({
            type: "result",
            total_cost_usd: 0,
            result: JSON.stringify({ winner: "tie", reason: "fake" }),
          }),
          exitCode: 0,
          timedOut: false,
        };
      };

      const inputs: TournamentInput[] = [
        { prompt: "already-done", currentClass: "standard", currentSpec: SAMPLE_SPEC },
        { prompt: "fresh", currentClass: "standard", currentSpec: SAMPLE_SPEC },
      ];

      const report = await runTournament(inputs, {
        spawn,
        getSpec,
        resumePath: tmpFile,
      });

      // Only "fresh" should have been spawned (3 calls: A, B, judge)
      expect(spawnCallCount).toBe(3);
      // Only "fresh" appears in this run's rows (already-done was skipped, not re-judged)
      expect(report.rows.map((r) => r.prompt)).toEqual(["fresh"]);
    } finally {
      try {
        unlinkSync(tmpFile);
      } catch {
        /* ignore */
      }
    }
  });

  test("appends rows to the resume file as they complete", async () => {
    const tmpFile = join(tmpdir(), `tournament-append-${Date.now()}.jsonl`);

    try {
      const spawn: TournamentSpawn = async () => ({
        stdout: JSON.stringify({
          type: "result",
          total_cost_usd: 0,
          result: JSON.stringify({ winner: "B", reason: "fake" }),
        }),
        exitCode: 0,
        timedOut: false,
      });

      const inputs: TournamentInput[] = [
        { prompt: "p1", currentClass: "standard", currentSpec: SAMPLE_SPEC },
        { prompt: "p2", currentClass: "standard", currentSpec: SAMPLE_SPEC },
      ];

      await runTournament(inputs, {
        spawn,
        getSpec,
        resumePath: tmpFile,
      });

      const written = readFileSync(tmpFile, "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as TournamentRowResult);
      expect(written).toHaveLength(2);
      expect(written.map((r) => r.prompt)).toEqual(["p1", "p2"]);
      expect(written.every((r) => r.judgeVerdict === "B_wins")).toBe(true);
    } finally {
      try {
        unlinkSync(tmpFile);
      } catch {
        /* ignore */
      }
    }
  });
});
