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
/** 1M-context Opus variant costs 2× standard on input/cache tokens. */
const OPUS_1M_INPUT_PER_TOK = 30 / 1_000_000;
const OPUS_1M_CACHE_WRITE_PER_TOK = 37.5 / 1_000_000;
const OPUS_1M_CACHE_READ_PER_TOK = 3.0 / 1_000_000;

/** Cache write rates per model alias (USD per token). */
const CACHE_WRITE_RATE: Record<string, number> = {
  haiku: 1.25 / 1_000_000,
  sonnet: 3.75 / 1_000_000,
  opus: OPUS_CACHE_WRITE_PER_TOK,
};

/**
 * Estimate the cache_creation cost from token count + model alias.
 * Used to report actual write cost rather than full-turn cost.
 */
function estimateCacheWriteCost(model: string, tokens: number, is1m: boolean): number {
  if (tokens <= 0) return 0;
  const lower = model.toLowerCase();
  if (lower.includes("haiku")) return tokens * CACHE_WRITE_RATE.haiku!;
  if (lower.includes("opus")) return tokens * (is1m ? OPUS_1M_CACHE_WRITE_PER_TOK : OPUS_CACHE_WRITE_PER_TOK);
  return tokens * CACHE_WRITE_RATE.sonnet!; // sonnet default
}

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
  /** True when ≥1 event used the claude-opus-4-7[1m] 1M-context variant (costs 2× standard). */
  has1mVariant: boolean;
  /** Count of events that used the 1M variant. */
  count1mVariant: number;
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
  /** p90 output token count per class — quality proxy. undefined = no data. */
  outputTokensP90ByClass: Partial<Record<Class, number>>;
  /** p90 API duration in ms per class — tail latency proxy. undefined = no data. */
  durationApiMsP90ByClass: Partial<Record<Class, number>>;
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
  // Track 1M variant tokens separately for accurate baseline pricing.
  let totalInputTokens1m = 0;
  let totalCacheCreationTokens1m = 0;
  let totalCacheReadTokens1m = 0;
  let count1mVariant = 0;

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
          cacheCreationCost += estimateCacheWriteCost(
            e.decision.spec.model,
            e.cost.cacheCreationInputTokens,
            e.cost.is1mVariant ?? false,
          );
        }
        if (e.cost.cacheReadInputTokens > 0) cacheReadCount++;
        totalInputTokens += e.cost.inputTokens;
        totalOutputTokens += e.cost.outputTokens;
        totalCacheCreationTokens += e.cost.cacheCreationInputTokens;
        totalCacheReadTokens += e.cost.cacheReadInputTokens;
        if (e.cost.is1mVariant) {
          count1mVariant++;
          totalInputTokens1m += e.cost.inputTokens;
          totalCacheCreationTokens1m += e.cost.cacheCreationInputTokens;
          totalCacheReadTokens1m += e.cost.cacheReadInputTokens;
        }
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
    totalInputTokens1m,
    totalCacheCreationTokens1m,
    totalCacheReadTokens1m,
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
    has1mVariant: count1mVariant > 0,
    count1mVariant,
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
 * Reprice the observed token mix at Opus rates. Splits 1M-context-variant
 * tokens from standard tokens and prices each at the appropriate tier:
 * 1M Opus costs 2× standard on input and cache_creation/read tokens.
 * Output tokens are priced the same regardless of context window size.
 */
function estimateBaselineOpusCost(
  actualCost: number,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
  inputTokens1m: number,
  cacheCreationTokens1m: number,
  cacheReadTokens1m: number,
): number {
  const inputStd = inputTokens - inputTokens1m;
  const cacheCreationStd = cacheCreationTokens - cacheCreationTokens1m;
  const cacheReadStd = cacheReadTokens - cacheReadTokens1m;

  const tokenBased =
    inputStd * OPUS_INPUT_PER_TOK +
    inputTokens1m * OPUS_1M_INPUT_PER_TOK +
    outputTokens * OPUS_OUTPUT_PER_TOK +
    cacheCreationStd * OPUS_CACHE_WRITE_PER_TOK +
    cacheCreationTokens1m * OPUS_1M_CACHE_WRITE_PER_TOK +
    cacheReadStd * OPUS_CACHE_READ_PER_TOK +
    cacheReadTokens1m * OPUS_1M_CACHE_READ_PER_TOK;
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
    `  ${bold("would-be opus")}   ${gray("~" + usd(s.baselineOpusEverywhereUsd))}  ${s.has1mVariant ? dim(`(${s.count1mVariant} turns at 1M pricing)`) : ""}`,
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

  // 1M variant cost warning
  if (s.has1mVariant) {
    lines.push("");
    lines.push(yellow(`  ⚠ claude-opus-4-7[1m] detected on ${s.count1mVariant} turn(s) — 1M context costs 2× standard Opus`));
    lines.push(dim("  → baseline is repriced at 1M rates; savings vs standard 200k Opus would be higher"));
    lines.push(dim("  → set ANTHROPIC_CONTEXT_WINDOW=200k (if supported) or avoid long-session VSCode panel mode"));
  }

  // Cache write cost warning — fires when cache_creation exceeds cache_read savings
  if (s.cacheCreationCostUsd > 0 && s.totalCostUsd > 0) {
    const bootRatio = s.cacheCreationCostUsd / s.totalCostUsd;
    if (bootRatio > 0.5) {
      lines.push("");
      lines.push(yellow("  ⚠ cache_creation is " + (bootRatio * 100).toFixed(0) + "% of spend — fingerprint fragmentation likely"));
      lines.push(dim("  → different classes are booting separate sessions instead of sharing one per model tier"));
      lines.push(dim("  → check that profile classes share tools='default' and mcpConfig to unify fingerprints"));
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
  const hasOutputData = ALL_CLASSES.some((c) => (s.outputTokensP90ByClass[c] ?? 0) > 0);
  if (hasOutputData) {
    lines.push("");
    lines.push(header("output tokens p90"));
    for (const cls of ALL_CLASSES) {
      const val = s.outputTokensP90ByClass[cls];
      if (val === 0 || val === undefined) continue;
      lines.push(`  ${cls.padEnd(12)}  ${String(val).padStart(6)} tok`);
    }
  }

  return lines.join("\n");
}
