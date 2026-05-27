// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import type { Command } from "commander";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { ALL_CLASSES } from "../core/profile.js";
import type { FallbackLogEntry } from "../core/telemetry.js";
import type { Class } from "../core/types.js";
import { bold, cyan, dim, gray, header } from "./render.js";
import { DEFAULT_TELEMETRY_PATH, loadCliConfig } from "./utils.js";

const DEFAULT_FALLBACK_PATH = join(homedir(), ".maestro", "fallbacks.jsonl");

type ParentOptions = { json?: boolean; quiet?: boolean; config?: string };

type CmdOptions = {
  telemetry?: string;
  fallbacks?: boolean;
  output?: string;
  limit?: string;
  keepDuplicates?: boolean;
};

/** Row written to the relabel-ready JSONL. Mirrors evals/labeled.jsonl. */
type ExportRow = {
  prompt: string;
  expectedClass: Class;
  source: "telemetry-export" | "fallback-export";
  decidedClass: Class;
  ts: string;
};

const HELP_DESCRIPTION =
  "Export prompts from telemetry to a relabel-ready JSONL " +
  "(same shape as evals/labeled.jsonl). expectedClass defaults to the " +
  "historical routing decision — review and correct any wrong labels by " +
  "hand before `maestro bench --eval <file>`.";

export function registerExportPromptsCommand(program: Command): void {
  program
    .command("export-prompts")
    .description(HELP_DESCRIPTION)
    .option("--telemetry <path>", "telemetry JSONL path (default: ~/.maestro/decisions.jsonl)")
    .option("--fallbacks", "read from ~/.maestro/fallbacks.jsonl (forced-standard corpus) instead of decisions.jsonl")
    .option("--output <path>", "write JSONL to this file (default: stdout)")
    .option("--limit <n>", "cap number of prompts emitted")
    .option("--keep-duplicates", "do not deduplicate by prompt text", false)
    .action(async (cmdOpts: CmdOptions) => {
      const parent = program.opts<ParentOptions>();
      const cli = await loadCliConfig(parent.config);

      // --fallbacks and --telemetry are mutually exclusive; --fallbacks wins.
      if (cmdOpts.fallbacks && cmdOpts.telemetry) {
        process.stderr.write(
          "maestro export-prompts: --fallbacks and --telemetry are mutually exclusive; using --fallbacks.\n",
        );
      }

      if (cmdOpts.fallbacks) {
        const fallbackPath = DEFAULT_FALLBACK_PATH;
        const { rows, skipped, totalEntries } = await collectFallbackRows(fallbackPath, {
          dedupe: cmdOpts.keepDuplicates !== true,
          limit: parseLimit(cmdOpts.limit),
        });

        const lines = rows.map((r) => JSON.stringify(r)).join("\n");
        const payload = lines.length > 0 ? lines + "\n" : "";

        if (cmdOpts.output) {
          await writeFile(cmdOpts.output, payload, "utf8");
        } else {
          process.stdout.write(payload);
        }

        if (!parent.quiet) {
          const summary = renderFallbackSummary({
            wroteCount: rows.length,
            target: cmdOpts.output ?? "stdout",
            totalEntries,
            skipped,
          });
          process.stderr.write(summary + "\n");
        }
        return;
      }

      const path =
        cmdOpts.telemetry ?? cli.userConfig.telemetryPath ?? DEFAULT_TELEMETRY_PATH;

      const { rows, skipped, totalEvents, decisionEvents } = await collectRows(path, {
        dedupe: cmdOpts.keepDuplicates !== true,
        limit: parseLimit(cmdOpts.limit),
      });

      const lines = rows.map((r) => JSON.stringify(r)).join("\n");
      const payload = lines.length > 0 ? lines + "\n" : "";

      if (cmdOpts.output) {
        await writeFile(cmdOpts.output, payload, "utf8");
      } else {
        process.stdout.write(payload);
      }

      if (!parent.quiet) {
        const summary = renderSummary({
          wroteCount: rows.length,
          target: cmdOpts.output ?? "stdout",
          totalEvents,
          decisionEvents,
          skipped,
          rows,
        });
        process.stderr.write(summary + "\n");
      }
    });
}

type CollectOptions = {
  dedupe: boolean;
  limit: number | null;
};

type FallbackCollectResult = {
  rows: ExportRow[];
  skipped: number;
  totalEntries: number;
};

/**
 * Read fallbacks.jsonl (FallbackLogEntry lines) and convert each entry into a
 * relabel-ready ExportRow with expectedClass="standard". Users should review
 * and correct labels before running `maestro bench --eval <file>`.
 */
export async function collectFallbackRows(
  path: string,
  opts: CollectOptions,
): Promise<FallbackCollectResult> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { rows: [], skipped: 0, totalEntries: 0 };
    }
    throw err;
  }

  const lines = raw.split("\n").filter(Boolean);
  const rows: ExportRow[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  let totalEntries = 0;

  for (const line of lines) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      skipped++;
      continue;
    }
    totalEntries++;
    if (!isFallbackEntry(entry)) {
      skipped++;
      continue;
    }
    const prompt = entry.prompt;
    if (opts.dedupe) {
      if (seen.has(prompt)) continue;
      seen.add(prompt);
    }
    rows.push({
      prompt,
      expectedClass: "standard",
      source: "fallback-export",
      decidedClass: "standard",
      ts: entry.ts,
    });
    if (opts.limit !== null && rows.length >= opts.limit) break;
  }

  return { rows, skipped, totalEntries };
}

function isFallbackEntry(entry: unknown): entry is FallbackLogEntry {
  if (typeof entry !== "object" || entry === null) return false;
  const e = entry as Record<string, unknown>;
  return (
    typeof e.ts === "string" &&
    typeof e.prompt === "string" &&
    e.prompt.length > 0 &&
    typeof e.classifier === "string" &&
    typeof e.cwd === "string" &&
    Array.isArray(e.diagnostics)
  );
}

type CollectResult = {
  rows: ExportRow[];
  skipped: number;
  totalEvents: number;
  decisionEvents: number;
};

/**
 * Read a JSONL telemetry file and turn every decision event that carries a
 * non-empty prompt into a relabel-ready row. Malformed lines are skipped
 * (counted) so partial writes never abort the export.
 */
export async function collectRows(
  path: string,
  opts: CollectOptions,
): Promise<CollectResult> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { rows: [], skipped: 0, totalEvents: 0, decisionEvents: 0 };
    }
    throw err;
  }

  const lines = raw.split("\n").filter(Boolean);
  const rows: ExportRow[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  let totalEvents = 0;
  let decisionEvents = 0;

  for (const line of lines) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      skipped++;
      continue;
    }
    totalEvents++;
    if (!isDecisionWithPrompt(event)) continue;
    decisionEvents++;
    const prompt = event.prompt;
    if (opts.dedupe) {
      if (seen.has(prompt)) continue;
      seen.add(prompt);
    }
    rows.push({
      prompt,
      expectedClass: event.decision.class,
      source: "telemetry-export",
      decidedClass: event.decision.class,
      ts: event.ts,
    });
    if (opts.limit !== null && rows.length >= opts.limit) break;
  }

  return { rows, skipped, totalEvents, decisionEvents };
}

type DecisionWithPrompt = {
  type: "decision";
  ts: string;
  prompt: string;
  decision: { class: Class };
};

function isDecisionWithPrompt(event: unknown): event is DecisionWithPrompt {
  if (typeof event !== "object" || event === null) return false;
  const e = event as Record<string, unknown>;
  if (e.type !== "decision") return false;
  if (typeof e.ts !== "string") return false;
  if (typeof e.prompt !== "string" || e.prompt.length === 0) return false;
  const decision = e.decision;
  if (typeof decision !== "object" || decision === null) return false;
  const cls = (decision as Record<string, unknown>).class;
  return typeof cls === "string" && (ALL_CLASSES as ReadonlyArray<string>).includes(cls);
}

function parseLimit(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n <= 0) return null;
  return n;
}

type SummaryInput = {
  wroteCount: number;
  target: string;
  totalEvents: number;
  decisionEvents: number;
  skipped: number;
  rows: ReadonlyArray<ExportRow>;
};

function renderSummary(s: SummaryInput): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(header("export-prompts"));
  lines.push(
    `  ${bold("wrote")}           ${cyan(s.wroteCount)} ${gray("prompts to")} ${s.target}`,
  );
  lines.push(
    `  ${bold("scanned")}         ${cyan(s.totalEvents)} ${gray("events")} ${dim(
      `(${s.decisionEvents} decisions with prompt, ${s.skipped} malformed lines)`,
    )}`,
  );
  const perClass = countPerClass(s.rows);
  const nonZero = (ALL_CLASSES as ReadonlyArray<Class>).filter((c) => perClass[c] > 0);
  if (nonZero.length > 0) {
    const parts = nonZero.map((c) => `${perClass[c]} ${c}`);
    lines.push(`  ${bold("by class")}        ${cyan(parts.join(", "))}`);
  }
  lines.push("");
  lines.push(
    dim(
      "  Review the file and fix any wrong `expectedClass` values before " +
        "running `maestro bench --eval <file>`.",
    ),
  );
  return lines.join("\n");
}

function countPerClass(rows: ReadonlyArray<ExportRow>): Record<Class, number> {
  const out = {} as Record<Class, number>;
  for (const c of ALL_CLASSES) out[c] = 0;
  for (const r of rows) out[r.expectedClass]++;
  return out;
}

type FallbackSummaryInput = {
  wroteCount: number;
  target: string;
  totalEntries: number;
  skipped: number;
};

function renderFallbackSummary(s: FallbackSummaryInput): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(header("export-prompts (fallbacks)"));
  lines.push(
    `  ${bold("wrote")}           ${cyan(s.wroteCount)} ${gray("prompts to")} ${s.target}`,
  );
  lines.push(
    `  ${bold("scanned")}         ${cyan(s.totalEntries)} ${gray("fallback entries")} ${dim(
      `(${s.skipped} malformed lines)`,
    )}`,
  );
  lines.push(`  ${bold("source")}          ${dim("~/.maestro/fallbacks.jsonl")}`);
  lines.push("");
  lines.push(
    dim(
      "  All entries labeled 'standard' — review and correct before bench.",
    ),
  );
  lines.push(
    dim(
      "  Run `maestro bench --eval <file>` after relabeling.",
    ),
  );
  return lines.join("\n");
}
