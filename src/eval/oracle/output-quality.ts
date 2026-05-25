// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import type { TelemetryEvent } from "../../core/types.js";
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
      detail: `${nearCapCount} of ${eligible.length} standard turns are near the output cap (≥98% of maxOutputTokens). Cap may be too tight — consider raising standard.maxOutputTokens above 8000.`,
    };
  }
  return base;
}

// ---------------------------------------------------------------------------
// checkBenchAccuracy (stub)
// ---------------------------------------------------------------------------

/**
 * Stub — the real implementation runs `maestro bench` against the locked
 * eval set. Returns not-run until --confirm-cost is wired in the CLI.
 */
export async function checkBenchAccuracy(
  _evalSetPath: string,
  _spawnFn: SpawnFn,
): Promise<CheckResult> {
  return {
    name: "bench-accuracy",
    pass: true,
    value: "not-run",
    gate: "≤2% regression",
    detail: "Run with --confirm-cost to execute bench accuracy probe.",
  };
}

// ---------------------------------------------------------------------------
// checkE1QualityProbe (stub)
// ---------------------------------------------------------------------------

/**
 * Stub — the real implementation runs a tournament quality probe against
 * sampled E1 (standard/low) turns. Returns not-run until --confirm-cost is
 * wired in the CLI.
 */
export async function checkE1QualityProbe(
  _events: TelemetryEvent[],
  _sampleSize: number,
  _spawnFn: SpawnFn,
): Promise<CheckResult> {
  return {
    name: "e1-quality-probe",
    pass: true,
    value: "not-run",
    gate: "≥60% B-win",
    detail: "Run with --confirm-cost to execute E1 tournament quality probe.",
  };
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
  },
): Promise<DimensionResult> {
  const noopSpawn: SpawnFn = async () => ({ stdout: "", exitCode: null });
  const spawnFn = params.spawnFn ?? noopSpawn;

  const truncation = checkTruncationRate(events);
  const benchAccuracy = await checkBenchAccuracy(
    params.evalSetPath ?? "",
    spawnFn,
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
