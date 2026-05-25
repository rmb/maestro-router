// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Command } from "commander";
import { createTelemetry } from "../core/telemetry.js";
import { computeSummary } from "./stats.js";
import type { Class } from "../core/types.js";
import { ALL_CLASSES } from "../core/profile.js";
import { bold, cyan, green, red, yellow, dim, header } from "./render.js";
import { DEFAULT_TELEMETRY_PATH, format, loadCliConfig } from "./utils.js";

const DEFAULT_BASELINE_PATH = join(homedir(), ".maestro", "health-baseline.json");

type HealthSnapshot = {
  capturedAt: string;
  windowDays: number;
  totalRequests: number;
  cacheHitRate: number;
  fallbackRate: number;
  cacheCreationRatio: number; // cacheCreationCostUsd / totalCostUsd
  avgCostByClass: Record<Class, number>;
  outputTokensP90ByClass: Record<Class, number>;
};

type ParentOptions = { json?: boolean; quiet?: boolean; config?: string };

export function registerHealthCommand(program: Command): void {
  program
    .command("health")
    .description(
      "Compare current telemetry against a saved baseline. Warns when any metric regresses >10%. " +
      "Use --set-baseline to save the current state as the new baseline.",
    )
    .option("--set-baseline", "Save current stats as the new health baseline")
    .option("--since <days>", "window in days (default: 7)", "7")
    .option("--baseline-path <path>", "path to baseline file")
    .action(async (cmdOpts: { setBaseline?: boolean; since: string; baselinePath?: string }) => {
      const parent = program.opts<ParentOptions>();
      const cli = await loadCliConfig(parent.config);
      const path = cli.userConfig.telemetryPath ?? DEFAULT_TELEMETRY_PATH;
      const baselinePath = cmdOpts.baselinePath ?? DEFAULT_BASELINE_PATH;
      const since = Math.max(1, parseInt(cmdOpts.since, 10) || 7);
      const cutoff = Date.now() - since * 24 * 60 * 60 * 1000;

      const t = createTelemetry({ path });
      const events = (await t.readAll()).filter((e) => Date.parse(e.ts) >= cutoff);
      const summary = computeSummary(events, since);

      const snapshot: HealthSnapshot = {
        capturedAt: new Date().toISOString(),
        windowDays: since,
        totalRequests: summary.totalRequests,
        cacheHitRate: summary.cacheHitRate,
        fallbackRate: summary.fallbackRate,
        cacheCreationRatio:
          summary.totalCostUsd > 0
            ? summary.cacheCreationCostUsd / summary.totalCostUsd
            : 0,
        avgCostByClass: Object.fromEntries(
          ALL_CLASSES.map((c) => [c, summary.perClass[c].avgCostUsd]),
        ) as Record<Class, number>,
        outputTokensP90ByClass: summary.outputTokensP90ByClass,
      };

      if (cmdOpts.setBaseline) {
        await mkdir(dirname(baselinePath), { recursive: true });
        await writeFile(baselinePath, JSON.stringify(snapshot, null, 2), "utf8");
        if (!parent.quiet) {
          process.stdout.write(
            `\n${header("maestro health — baseline saved")}\n\n` +
            `  ${dim("baseline")}  ${baselinePath}\n` +
            `  ${dim("captured")}  ${snapshot.capturedAt}\n` +
            `  ${dim("requests")}  ${snapshot.totalRequests}\n` +
            `  ${dim("cache hit")} ${(snapshot.cacheHitRate * 100).toFixed(1)}%\n` +
            `  ${dim("fallback")}  ${(snapshot.fallbackRate * 100).toFixed(1)}%\n\n`,
          );
        }
        return;
      }

      // Load baseline
      let baseline: HealthSnapshot | null = null;
      try {
        const raw = await readFile(baselinePath, "utf8");
        baseline = JSON.parse(raw) as HealthSnapshot;
      } catch {
        // No baseline yet
      }

      if (parent.json) {
        process.stdout.write(
          format({ current: snapshot, baseline, regressions: baseline ? computeRegressions(snapshot, baseline) : [] }, { json: true }) + "\n",
        );
        return;
      }

      if (parent.quiet) return;

      const lines: string[] = [];
      lines.push("");
      lines.push(header("maestro health"));

      if (summary.totalRequests === 0) {
        lines.push(`\n  ${dim("no data in the last " + since + "d")}\n`);
        process.stdout.write(lines.join("\n") + "\n");
        return;
      }

      // Current metrics
      lines.push(`\n  ${dim("window")}             last ${since}d  (${summary.totalRequests} requests)`);
      const cacheColor = summary.cacheHitRate >= 0.5 ? green : summary.cacheHitRate >= 0.2 ? yellow : red;
      lines.push(`  ${bold("cache hit rate")}      ${cacheColor((snapshot.cacheHitRate * 100).toFixed(1) + "%")}`);
      const fbColor = summary.fallbackRate < 0.05 ? green : summary.fallbackRate < 0.2 ? yellow : red;
      lines.push(`  ${bold("classifier fallback")}  ${fbColor((snapshot.fallbackRate * 100).toFixed(1) + "%")}  ${dim("(target < 5%)")}`);
      const bootRatio = snapshot.cacheCreationRatio;
      const bootColor = bootRatio > 0.9 ? red : bootRatio > 0.5 ? yellow : green;
      lines.push(
        `  ${bold("session boot ratio")}  ${bootColor((bootRatio * 100).toFixed(1) + "%")}  ${dim("(% of spend on cache_creation)")}`,
      );

      if (!baseline) {
        lines.push(`\n  ${dim("no baseline saved")}  run ${cyan("maestro health --set-baseline")} to save one`);
      } else {
        const regressions = computeRegressions(snapshot, baseline);
        lines.push(`\n  ${dim("baseline from")}  ${baseline.capturedAt.slice(0, 10)}`);

        if (regressions.length === 0) {
          lines.push(`  ${green("✓ no regressions")} vs baseline`);
        } else {
          lines.push(`  ${red(`${regressions.length} regression${regressions.length > 1 ? "s" : ""} detected:`)}`);
          for (const r of regressions) {
            lines.push(`    ${yellow(r.metric)}: ${r.baseline} → ${r.current}  ${red("↑ " + r.changePct + "%")}`);
          }
          lines.push(`\n  ${dim("if regressions are expected, run:")} ${cyan("maestro health --set-baseline")}`);
        }

        // Improvements to celebrate
        const improvements = computeImprovements(snapshot, baseline);
        if (improvements.length > 0) {
          lines.push("");
          for (const i of improvements) {
            lines.push(`  ${green("↓")} ${dim(i.metric)}: ${i.baseline} → ${green(i.current)}  ${dim("improved")}`);
          }
        }
      }

      lines.push("");
      process.stdout.write(lines.join("\n") + "\n");
    });
}

type Regression = {
  metric: string;
  baseline: string;
  current: string;
  changePct: string;
};

function computeRegressions(current: HealthSnapshot, baseline: HealthSnapshot): Regression[] {
  const regressions: Regression[] = [];
  const THRESHOLD = 0.1; // 10% regression triggers warning

  // Cache hit rate: lower is worse
  if (baseline.cacheHitRate > 0.01 && current.cacheHitRate < baseline.cacheHitRate * (1 - THRESHOLD)) {
    const changePct = (((current.cacheHitRate - baseline.cacheHitRate) / baseline.cacheHitRate) * 100).toFixed(1);
    regressions.push({
      metric: "cache hit rate",
      baseline: (baseline.cacheHitRate * 100).toFixed(1) + "%",
      current: (current.cacheHitRate * 100).toFixed(1) + "%",
      changePct,
    });
  }

  // Fallback rate: higher is worse
  if (baseline.fallbackRate > 0.01 && current.fallbackRate > baseline.fallbackRate * (1 + THRESHOLD)) {
    const changePct = (((current.fallbackRate - baseline.fallbackRate) / baseline.fallbackRate) * 100).toFixed(1);
    regressions.push({
      metric: "classifier fallback",
      baseline: (baseline.fallbackRate * 100).toFixed(1) + "%",
      current: (current.fallbackRate * 100).toFixed(1) + "%",
      changePct,
    });
  }

  // Per-class avg cost: higher is worse (check standard and hard which we're optimizing)
  for (const cls of ["standard", "hard", "reasoning"] as Class[]) {
    const b = baseline.avgCostByClass[cls];
    const c = current.avgCostByClass[cls];
    if (b > 0.0001 && c > b * (1 + THRESHOLD)) {
      const changePct = (((c - b) / b) * 100).toFixed(1);
      regressions.push({
        metric: `avg cost (${cls})`,
        baseline: "$" + b.toFixed(4),
        current: "$" + c.toFixed(4),
        changePct,
      });
    }
  }

  // Output tokens p90 for standard: higher is worse
  const stdB = baseline.outputTokensP90ByClass["standard"];
  const stdC = current.outputTokensP90ByClass["standard"];
  if (stdB > 100 && stdC > stdB * (1 + THRESHOLD)) {
    const changePct = (((stdC - stdB) / stdB) * 100).toFixed(1);
    regressions.push({
      metric: "output tokens p90 (standard)",
      baseline: String(stdB),
      current: String(stdC),
      changePct,
    });
  }

  return regressions;
}

type Improvement = { metric: string; baseline: string; current: string };

function computeImprovements(current: HealthSnapshot, baseline: HealthSnapshot): Improvement[] {
  const improvements: Improvement[] = [];
  const THRESHOLD = 0.1;

  if (baseline.cacheHitRate > 0.01 && current.cacheHitRate > baseline.cacheHitRate * (1 + THRESHOLD)) {
    improvements.push({
      metric: "cache hit rate",
      baseline: (baseline.cacheHitRate * 100).toFixed(1) + "%",
      current: (current.cacheHitRate * 100).toFixed(1) + "%",
    });
  }

  if (baseline.fallbackRate > 0.01 && current.fallbackRate < baseline.fallbackRate * (1 - THRESHOLD)) {
    improvements.push({
      metric: "classifier fallback",
      baseline: (baseline.fallbackRate * 100).toFixed(1) + "%",
      current: (current.fallbackRate * 100).toFixed(1) + "%",
    });
  }

  if (baseline.cacheCreationRatio > 0.5 && current.cacheCreationRatio < baseline.cacheCreationRatio * (1 - THRESHOLD)) {
    improvements.push({
      metric: "session boot ratio",
      baseline: (baseline.cacheCreationRatio * 100).toFixed(1) + "%",
      current: (current.cacheCreationRatio * 100).toFixed(1) + "%",
    });
  }

  return improvements;
}
