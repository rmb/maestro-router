// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import type { DimensionResult, CheckResult, PerDecisionVerdict } from "./telemetry-correctness.js";
import { bold, dim, green, red, header } from "../../cli/render.js";

export type { DimensionResult, CheckResult, PerDecisionVerdict };

export type OracleReport = {
  generatedAt: string;
  windowDays: number;
  totalEvents: number;
  dimensions: DimensionResult[];
  overallPass: boolean;
  /**
   * Per-decision correctness verdicts aggregated from all checks that emit
   * row-level signal (currently: flag-coverage). Emitted in `--json` output
   * for use by `calibrate-threshold.py --oracle`.
   * Omitted from text output (too verbose for the terminal).
   */
  perDecision?: PerDecisionVerdict[];
};

export function buildReport(params: {
  generatedAt?: string;
  windowDays: number;
  totalEvents: number;
  dimensions: DimensionResult[];
}): OracleReport {
  const perDecision = params.dimensions
    .flatMap((d) => d.checks)
    .flatMap((c) => c.verdicts ?? []);

  return {
    generatedAt: params.generatedAt ?? new Date().toISOString(),
    windowDays: params.windowDays,
    totalEvents: params.totalEvents,
    dimensions: params.dimensions,
    overallPass: params.dimensions.every((d) => d.pass),
    ...(perDecision.length > 0 ? { perDecision } : {}),
  };
}

export function printReport(
  report: OracleReport,
  opts?: { quiet?: boolean; json?: boolean },
): string {
  if (opts?.quiet) return "";
  if (opts?.json) return JSON.stringify(report, null, 2);

  const dateStr = report.generatedAt.slice(0, 10);
  const title = `maestro oracle — ${dateStr}  (${report.windowDays}d, ${report.totalEvents} events)`;
  const lines: string[] = [];

  lines.push(header(title));
  lines.push("");

  // Dimension summary lines
  for (const dim_ of report.dimensions) {
    const icon = dim_.pass ? green("✓") : red("✗");
    const passCount = dim_.checks.filter((c) => c.pass).length;
    const total = dim_.checks.length;
    lines.push(`${icon} ${bold(dim_.dimension)}   [${passCount}/${total} checks passed]`);
  }

  // Failure detail blocks
  for (const dim_ of report.dimensions) {
    const failing = dim_.checks.filter((c) => !c.pass);
    if (failing.length === 0) continue;

    lines.push("");
    lines.push(`  ${dim_.dimension} failures:`);

    for (const check of failing) {
      const valueStr = typeof check.value === "number"
        ? `${check.value}`
        : check.value;
      const gatePart = check.gate != null ? `   gate: ${check.gate}` : "";
      lines.push(`    ${red("✗")} ${check.name}   value: ${valueStr}${gatePart}`);
      if (check.detail != null) {
        lines.push(dim(`      → ${check.detail}`));
      }
    }
  }

  lines.push("");

  const passedCount = report.dimensions.filter((d) => d.pass).length;
  const total = report.dimensions.length;
  const overallLine = `Overall: ${passedCount}/${total} dimensions passed`;
  const suffix = report.overallPass ? "" : "  ←  exit 1";
  lines.push(report.overallPass ? green(overallLine) + suffix : red(overallLine) + suffix);

  return lines.join("\n");
}
