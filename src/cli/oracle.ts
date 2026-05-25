// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { computeSummary } from "./stats.js";
import { DEFAULT_TELEMETRY_PATH, loadCliConfig } from "./utils.js";
import { loadWindow, pairDecisionsWithOutcomes } from "../eval/oracle/reader.js";
import { runToolCorrectness } from "../eval/oracle/tool-correctness.js";
import { runTelemetryCorrectness, type StatsSummary, type DimensionResult } from "../eval/oracle/telemetry-correctness.js";
import { runTokensSaved, DEFAULT_PRICING } from "../eval/oracle/tokens-saved.js";
import { runOutputQuality, type SpawnFn } from "../eval/oracle/output-quality.js";
import { spawnClaude } from "../wrapper/spawn.js";
import { resolveBundledEval } from "./bench.js";
import { buildReport, printReport } from "../eval/oracle/report.js";
import type { SessionRecord } from "../wrapper/session.js";

const SESSIONS_PATH = join(homedir(), ".maestro", "sessions.json");

const VALID_DIMENSIONS = new Set(["tool", "telemetry", "tokens", "quality"]);

type ParentOptions = { json?: boolean; quiet?: boolean; config?: string };

function collect(val: string, acc: string[]): string[] {
  acc.push(val);
  return acc;
}

export function registerOracleCommand(program: Command): void {
  program
    .command("oracle")
    .description(
      "Multi-dimensional correctness evaluation: tool behaviour, telemetry accuracy, token savings, and quality sampling.",
    )
    .option("--since <days>", "evaluation window in days", "7")
    .option("--dimension <dim>", "run a specific dimension only (repeatable)", collect, [] as string[])
    .option("--quality-sample <n>", "tournament probe size for quality dimension", "20")
    .option("--confirm-cost", "required when quality dimension is requested")
    .option("--baseline <path>", "compare against a health baseline file (reserved for future use)")
    .action(async (cmdOpts: {
      since: string;
      dimension: string[];
      qualitySample: string;
      confirmCost?: boolean;
      baseline?: string;
    }) => {
      const parent = program.opts<ParentOptions>();
      const cli = await loadCliConfig(parent.config);
      const telemetryPath = cli.userConfig.telemetryPath ?? DEFAULT_TELEMETRY_PATH;
      const since = Math.max(1, parseInt(cmdOpts.since, 10) || 7);
      const sinceMs = Date.now() - since * 24 * 60 * 60 * 1000;

      // Validate requested dimensions
      const requestedDims = cmdOpts.dimension;
      for (const d of requestedDims) {
        if (!VALID_DIMENSIONS.has(d)) {
          process.stderr.write(
            `maestro oracle: unknown dimension "${d}". Valid: tool, telemetry, tokens, quality\n`,
          );
          process.exitCode = 1;
          return;
        }
      }

      // Quality dimension requires --confirm-cost
      const qualityExplicit = requestedDims.includes("quality");
      if (qualityExplicit && !cmdOpts.confirmCost) {
        process.stderr.write(
          "maestro oracle: quality dimension spawns models and may incur cost.\n" +
          "Re-run with --confirm-cost to proceed.\n",
        );
        process.exitCode = 1;
        return;
      }

      // Determine which dimensions to run
      // Default (no --dimension): tool + telemetry + tokens (quality excluded)
      let dimsToRun: Array<"tool" | "telemetry" | "tokens" | "quality">;
      if (requestedDims.length === 0) {
        dimsToRun = ["tool", "telemetry", "tokens"];
      } else {
        dimsToRun = requestedDims as Array<"tool" | "telemetry" | "tokens" | "quality">;
      }

      // Load events
      const events = await loadWindow(telemetryPath, sinceMs);
      const pairs = pairDecisionsWithOutcomes(events);

      // Load sessions
      let sessions: SessionRecord[] = [];
      try {
        const raw = await readFile(SESSIONS_PATH, "utf8");
        sessions = JSON.parse(raw) as SessionRecord[];
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          // Non-ENOENT error: sessions file exists but unreadable — proceed with empty
        }
        // ENOENT: no sessions file yet, use empty array
      }

      // Compute stats summary for telemetry dimension
      const statsSummary: StatsSummary = computeSummary(events, since);

      const baselineDate = new Date(sinceMs);

      // Run each dimension
      const dimensionResults: DimensionResult[] = [];

      for (const dim of dimsToRun) {
        if (dim === "tool") {
          dimensionResults.push(runToolCorrectness(events, sessions));
        } else if (dim === "telemetry") {
          dimensionResults.push(runTelemetryCorrectness(events, pairs, statsSummary));
        } else if (dim === "tokens") {
          dimensionResults.push(runTokensSaved(events, baselineDate, DEFAULT_PRICING));
        } else if (dim === "quality") {
          const spawnFn: SpawnFn = (opts) =>
            spawnClaude({ args: [...opts.args], prompt: opts.prompt });
          dimensionResults.push(await runOutputQuality(events, {
            evalSetPath: resolveBundledEval(undefined),
            sampleSize: parseInt(cmdOpts.qualitySample, 10) || 20,
            spawnFn,
            userConfig: cli.userConfig,
          }));
        }
      }

      const report = buildReport({
        windowDays: since,
        totalEvents: events.length,
        dimensions: dimensionResults,
      });

      process.stdout.write(printReport(report, {
        json: parent.json ?? false,
        quiet: parent.quiet ?? false,
      }) + "\n");

      if (!report.overallPass) {
        process.exitCode = 1;
      }
    });
}
