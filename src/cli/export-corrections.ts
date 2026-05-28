// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import type { Command } from "commander";
import { readFile, writeFile } from "node:fs/promises";
import { openDb } from "../core/db.js";
import type { MaestroDb } from "../core/db.js";
import { ALL_CLASSES } from "../core/profile.js";
import type { Class } from "../core/types.js";
import { bold, cyan, dim, gray, header } from "./render.js";
import { DEFAULT_TELEMETRY_PATH, loadCliConfig } from "./utils.js";

type ParentOptions = { json?: boolean; quiet?: boolean; config?: string };

type CmdOptions = {
  telemetry?: string;
  output?: string;
  limit?: string;
  minCount?: string;
};

/** Row written to the DSPy-ready corrections JSONL. */
export type CorrectionRow = {
  prompt: string;
  prevClass: Class;
  correctClass: Class;
  hint: string;
  ts: string;
};

const HELP_DESCRIPTION =
  "Export correction events from telemetry to a DSPy-ready JSONL. " +
  "Corrections are emitted when the user follows an auto-routed turn " +
  "with @fast, @deep, or @think — the strongest implicit mis-classification " +
  "signal. Use the output with scripts/dspy-optimize.py to tune the LLM " +
  "classifier's few-shot examples.";

export function registerExportCorrectionsCommand(program: Command): void {
  program
    .command("export-corrections")
    .description(HELP_DESCRIPTION)
    .option(
      "--telemetry <path>",
      "telemetry JSONL path (default: ~/.maestro/decisions.jsonl)",
    )
    .option("--output <path>", "write JSONL to this file (default: stdout)")
    .option("--limit <n>", "cap number of rows emitted")
    .option(
      "--min-count <n>",
      "only emit prompts corrected at least N times (default: 1)",
    )
    .action(async (cmdOpts: CmdOptions) => {
      const parent = program.opts<ParentOptions>();
      const cli = await loadCliConfig(parent.config);

      const path =
        cmdOpts.telemetry ??
        cli.userConfig.telemetryPath ??
        DEFAULT_TELEMETRY_PATH;

      const dbPath = path.endsWith(".jsonl")
        ? path.slice(0, -6) + ".db"
        : path + ".db";
      const db = openDb(dbPath);

      const opts: CollectOptions = {
        limit: parseLimit(cmdOpts.limit),
        minCount: parseLimit(cmdOpts.minCount) ?? 1,
      };

      const { rows, totalEvents, correctionEvents, skipped } =
        db !== null && db.count() > 0
          ? collectCorrectionRowsFromDb(db, opts)
          : await collectCorrectionRows(path, opts);

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
          correctionEvents,
          skipped,
          rows,
        });
        process.stderr.write(summary + "\n");
      }
    });
}

type CollectOptions = {
  limit: number | null;
  minCount: number;
};

export type CollectCorrectionResult = {
  rows: CorrectionRow[];
  totalEvents: number;
  correctionEvents: number;
  skipped: number;
};

/**
 * Read a JSONL telemetry file and turn every correction event into a
 * DSPy-ready row. Respects `minCount` by grouping by prompt and only
 * emitting prompts that were corrected at least that many times.
 */
export async function collectCorrectionRows(
  path: string,
  opts: CollectOptions,
): Promise<CollectCorrectionResult> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { rows: [], totalEvents: 0, correctionEvents: 0, skipped: 0 };
    }
    throw err;
  }

  const lines = raw.split("\n").filter(Boolean);
  let skipped = 0;
  let totalEvents = 0;
  let correctionEvents = 0;

  // Accumulate all correction candidates first (needed for minCount filter).
  const candidates: CorrectionRow[] = [];

  for (const line of lines) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      skipped++;
      continue;
    }
    totalEvents++;
    if (!isCorrectionEvent(event)) continue;
    correctionEvents++;
    candidates.push({
      prompt: event.prevPrompt,
      prevClass: event.prevClass,
      correctClass: event.correctedToClass,
      hint: event.hint,
      ts: event.ts,
    });
  }

  const rows = applyFilters(candidates, opts);
  return { rows, totalEvents, correctionEvents, skipped };
}

/**
 * SQLite-backed variant. Reads raw_json for correction rows so we get the
 * full event fields without a full-table JSON scan in TS.
 */
export function collectCorrectionRowsFromDb(
  db: MaestroDb,
  opts: CollectOptions,
): CollectCorrectionResult {
  const totalEventsRow = db.query(
    "SELECT COUNT(*) AS n FROM events",
  ) as Array<{ n: number }>;
  const totalEvents = totalEventsRow[0]?.n ?? 0;

  const rawRows = db.query(
    `SELECT raw_json FROM events WHERE type = 'correction' ORDER BY id`,
  ) as Array<{ raw_json: string }>;

  const candidates: CorrectionRow[] = [];
  let correctionEvents = 0;

  for (const r of rawRows) {
    let event: unknown;
    try {
      event = JSON.parse(r.raw_json);
    } catch {
      continue;
    }
    if (!isCorrectionEvent(event)) continue;
    correctionEvents++;
    candidates.push({
      prompt: event.prevPrompt,
      prevClass: event.prevClass,
      correctClass: event.correctedToClass,
      hint: event.hint,
      ts: event.ts,
    });
  }

  const rows = applyFilters(candidates, opts);
  return { rows, totalEvents, correctionEvents, skipped: 0 };
}

/**
 * Apply minCount deduplication and limit. When minCount > 1, only prompts
 * that appear at least that many times in corrections are retained. The last
 * correction event for each prompt is used as the canonical row.
 */
function applyFilters(
  candidates: CorrectionRow[],
  opts: CollectOptions,
): CorrectionRow[] {
  if (opts.minCount <= 1) {
    const out = candidates;
    if (opts.limit !== null) return out.slice(0, opts.limit);
    return out;
  }

  // Count occurrences per prompt.
  const countMap = new Map<string, number>();
  for (const c of candidates) {
    countMap.set(c.prompt, (countMap.get(c.prompt) ?? 0) + 1);
  }

  // Keep last occurrence for each prompt that meets the threshold.
  const seen = new Set<string>();
  const filtered: CorrectionRow[] = [];
  // Iterate in reverse to keep last occurrence; reverse again at the end.
  for (let i = candidates.length - 1; i >= 0; i--) {
    const c = candidates[i]!;
    if (seen.has(c.prompt)) continue;
    if ((countMap.get(c.prompt) ?? 0) < opts.minCount) continue;
    seen.add(c.prompt);
    filtered.push(c);
  }
  filtered.reverse();

  if (opts.limit !== null) return filtered.slice(0, opts.limit);
  return filtered;
}

type CorrectionEvent = {
  type: "correction";
  ts: string;
  sessionId: string;
  prevClass: Class;
  correctedToClass: Class;
  hint: string;
  prevPrompt: string;
};

function isCorrectionEvent(event: unknown): event is CorrectionEvent {
  if (typeof event !== "object" || event === null) return false;
  const e = event as Record<string, unknown>;
  if (e.type !== "correction") return false;
  if (typeof e.ts !== "string") return false;
  if (typeof e.prevPrompt !== "string" || e.prevPrompt.length === 0) return false;
  if (
    typeof e.prevClass !== "string" ||
    !(ALL_CLASSES as ReadonlyArray<string>).includes(e.prevClass)
  )
    return false;
  if (
    typeof e.correctedToClass !== "string" ||
    !(ALL_CLASSES as ReadonlyArray<string>).includes(e.correctedToClass)
  )
    return false;
  if (typeof e.hint !== "string") return false;
  return true;
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
  correctionEvents: number;
  skipped: number;
  rows: ReadonlyArray<CorrectionRow>;
};

function renderSummary(s: SummaryInput): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(header("export-corrections"));
  lines.push(
    `  ${bold("wrote")}           ${cyan(s.wroteCount)} ${gray("corrections to")} ${s.target}`,
  );
  lines.push(
    `  ${bold("scanned")}         ${cyan(s.totalEvents)} ${gray("events")} ${dim(
      `(${s.correctionEvents} correction events, ${s.skipped} malformed lines)`,
    )}`,
  );

  // Breakdown by prevClass → correctClass transitions.
  const transitions = buildTransitionMap(s.rows);
  const transKeys = Object.keys(transitions).sort();
  if (transKeys.length > 0) {
    const parts = transKeys.map((k) => `${transitions[k]} ${k}`);
    lines.push(
      `  ${bold("transitions")}     ${cyan(parts.join(", "))}`,
    );
  }

  lines.push("");
  lines.push(
    dim(
      "  Feed to DSPy optimizer: python scripts/dspy-optimize.py --input <file>",
    ),
  );
  return lines.join("\n");
}

function buildTransitionMap(
  rows: ReadonlyArray<CorrectionRow>,
): Record<string, number> {
  const map: Record<string, number> = {};
  for (const r of rows) {
    const key = `${r.prevClass}→${r.correctClass}`;
    map[key] = (map[key] ?? 0) + 1;
  }
  return map;
}
