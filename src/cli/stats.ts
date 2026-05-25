// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import type { Command } from "commander";
import { createTelemetry } from "../core/telemetry.js";
import { ALL_CLASSES } from "../core/profile.js";
import type { Class, TelemetryEvent } from "../core/types.js";
import {
  bar,
  bold,
  cyan,
  dim,
  gray,
  green,
  header,
  pct,
  savingsColor,
  usd,
  yellow,
} from "./render.js";
import { DEFAULT_TELEMETRY_PATH, format, loadCliConfig } from "./utils.js";

const DEFAULT_WINDOW_DAYS = 7;

/** Opus token prices (USD per token). Source: Anthropic pricing page. */
const OPUS_INPUT_PER_TOK = 15 / 1_000_000;
const OPUS_OUTPUT_PER_TOK = 75 / 1_000_000;
const OPUS_CACHE_WRITE_PER_TOK = 18.75 / 1_000_000;
const OPUS_CACHE_READ_PER_TOK = 1.50 / 1_000_000;

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
  /** Fraction of decisions where no classifier matched (classifier === "default"). */
  fallbackRate: number;
  /** p90 output token count per class — quality proxy. 0 = no data. */
  outputTokensP90ByClass: Record<Class, number>;
  /** p90 API duration in ms per class — tail latency proxy. 0 = no data. */
  durationApiMsP90ByClass: Record<Class, number>;
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
  let fallbackCount = 0;
  const outputTokensByClass = Object.fromEntries(
    ALL_CLASSES.map((c) => [c, [] as number[]])
  ) as Record<Class, number[]>;
  const durationApiMsByClass = Object.fromEntries(
    ALL_CLASSES.map((c) => [c, [] as number[]])
  ) as Record<Class, number[]>;
  let totalCost = 0;
  let totalRequests = 0;
  let cacheReadTokens = 0;
  let cacheCreationCost = 0;
  let cacheReadCount = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheCreationTokens = 0;
  let totalCacheReadTokens = 0;

  for (const e of events) {
    if (e.type === "decision") {
      totalRequests++;
      const cls = e.decision.class;
      const cost = e.cost?.totalCostUsd ?? 0;
      totalCost += cost;
      perClass[cls].count++;
      perClass[cls].totalCost += cost;
      // Count as fallback: pipeline found no signal ("default" pre-v4, "forced.standard" v4+, "markov" is acceptable fallback)
      if (e.decision.classifier === "default" || e.decision.classifier === "forced.standard") fallbackCount++;
      if (e.cost?.outputTokens && e.cost.outputTokens > 0) {
        outputTokensByClass[cls].push(e.cost.outputTokens);
      }
      if (e.cost) {
        perClass[cls].cacheCreations.push(e.cost.cacheCreationInputTokens);
        cacheReadTokens += e.cost.cacheReadInputTokens;
        if (e.cost.cacheCreationInputTokens > 0) {
          cacheCreationCost += cost; // attribute full cost when cache was bootstrapped that turn
        }
        if (e.cost.cacheReadInputTokens > 0) cacheReadCount++;
        totalInputTokens += e.cost.inputTokens;
        totalOutputTokens += e.cost.outputTokens;
        totalCacheCreationTokens += e.cost.cacheCreationInputTokens;
        totalCacheReadTokens += e.cost.cacheReadInputTokens;
        durationApiMsByClass[cls].push(e.cost.durationApiMs);
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

  const baselineOpus = estimateBaselineOpusCost(
    totalCost,
    totalInputTokens,
    totalOutputTokens,
    totalCacheCreationTokens,
    totalCacheReadTokens,
  );

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
    fallbackRate: totalRequests > 0 ? fallbackCount / totalRequests : 0,
    outputTokensP90ByClass: Object.fromEntries(
      ALL_CLASSES.filter((c) => outputTokensByClass[c].length > 0)
        .map((c) => [c, p90(outputTokensByClass[c])])
    ) as Record<Class, number>,
    durationApiMsP90ByClass: Object.fromEntries(
      ALL_CLASSES.filter((c) => durationApiMsByClass[c].length > 0)
        .map((c) => [c, p90(durationApiMsByClass[c])])
    ) as Record<Class, number>,
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

function p90(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.ceil(sorted.length * 0.9) - 1);
  return sorted[idx] ?? 0;
}

function round(n: number, digits: number): number {
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

/**
 * Reprice the observed token mix at Opus rates. More accurate than flat
 * per-class multipliers because Anthropic prices cache writes, cache reads,
 * and output tokens at consistent ratios across models, so the token counts
 * are the ground truth regardless of which model was actually used.
 */
function estimateBaselineOpusCost(
  actualCost: number,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
): number {
  const tokenBased =
    inputTokens * OPUS_INPUT_PER_TOK +
    outputTokens * OPUS_OUTPUT_PER_TOK +
    cacheCreationTokens * OPUS_CACHE_WRITE_PER_TOK +
    cacheReadTokens * OPUS_CACHE_READ_PER_TOK;
  // Fall back to a 5× multiplier only when no token data is available.
  return tokenBased > 0 ? tokenBased : actualCost * 5;
}

function renderHuman(s: Summary): string {
  const lines: string[] = [];
  const savColor = savingsColor(s.savingsRatio);

  lines.push("");
  lines.push(header(`Maestro stats — last ${s.windowDays}d`));

  if (s.totalRequests === 0) {
    lines.push("");
    lines.push(`  ${dim("no requests yet — try `maestro run \"hello\"` to start collecting data")}`);
    return lines.join("\n");
  }

  lines.push(`  ${bold("requests")}        ${cyan(s.totalRequests)}`);
  lines.push(`  ${bold("spent")}           ${yellow(usd(s.totalCostUsd))}`);
  lines.push(
    `  ${bold("would-be opus")}   ${gray("~" + usd(s.baselineOpusEverywhereUsd))}`,
  );
  lines.push(
    `  ${bold("saved")}           ${savColor(usd(s.estimatedSavings))}  ${savColor(`(${pct(s.savingsRatio, 1)})`)}  ${dim(bar(s.savingsRatio, 20))}`,
  );
  lines.push(
    `  ${bold("cache hit")}       ${cyan(pct(s.cacheHitRate, 1))}  ${dim(bar(s.cacheHitRate, 20))}`,
  );
  lines.push(
    `  ${bold("session boot")}    ${gray(usd(s.cacheCreationCostUsd))}  ${dim("(cache_creation cost)")}`,
  );

  lines.push("");
  lines.push(dim("  per-class"));
  for (const cls of ALL_CLASSES) {
    const c = s.perClass[cls];
    if (c.count === 0) continue;
    const orR = c.overrideRate;
    const orStr = `${(orR * 100).toFixed(0)}%`;
    const orColored = orR > 0.2 ? yellow(orStr) : gray(orStr);
    lines.push(
      `    ${cls.padEnd(10)} ${cyan(String(c.count).padStart(5))}  ${gray("avg")} ${usd(c.avgCostUsd)}  ${gray("override")} ${orColored}  ${gray("p95 cache")} ${c.cacheCreationP95}`,
    );
  }

  if (s.topOverrides.length > 0) {
    lines.push("");
    lines.push(dim("  top override patterns") + " " + dim("(you correcting Maestro)"));
    for (const o of s.topOverrides) {
      lines.push(`    ${o.from} → ${o.to}  ${gray("×" + o.count)}`);
    }
    lines.push("");
    lines.push(green("  → run `maestro tune --learn` to fold these into heuristics"));
  }

  // Cache locality warning — the dominant cost vector
  if (s.cacheCreationCostUsd > 0 && s.totalCostUsd > 0) {
    const bootRatio = s.cacheCreationCostUsd / s.totalCostUsd;
    if (bootRatio > 0.9) {
      lines.push("");
      lines.push(yellow("  ⚠ session boot dominates: " + (bootRatio * 100).toFixed(0) + "% of spend is cache_creation"));
      lines.push(dim("  → Track Z (fingerprint sessions) should fix this — run `maestro health`"));
    }
  }

  // Classifier health
  lines.push("");
  lines.push(header("classifier health"));
  const fallbackPct = (s.fallbackRate * 100).toFixed(1);
  const fallbackWarning = s.fallbackRate > 0.1;
  lines.push(
    `  fallback rate     ${fallbackWarning ? yellow(fallbackPct + "%") : green(fallbackPct + "%")}  ${gray("(target < 5%)")}`,
  );

  // Output token p90
  const hasOutputData = ALL_CLASSES.some((c) => s.outputTokensP90ByClass[c] > 0);
  if (hasOutputData) {
    lines.push("");
    lines.push(header("output tokens p90"));
    for (const cls of ALL_CLASSES) {
      const val = s.outputTokensP90ByClass[cls];
      if (val === 0) continue;
      lines.push(`  ${cls.padEnd(12)}  ${String(val).padStart(6)} tok`);
    }
  }

  return lines.join("\n");
}
