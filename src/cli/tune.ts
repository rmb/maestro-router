// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import type { Command } from "commander";
import { createTelemetry } from "../core/telemetry.js";
import { ALL_CLASSES } from "../core/profile.js";
import type { Class, HeuristicRule, ProfileOverride, TelemetryEvent } from "../core/types.js";
import {
  DEFAULT_TELEMETRY_PATH,
  format,
  loadCliConfig,
  writeUserHeuristics,
} from "./utils.js";

const MIN_PATTERN_OCCURRENCES = 5;
const PATTERN_WINDOW_DAYS = 30;

type ParentOptions = { json?: boolean; quiet?: boolean; config?: string };

type LearnedRule = {
  pattern: string;
  class: Class;
  confidence: number;
  source: "auto";
  matchedCount: number;
};

type Suggestion = {
  overrideAdjustments: { class: Class; reason: string }[];
  learnedHeuristics: LearnedRule[];
  patternStats: { token: string; correctedFromCount: Map<Class, number> }[];
};

export function registerTuneCommand(program: Command): void {
  program
    .command("tune")
    .description("Analyze telemetry, suggest profile + heuristic tweaks")
    .option("--apply", "write suggestions to ~/.maestro/profile-overrides.json and heuristics.json")
    .option("--learn", "focus on mining new heuristic patterns from override events")
    .option("--since <days>", "telemetry window in days", String(PATTERN_WINDOW_DAYS))
    .action(async (cmdOpts: { apply?: boolean; learn?: boolean; since: string }) => {
      const parent = program.opts<ParentOptions>();
      const cli = await loadCliConfig(parent.config);
      const path = cli.userConfig.telemetryPath ?? DEFAULT_TELEMETRY_PATH;
      const since = Math.max(1, parseInt(cmdOpts.since, 10) || PATTERN_WINDOW_DAYS);
      const cutoff = Date.now() - since * 24 * 60 * 60 * 1000;

      const t = createTelemetry({ path });
      const events = (await t.readAll()).filter((e) => Date.parse(e.ts) >= cutoff);
      const suggestion = computeSuggestions(events, { learnOnly: cmdOpts.learn === true });

      if (parent.json) {
        process.stdout.write(format(suggestion, { json: true }) + "\n");
      } else if (!parent.quiet) {
        process.stdout.write(renderHuman(suggestion, cmdOpts.apply === true) + "\n");
      }

      if (cmdOpts.apply) {
        if (suggestion.learnedHeuristics.length > 0) {
          const existing = cli.userHeuristics;
          const merged: HeuristicRule[] = [
            ...existing,
            ...suggestion.learnedHeuristics.map(
              (r): HeuristicRule => ({
                pattern: r.pattern,
                class: r.class,
                confidence: r.confidence,
                source: r.source,
              }),
            ),
          ];
          await writeUserHeuristics(merged);
          if (!parent.quiet) {
            process.stdout.write(
              `\nWrote ${suggestion.learnedHeuristics.length} new heuristic(s) to ~/.maestro/heuristics.json\n`,
            );
          }
        }
        // Profile override changes: noop for now — we surface them only as text suggestions in v0.2.
        // ProfileOverride writing reserved for future when we adjust by realized cost / latency.
        const _: ProfileOverride = cli.profileOverrides;
        void _;
      }
    });
}

export function computeSuggestions(
  events: ReadonlyArray<TelemetryEvent>,
  opts: { learnOnly: boolean },
): Suggestion {
  // Index recent decisions by sessionId so we can correlate override events.
  const overrides = events.filter((e): e is Extract<TelemetryEvent, { type: "override" }> => e.type === "override");

  // Mine simple token-frequency patterns from override events.
  const tokenStats = new Map<string, Map<Class, number>>();
  for (const o of overrides) {
    for (const token of tokenize(o.prompt)) {
      if (token.length < 4) continue; // ignore short/common tokens
      const inner = tokenStats.get(token) ?? new Map<Class, number>();
      inner.set(o.to, (inner.get(o.to) ?? 0) + 1);
      tokenStats.set(token, inner);
    }
  }

  const learned: LearnedRule[] = [];
  for (const [token, byClass] of tokenStats) {
    for (const [cls, count] of byClass) {
      if (count >= MIN_PATTERN_OCCURRENCES) {
        learned.push({
          pattern: `\\b${escapeRegex(token)}\\b`,
          class: cls,
          confidence: 0.85,
          source: "auto",
          matchedCount: count,
        });
      }
    }
  }

  const overrideAdjustments: Suggestion["overrideAdjustments"] = [];
  if (!opts.learnOnly) {
    // Per-class override-rate observation: if a class has high override rate,
    // surface a textual suggestion to revisit it.
    const perClassCount = new Map<Class, number>();
    const perClassOverride = new Map<Class, number>();
    for (const e of events) {
      if (e.type === "decision") {
        perClassCount.set(e.decision.class, (perClassCount.get(e.decision.class) ?? 0) + 1);
      } else if (e.type === "override") {
        perClassOverride.set(e.from, (perClassOverride.get(e.from) ?? 0) + 1);
      }
    }
    for (const cls of ALL_CLASSES) {
      const count = perClassCount.get(cls) ?? 0;
      const overrideCount = perClassOverride.get(cls) ?? 0;
      if (count >= 10 && overrideCount / count > 0.2) {
        overrideAdjustments.push({
          class: cls,
          reason: `${overrideCount}/${count} (${((overrideCount / count) * 100).toFixed(0)}%) decisions overridden — consider revising the class spec or adding a heuristic`,
        });
      }
    }
  }

  return {
    overrideAdjustments,
    learnedHeuristics: learned.sort((a, b) => b.matchedCount - a.matchedCount),
    patternStats: [...tokenStats.entries()].map(([token, m]) => ({
      token,
      correctedFromCount: m,
    })),
  };
}

function tokenize(prompt: string): string[] {
  return prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderHuman(s: Suggestion, applying: boolean): string {
  const lines: string[] = [];
  lines.push("Maestro tune analysis");
  if (s.learnedHeuristics.length === 0) {
    lines.push("  no new heuristic patterns to suggest (need ≥5 overrides on the same word)");
  } else {
    lines.push(`  ${s.learnedHeuristics.length} candidate heuristic pattern(s):`);
    for (const r of s.learnedHeuristics) {
      lines.push(
        `    /${r.pattern}/  →  ${r.class}  (matched ${r.matchedCount} overrides, confidence ${r.confidence})`,
      );
    }
  }
  if (s.overrideAdjustments.length > 0) {
    lines.push("");
    lines.push("  Classes with high override rates:");
    for (const a of s.overrideAdjustments) {
      lines.push(`    ${a.class}: ${a.reason}`);
    }
  }
  if (!applying && s.learnedHeuristics.length > 0) {
    lines.push("");
    lines.push("Re-run with --apply to write these to ~/.maestro/heuristics.json.");
  }
  return lines.join("\n");
}
