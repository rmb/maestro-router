#!/usr/bin/env tsx
// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0
//
// Fast-mode cost spike.
// Runs 5 prompt pairs (baseline vs --fast-mode) and compares cost/latency.
//
// Usage:
//   npx tsx scripts/fast-mode-spike.ts [--model <model>] [--confirm-cost]
//
// Requirements:
//   - claude CLI on PATH, authenticated
//   - ANTHROPIC_API_KEY or claude.ai OAuth (--fast-mode may require API key)
//
// Output: structured table to stdout + raw JSON to fast-mode-spike-results.json

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TurnResult = {
  prompt: string;
  mode: "baseline" | "fast-mode";
  model: string;
  totalCostUsd: number | null;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationTokens: number | null;
  cacheReadTokens: number | null;
  response: string;
  error: string | null;
};

type PairResult = {
  promptLabel: string;
  baseline: TurnResult;
  fastMode: TurnResult;
  costDeltaUsd: number | null;
  durationDeltaMs: number | null;
  fastModeIsCheaper: boolean | null;
};

type SpikeOutput = {
  runAt: string;
  model: string;
  fastModeFlag: string;
  fastModeAvailable: boolean;
  pairs: PairResult[];
  summary: {
    totalPairs: number;
    fastModeCheaperCount: number;
    avgCostDeltaUsd: number | null;
    avgDurationDeltaMs: number | null;
    recommendation: string;
  };
};

// ---------------------------------------------------------------------------
// Spike prompts (representative of real Maestro routing targets)
// ---------------------------------------------------------------------------

const SPIKE_PROMPTS: Array<{ label: string; prompt: string }> = [
  {
    label: "short-format",
    prompt: 'Format this JSON on one line: { "a": 1, "b": 2 }',
  },
  {
    label: "rename-symbol",
    prompt: "Rename the variable `foo` to `bar` in this snippet: const foo = 42; console.log(foo);",
  },
  {
    label: "explain-error",
    prompt:
      "Explain this TypeScript error in one sentence: TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
  },
  {
    label: "list-items",
    prompt: "List the first 5 prime numbers.",
  },
  {
    label: "continuation",
    prompt: "Complete this sentence in 10 words or fewer: The quickest way to reduce token costs is",
  },
];

// ---------------------------------------------------------------------------
// Claude invocation
// ---------------------------------------------------------------------------

function runClaude(
  prompt: string,
  model: string,
  extraArgs: string[],
): { json: Record<string, unknown> | null; durationMs: number; raw: string; error: string | null } {
  const start = Date.now();
  const args = [
    "--print",
    "--model",
    model,
    "--output-format",
    "json",
    "--max-budget-usd",
    "0.50",
    ...extraArgs,
  ];
  const res = spawnSync("claude", args, {
    input: prompt,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 120_000,
  });
  const durationMs = Date.now() - start;
  const raw = typeof res.stdout === "string" ? res.stdout : "";
  if (res.error !== undefined || res.status !== 0) {
    return {
      json: null,
      durationMs,
      raw,
      error: res.error?.message ?? `exit code ${res.status ?? "?"}`,
    };
  }
  try {
    // Claude --output-format json may emit a stream; find the last JSON object.
    const lastBrace = raw.lastIndexOf("{");
    const slice = raw.slice(lastBrace);
    const json = JSON.parse(slice) as Record<string, unknown>;
    return { json, durationMs, raw, error: null };
  } catch {
    return { json: null, durationMs, raw, error: "could not parse JSON output" };
  }
}

function extractMetrics(
  json: Record<string, unknown> | null,
  durationMs: number,
  error: string | null,
  model: string,
  prompt: string,
  mode: "baseline" | "fast-mode",
): TurnResult {
  if (!json || error) {
    return {
      prompt,
      mode,
      model,
      totalCostUsd: null,
      durationMs,
      inputTokens: null,
      outputTokens: null,
      cacheCreationTokens: null,
      cacheReadTokens: null,
      response: "",
      error: error ?? "no output",
    };
  }

  const usage = json["usage"] as Record<string, unknown> | undefined;
  const modelUsage = json["modelUsage"] as
    | Record<string, Record<string, unknown>>
    | undefined;

  // Prefer top-level usage; fall back to modelUsage on budget-error.
  let outputTokens = (usage?.["output_tokens"] as number) ?? 0;
  if (!outputTokens && modelUsage) {
    for (const mu of Object.values(modelUsage)) {
      outputTokens += (mu["outputTokens"] as number) ?? 0;
    }
  }

  return {
    prompt,
    mode,
    model,
    totalCostUsd: (json["total_cost_usd"] as number) ?? null,
    durationMs,
    inputTokens: (usage?.["input_tokens"] as number) ?? null,
    outputTokens: outputTokens || null,
    cacheCreationTokens: (usage?.["cache_creation_input_tokens"] as number) ?? null,
    cacheReadTokens: (usage?.["cache_read_input_tokens"] as number) ?? null,
    response: (json["result"] as string) ?? "",
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function detectFastModeFlag(): string | null {
  const help = spawnSync("claude", ["--help"], { encoding: "utf8" });
  if (help.status !== 0) return null;
  if ((help.stdout ?? "").includes("--fast-mode")) return "--fast-mode";
  return null;
}

function estimateCost(pairs: number, model: string): number {
  // Rough estimate: 2 calls per pair, ~$0.05 each on haiku, more on sonnet.
  const perCall = model.includes("haiku") ? 0.05 : model.includes("sonnet") ? 0.08 : 0.12;
  return pairs * 2 * perCall;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const modelArg = args.indexOf("--model");
  const model =
    modelArg !== -1 ? (args[modelArg + 1] ?? "claude-haiku-4-5") : "claude-haiku-4-5";
  const confirmCost = args.includes("--confirm-cost");

  const fastModeFlag = detectFastModeFlag();
  const fastModeAvailable = fastModeFlag !== null;

  const estimatedCostUsd = estimateCost(SPIKE_PROMPTS.length, model);
  if (estimatedCostUsd > 0.5 && !confirmCost) {
    process.stderr.write(
      `Estimated spike cost: $${estimatedCostUsd.toFixed(3)}. Re-run with --confirm-cost to proceed.\n`,
    );
    process.exit(1);
  }

  if (!fastModeAvailable) {
    process.stdout.write(
      "--fast-mode not found in `claude --help`. Spike will run both turns without --fast-mode.\n" +
        "   The 'fast-mode' column will reflect identical baseline flags.\n\n",
    );
  }

  process.stdout.write(`Model: ${model}\n`);
  process.stdout.write(`Fast-mode flag: ${fastModeFlag ?? "(not available)"}\n`);
  process.stdout.write(`Prompts: ${SPIKE_PROMPTS.length}\n`);
  process.stdout.write(`Estimated cost: $${estimatedCostUsd.toFixed(3)}\n\n`);

  const pairs: PairResult[] = [];

  for (const { label, prompt } of SPIKE_PROMPTS) {
    process.stdout.write(`  Running pair: ${label}...\n`);

    const baseRun = runClaude(prompt, model, []);
    const baseline = extractMetrics(
      baseRun.json,
      baseRun.durationMs,
      baseRun.error,
      model,
      prompt,
      "baseline",
    );

    const fastArgs = fastModeFlag !== null ? [fastModeFlag] : [];
    const fastRun = runClaude(prompt, model, fastArgs);
    const fastMode = extractMetrics(
      fastRun.json,
      fastRun.durationMs,
      fastRun.error,
      model,
      prompt,
      "fast-mode",
    );

    const costDeltaUsd =
      baseline.totalCostUsd !== null && fastMode.totalCostUsd !== null
        ? fastMode.totalCostUsd - baseline.totalCostUsd
        : null;
    const durationDeltaMs =
      baseline.durationMs !== null && fastMode.durationMs !== null
        ? fastMode.durationMs - baseline.durationMs
        : null;
    const fastModeIsCheaper = costDeltaUsd !== null ? costDeltaUsd < 0 : null;

    pairs.push({
      promptLabel: label,
      baseline,
      fastMode,
      costDeltaUsd,
      durationDeltaMs,
      fastModeIsCheaper,
    });
  }

  // Summary
  const comparablePairs = pairs.filter((p) => p.fastModeIsCheaper !== null);
  const cheaperCount = pairs.filter((p) => p.fastModeIsCheaper === true).length;
  const avgCostDelta =
    comparablePairs.length > 0
      ? comparablePairs.reduce((s, p) => s + (p.costDeltaUsd ?? 0), 0) / comparablePairs.length
      : null;
  const avgDurationDelta =
    comparablePairs.length > 0
      ? comparablePairs.reduce((s, p) => s + (p.durationDeltaMs ?? 0), 0) /
        comparablePairs.length
      : null;

  let recommendation: string;
  if (!fastModeAvailable) {
    recommendation =
      "INCONCLUSIVE: --fast-mode not available on this Claude CLI version. Upgrade and re-run.";
  } else if (cheaperCount >= 3) {
    recommendation = `PROCEED: fast-mode was cheaper on ${cheaperCount}/${SPIKE_PROMPTS.length} prompts. Open production integration plan.`;
  } else {
    recommendation = `SKIP: fast-mode was cheaper on only ${cheaperCount}/${SPIKE_PROMPTS.length} prompts. No integration warranted.`;
  }

  const output: SpikeOutput = {
    runAt: new Date().toISOString(),
    model,
    fastModeFlag: fastModeFlag ?? "(not available)",
    fastModeAvailable,
    pairs,
    summary: {
      totalPairs: SPIKE_PROMPTS.length,
      fastModeCheaperCount: cheaperCount,
      avgCostDeltaUsd: avgCostDelta,
      avgDurationDeltaMs: avgDurationDelta,
      recommendation,
    },
  };

  // Print table
  process.stdout.write("\n");
  process.stdout.write("Results:\n");
  process.stdout.write(
    ["Label", "Baseline $", "FastMode $", "Delta cost", "Delta ms", "Cheaper?"]
      .map((h) => h.padEnd(14))
      .join("  ") + "\n",
  );
  process.stdout.write("-".repeat(96) + "\n");
  for (const p of pairs) {
    const row = [
      p.promptLabel.padEnd(14),
      (p.baseline.totalCostUsd?.toFixed(6) ?? "ERR").padEnd(14),
      (p.fastMode.totalCostUsd?.toFixed(6) ?? "ERR").padEnd(14),
      (
        p.costDeltaUsd != null
          ? (p.costDeltaUsd >= 0 ? "+" : "") + p.costDeltaUsd.toFixed(6)
          : "N/A"
      ).padEnd(14),
      (
        p.durationDeltaMs != null
          ? (p.durationDeltaMs >= 0 ? "+" : "") + p.durationDeltaMs.toFixed(0) + "ms"
          : "N/A"
      ).padEnd(14),
      p.fastModeIsCheaper === true ? "YES" : p.fastModeIsCheaper === false ? "no" : "N/A",
    ];
    process.stdout.write(row.join("  ") + "\n");
  }
  process.stdout.write("\n");
  process.stdout.write(`Recommendation: ${recommendation}\n`);

  // Write raw JSON
  const outPath = join(process.cwd(), "fast-mode-spike-results.json");
  writeFileSync(outPath, JSON.stringify(output, null, 2) + "\n", "utf8");
  process.stdout.write(`\nRaw results written to: ${outPath}\n`);
  process.stdout.write("Copy the relevant findings into docs/router-observations.md.\n");
}

main().catch((err: unknown) => {
  process.stderr.write(`spike: ${(err as Error).message ?? String(err)}\n`);
  process.exit(1);
});
