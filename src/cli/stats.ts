// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import type { Command } from "commander";
import { createTelemetry } from "../core/telemetry.js";
import { ALL_CLASSES, balancedProfile } from "../core/profile.js";
import type { Class, TelemetryEvent } from "../core/types.js";
import { DEFAULT_TELEMETRY_PATH, format, loadCliConfig } from "./utils.js";

const DEFAULT_WINDOW_DAYS = 7;

/** Cost-per-million-input-tokens estimate for the Opus-everywhere baseline. */
const OPUS_BASELINE_FACTOR = 5; // rough: Opus ≈ 5× Sonnet, 15× Haiku

type ParentOptions = { json?: boolean; quiet?: boolean; config?: string };

type Summary = {
  windowDays: number;
  totalRequests: number;
  totalCostUsd: number;
  baselineOpusEverywhereUsd: number;
  estimatedSavings: number;
  savingsRatio: number;
  cacheHitRate: number;
  cacheCreationCostUsd: number;
  cacheReadSavingsTokens: number;
  perClass: Record<
    Class,
    {
      count: number;
      avgCostUsd: number;
      cacheCreationP95: number;
      overrideRate: number;
    }
  >;
  topOverrides: { from: Class; to: Class; count: number }[];
};

export function registerStatsCommand(program: Command): void {
  program
    .command("stats")
    .description("Cost vs Opus-everywhere baseline, cache hit %, override rate")
    .option("--since <days>", "window in days", String(DEFAULT_WINDOW_DAYS))
    .action(async (cmdOpts: { since: string }) => {
      const parent = program.opts<ParentOptions>();
      const cli = await loadCliConfig(parent.config);
      const path = cli.userConfig.telemetryPath ?? DEFAULT_TELEMETRY_PATH;
      const since = Math.max(1, parseInt(cmdOpts.since, 10) || DEFAULT_WINDOW_DAYS);
      const cutoff = Date.now() - since * 24 * 60 * 60 * 1000;

      const t = createTelemetry({ path });
      const events = (await t.readAll()).filter(
        (e) => Date.parse(e.ts) >= cutoff,
      );

      const summary = computeSummary(events, since);
      if (parent.json) {
        process.stdout.write(format(summary, { json: true }) + "\n");
      } else if (!parent.quiet) {
        process.stdout.write(renderHuman(summary) + "\n");
      }
    });
}

export function computeSummary(events: ReadonlyArray<TelemetryEvent>, windowDays: number): Summary {
  const perClass: Record<Class, {
    count: number;
    totalCost: number;
    cacheCreations: number[];
    overrides: number;
  }> = makePerClass();

  const overridePairs = new Map<string, { from: Class; to: Class; count: number }>();
  let totalCost = 0;
  let totalRequests = 0;
  let cacheReadTokens = 0;
  let cacheCreationCost = 0;
  let cacheReadCount = 0;

  for (const e of events) {
    if (e.type === "decision") {
      totalRequests++;
      const cls = e.decision.class;
      const cost = e.cost?.totalCostUsd ?? 0;
      totalCost += cost;
      perClass[cls].count++;
      perClass[cls].totalCost += cost;
      if (e.cost) {
        perClass[cls].cacheCreations.push(e.cost.cacheCreationInputTokens);
        cacheReadTokens += e.cost.cacheReadInputTokens;
        if (e.cost.cacheCreationInputTokens > 0) {
          cacheCreationCost += cost; // attribute full cost when cache was bootstrapped that turn
        }
        if (e.cost.cacheReadInputTokens > 0) cacheReadCount++;
      }
    } else if (e.type === "override") {
      const key = `${e.from}>${e.to}`;
      const cur = overridePairs.get(key) ?? { from: e.from, to: e.to, count: 0 };
      cur.count++;
      overridePairs.set(key, cur);
      perClass[e.from].overrides++;
    }
  }

  const perClassOut: Summary["perClass"] = {} as Summary["perClass"];
  for (const cls of ALL_CLASSES) {
    const b = perClass[cls];
    perClassOut[cls] = {
      count: b.count,
      avgCostUsd: b.count > 0 ? b.totalCost / b.count : 0,
      cacheCreationP95: percentile(b.cacheCreations, 0.95),
      overrideRate: b.count > 0 ? b.overrides / b.count : 0,
    };
  }

  const baselineOpus = estimateBaselineOpusCost(totalCost, perClass);

  return {
    windowDays,
    totalRequests,
    totalCostUsd: round(totalCost, 4),
    baselineOpusEverywhereUsd: round(baselineOpus, 4),
    estimatedSavings: round(baselineOpus - totalCost, 4),
    savingsRatio: baselineOpus > 0 ? round((baselineOpus - totalCost) / baselineOpus, 4) : 0,
    cacheHitRate: totalRequests > 0 ? round(cacheReadCount / totalRequests, 4) : 0,
    cacheCreationCostUsd: round(cacheCreationCost, 4),
    cacheReadSavingsTokens: cacheReadTokens,
    perClass: perClassOut,
    topOverrides: [...overridePairs.values()].sort((a, b) => b.count - a.count).slice(0, 5),
  };
}

function makePerClass(): Record<Class, { count: number; totalCost: number; cacheCreations: number[]; overrides: number }> {
  const out = {} as Record<Class, { count: number; totalCost: number; cacheCreations: number[]; overrides: number }>;
  for (const cls of ALL_CLASSES) {
    out[cls] = { count: 0, totalCost: 0, cacheCreations: [], overrides: 0 };
  }
  return out;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const arr = [...sorted].sort((a, b) => a - b);
  const idx = Math.min(arr.length - 1, Math.floor(arr.length * p));
  return arr[idx] ?? 0;
}

function round(n: number, digits: number): number {
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

/**
 * Estimate "what would this have cost on Opus-everywhere?" by re-pricing each
 * decision's class spec against opus + max effort using a rough multiplier on
 * the actual realized cost. Real Anthropic pricing varies per model + cache
 * usage; this is a coarse heuristic, surfaced as `baselineOpusEverywhereUsd`.
 */
function estimateBaselineOpusCost(
  actualCost: number,
  perClass: Record<Class, { count: number; totalCost: number }>,
): number {
  let baseline = 0;
  for (const cls of ALL_CLASSES) {
    const factor = baselineFactor(cls);
    baseline += perClass[cls].totalCost * factor;
  }
  // Fallback if all classes are zero
  return baseline > 0 ? baseline : actualCost * OPUS_BASELINE_FACTOR;
}

function baselineFactor(cls: Class): number {
  // Rough scalars: how much more would this prompt cost on opus@max vs the
  // class's actual model+effort? Higher classes already use opus so factor ~1;
  // trivial→opus is ~15× difference.
  switch (cls) {
    case "trivial":
      return balancedProfile.classes.trivial.model === "haiku" ? 15 : 1;
    case "simple":
      return 8;
    case "standard":
      return 5;
    case "hard":
      return 3;
    case "reasoning":
      return 1.5;
    case "max":
      return 1;
  }
}

function renderHuman(s: Summary): string {
  const lines: string[] = [];
  lines.push(`Maestro stats (last ${s.windowDays}d)`);
  lines.push(`  requests:      ${s.totalRequests}`);
  lines.push(`  spent:         $${s.totalCostUsd.toFixed(4)}`);
  lines.push(`  if Opus-everywhere: ~$${s.baselineOpusEverywhereUsd.toFixed(4)}`);
  lines.push(
    `  estimated savings: $${s.estimatedSavings.toFixed(4)} (${(s.savingsRatio * 100).toFixed(1)}%)`,
  );
  lines.push(`  cache hit rate: ${(s.cacheHitRate * 100).toFixed(1)}%`);
  lines.push(`  cache-creation cost: $${s.cacheCreationCostUsd.toFixed(4)} (session bootstraps)`);
  lines.push("");
  lines.push("Per-class:");
  for (const cls of ALL_CLASSES) {
    const c = s.perClass[cls];
    if (c.count === 0) continue;
    lines.push(
      `  ${cls.padEnd(10)} ${String(c.count).padStart(5)}  avg $${c.avgCostUsd.toFixed(4)}  override ${(c.overrideRate * 100).toFixed(0)}%  cache_create P95 ${c.cacheCreationP95}`,
    );
  }
  if (s.topOverrides.length > 0) {
    lines.push("");
    lines.push("Top override patterns (you correcting Maestro):");
    for (const o of s.topOverrides) {
      lines.push(`  ${o.from} → ${o.to}  ×${o.count}`);
    }
    lines.push("");
    lines.push("Run `maestro tune --learn` to fold these into heuristics.");
  }
  return lines.join("\n");
}
