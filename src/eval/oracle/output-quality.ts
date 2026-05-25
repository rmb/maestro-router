// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { overrideClassifier } from "../../classifiers/override.js";
import { turnTypeClassifier } from "../../classifiers/turn-type.js";
import { markovClassifier } from "../../classifiers/markov.js";
import { heuristicClassifier } from "../../classifiers/heuristic.js";
import { createPipeline } from "../../core/pipeline.js";
import { loadProfile } from "../../core/profile.js";
import type { TelemetryEvent, UserConfig } from "../../core/types.js";
import {
  runEval,
  readBaseline,
  resolveBundledBaseline,
  type LabeledEntry,
} from "../../cli/bench.js";
import type { CheckResult, DimensionResult } from "./telemetry-correctness.js";

// ---------------------------------------------------------------------------
// SpawnFn type
// ---------------------------------------------------------------------------

export type SpawnFn = (opts: {
  args: ReadonlyArray<string>;
  prompt: string;
}) => Promise<{ stdout: string; exitCode: number | null }>;

// ---------------------------------------------------------------------------
// Narrowed event type
// ---------------------------------------------------------------------------

type DecisionEvent = Extract<TelemetryEvent, { type: "decision" }>;

// ---------------------------------------------------------------------------
// checkTruncationRate
// ---------------------------------------------------------------------------

/**
 * Verifies that fewer than 5% of standard turns with a maxOutputTokens cap
 * are "near-cap" (outputTokens >= maxOutputTokens * 0.98).
 *
 * budget: 2ms
 */
export function checkTruncationRate(events: TelemetryEvent[]): CheckResult {
  const eligible = events.filter(
    (e): e is DecisionEvent & {
      cost: NonNullable<DecisionEvent["cost"]>;
    } =>
      e.type === "decision" &&
      e.decision.class === "standard" &&
      e.cost !== undefined &&
      e.decision.spec.maxOutputTokens !== undefined,
  );

  if (eligible.length === 0) {
    return {
      name: "truncation-rate",
      pass: true,
      value: "n/a (no data)",
      gate: "<5%",
    };
  }

  const nearCapCount = eligible.filter(
    (e) => e.cost.outputTokens >= e.decision.spec.maxOutputTokens! * 0.98,
  ).length;

  const nearCapRate = nearCapCount / eligible.length;
  const pass = nearCapRate < 0.05;
  const valueStr = `${(nearCapRate * 100).toFixed(1)}%`;

  const base: CheckResult = {
    name: "truncation-rate",
    pass,
    value: valueStr,
    gate: "<5%",
  };

  if (!pass) {
    return {
      ...base,
      detail: `${nearCapCount} of ${eligible.length} standard turns are near the output cap (≥98% of their recorded maxOutputTokens). These events were recorded with the cap value at that time — if you already raised the cap, this will clear as the ${eligible.length} old events age out of the 7-day window.`,
    };
  }
  return base;
}

// ---------------------------------------------------------------------------
// checkBenchAccuracy
// ---------------------------------------------------------------------------

/**
 * Runs the bundled eval set through the default pipeline and checks for
 * >2% accuracy regression against the locked baseline.
 *
 * When evalSetPath is empty, returns "skipped" (no eval set configured).
 * When no baseline exists, reports current accuracy without a regression check.
 *
 * budget: 5000ms p95 (depends on eval set size; pure in-process, no spawns)
 */
export async function checkBenchAccuracy(
  evalSetPath: string,
  _spawnFn: SpawnFn /* reserved for future use — bench runs in-process */,
  userConfig?: UserConfig,
): Promise<CheckResult> {
  if (!evalSetPath) {
    return {
      name: "bench-accuracy",
      pass: true,
      value: "skipped",
      gate: "≤2% regression",
      detail: "No eval set path configured — pass evalSetPath to enable this check.",
    };
  }

  try {
    const data = await readFile(evalSetPath, "utf8");
    const entries = data
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as LabeledEntry);

    const { profile } = loadProfile({ userConfig: userConfig ?? {} });
    const pipeline = createPipeline({
      classifiers: [overrideClassifier, turnTypeClassifier, markovClassifier, heuristicClassifier],
      profile,
    });

    const report = await runEval(entries, pipeline);
    const baselinePath = resolveBundledBaseline(undefined);
    const baseline = await readBaseline(baselinePath);

    if (!baseline) {
      return {
        name: "bench-accuracy",
        pass: true,
        value: `${(report.accuracy * 100).toFixed(1)}%`,
        gate: "≤2% regression",
        detail: "No baseline found — run maestro bench --update-baseline to establish one.",
      };
    }

    const delta = baseline.accuracy - report.accuracy;
    const pass = delta <= 0.02;
    const base: CheckResult = {
      name: "bench-accuracy",
      pass,
      value: `${(delta * 100).toFixed(2)}pp Δ`,
      gate: "≤2% regression",
    };
    if (!pass) {
      return {
        ...base,
        detail: `Accuracy dropped from ${(baseline.accuracy * 100).toFixed(1)}% to ${(report.accuracy * 100).toFixed(1)}%. Regression exceeds 2pp gate.`,
      };
    }
    return base;
  } catch (err) {
    return {
      name: "bench-accuracy",
      pass: false,
      value: "error",
      gate: "≤2% regression",
      detail: `Bench run failed: ${(err as Error).message}`,
    };
  }
}

// ---------------------------------------------------------------------------
// checkE1QualityProbe
// ---------------------------------------------------------------------------

/**
 * Samples the most recent `sampleSize` standard-class decision events that
 * have a prompt, re-runs each through the cheaper haiku/low tier via
 * spawnFn, then judges the output with a second haiku call.
 *
 * Pass gate: ≥60% of sampled turns produce output the judge rates PASS.
 *
 * When sampleSize is 0 or no eligible events exist, returns "n/a (no data)".
 *
 * budget: depends on sampleSize × 2 model calls; caller must obtain
 * --confirm-cost before wiring a real spawnFn.
 */
export async function checkE1QualityProbe(
  events: TelemetryEvent[],
  sampleSize: number,
  spawnFn: SpawnFn,
): Promise<CheckResult> {
  if (sampleSize === 0) {
    return {
      name: "e1-quality-probe",
      pass: true,
      value: "n/a (no data)",
      gate: "≥60% B-win",
    };
  }

  const eligible = events
    .filter(
      (e): e is DecisionEvent =>
        e.type === "decision" &&
        e.decision.class === "standard" &&
        typeof e.prompt === "string" &&
        e.prompt.length > 0,
    )
    .slice(-sampleSize);

  if (eligible.length === 0) {
    return {
      name: "e1-quality-probe",
      pass: true,
      value: "n/a (no data)",
      gate: "≥60% B-win",
    };
  }

  let wins = 0;

  for (const event of eligible) {
    const prompt = event.prompt ?? "";

    try {
      const bResult = await spawnFn({
        args: ["--model", "haiku", "--effort", "low", "--max-budget-usd", "0.02", "--print", "--output-format", "json"],
        prompt,
      });
      if (bResult.exitCode !== 0) continue;

      const judgePrompt =
        `Original request: ${prompt}\n\nHaiku answer:\n${bResult.stdout}\n\n` +
        `Is this answer adequate (correct and helpful)? Reply with exactly: PASS or FAIL`;

      const judgeResult = await spawnFn({
        args: ["--model", "haiku", "--effort", "low", "--max-budget-usd", "0.01", "--print"],
        prompt: judgePrompt,
      });

      if (judgeResult.stdout.toUpperCase().includes("PASS")) wins++;
    } catch {
      // spawn failure counts as loss — denominator stays eligible.length
    }
  }

  const winRate = wins / eligible.length;
  const pass = winRate >= 0.6;
  const base: CheckResult = {
    name: "e1-quality-probe",
    pass,
    value: `${(winRate * 100).toFixed(0)}% B-win`,
    gate: "≥60% B-win",
  };
  if (!pass) {
    return {
      ...base,
      detail: `Only ${wins}/${eligible.length} sampled standard turns showed adequate haiku output.`,
    };
  }
  return base;
}

// ---------------------------------------------------------------------------
// runOutputQuality
// ---------------------------------------------------------------------------

/**
 * Runs the zero-cost truncation check synchronously plus the two stubs.
 * Always returns dimension="quality". Fails only if checkTruncationRate fails.
 */
export async function runOutputQuality(
  events: TelemetryEvent[],
  params: {
    evalSetPath?: string;
    sampleSize?: number;
    spawnFn?: SpawnFn;
    userConfig?: UserConfig;
  },
): Promise<DimensionResult> {
  const noopSpawn: SpawnFn = async () => ({ stdout: "", exitCode: null });
  const spawnFn = params.spawnFn ?? noopSpawn;

  const truncation = checkTruncationRate(events);
  const benchAccuracy = await checkBenchAccuracy(
    params.evalSetPath ?? "",
    spawnFn,
    params.userConfig,
  );
  const e1Quality = await checkE1QualityProbe(
    events,
    params.sampleSize ?? 0,
    spawnFn,
  );

  const checks: CheckResult[] = [truncation, benchAccuracy, e1Quality];
  const pass = checks.every((c) => c.pass);

  return { dimension: "quality", pass, checks };
}
