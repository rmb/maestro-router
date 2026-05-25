// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { writeFile } from "node:fs/promises";
import type { Command } from "commander";
import { createTelemetry } from "../core/telemetry.js";
import { createPostHogQueryClient } from "../core/posthog.js";
import { ALL_CLASSES } from "../core/profile.js";
import type { Class, HeuristicRule, ProfileOverride, TelemetryEvent } from "../core/types.js";
import {
  bold,
  cyan,
  dim,
  gray,
  green,
  header,
  magenta,
  pct,
  yellow,
} from "./render.js";
import {
  DEFAULT_HEURISTICS,
  DEFAULT_TELEMETRY_PATH,
  format,
  loadCliConfig,
  patchState,
  writeUserHeuristics,
} from "./utils.js";
import { loadUserHeuristics } from "../classifiers/heuristic.js";

const COMMUNITY_HEURISTICS_URL =
  "https://raw.githubusercontent.com/rmb/maestro-router/main/community/heuristics.json";

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
    .option("--posthog", "pull override events from PostHog instead of local telemetry (requires posthogQueryKey + posthogProjectId in config)")
    .option("--since <days>", "telemetry window in days", String(PATTERN_WINDOW_DAYS))
    .option("--community-output <path>", "write learned heuristics JSON to path (used by CI)")
    .option("--auto", "background mode: fetch community heuristics + apply local patterns, then exit silently")
    .action(async (cmdOpts: {
      apply?: boolean;
      learn?: boolean;
      posthog?: boolean;
      since: string;
      communityOutput?: string;
      auto?: boolean;
    }) => {
      const parent = program.opts<ParentOptions>();

      // --auto: background mode triggered by run-cmd after N days
      if (cmdOpts.auto) {
        await runAutoTune();
        return;
      }

      const cli = await loadCliConfig(parent.config);
      const since = Math.max(1, parseInt(cmdOpts.since, 10) || PATTERN_WINDOW_DAYS);
      const cutoff = Date.now() - since * 24 * 60 * 60 * 1000;

      let events: TelemetryEvent[];

      if (cmdOpts.posthog) {
        // Env var fallbacks so CI doesn't need ~/.maestro/config.json
        const posthogQueryKey =
          cli.userConfig.posthogQueryKey ?? process.env["MAESTRO_POSTHOG_QUERY_KEY"];
        const posthogProjectId =
          cli.userConfig.posthogProjectId ?? process.env["MAESTRO_POSTHOG_PROJECT_ID"];
        if (!posthogQueryKey || !posthogProjectId) {
          process.stderr.write(
            "maestro tune --posthog: set posthogQueryKey and posthogProjectId in ~/.maestro/config.json\n" +
              "  posthogQueryKey: personal API key from PostHog → Settings → Personal API Keys\n" +
              "  posthogProjectId: numeric project ID from PostHog → Project Settings\n" +
              "  (or set MAESTRO_POSTHOG_QUERY_KEY / MAESTRO_POSTHOG_PROJECT_ID env vars)\n",
          );
          process.exit(1);
        }
        const queryClient = createPostHogQueryClient({ queryKey: posthogQueryKey, projectId: posthogProjectId });
        const overrides = await queryClient.fetchOverrides({ since: new Date(cutoff) });
        events = overrides.map(
          (o): TelemetryEvent => ({
            type: "override",
            ts: o.ts,
            from: o.toClass,
            to: o.toClass,
            prompt: o.prompt,
          }),
        );
        if (!parent.quiet) {
          process.stderr.write(`[maestro] fetched ${events.length} override event(s) from PostHog\n`);
        }
      } else {
        const path = cli.userConfig.telemetryPath ?? DEFAULT_TELEMETRY_PATH;
        const t = createTelemetry({ path });
        events = (await t.readAll()).filter((e) => Date.parse(e.ts) >= cutoff);
      }

      const suggestion = computeSuggestions(events, { learnOnly: cmdOpts.learn === true });

      // --community-output: write clean HeuristicRule[] for CI to commit
      if (cmdOpts.communityOutput) {
        const rules: HeuristicRule[] = suggestion.learnedHeuristics.map((r) => ({
          pattern: r.pattern,
          class: r.class,
          confidence: r.confidence,
          source: r.source,
        }));
        await writeFile(cmdOpts.communityOutput, JSON.stringify(rules, null, 2), "utf8");
        if (!parent.quiet) {
          process.stderr.write(
            `[maestro] wrote ${rules.length} heuristic(s) to ${cmdOpts.communityOutput}\n`,
          );
        }
        return;
      }

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
        const _: ProfileOverride = cli.profileOverrides;
        void _;
      }
    });
}

/**
 * Background auto-tune: fetch community heuristics from GitHub, merge with
 * local ~/.maestro/heuristics.json, update state. Called via `maestro tune --auto`
 * as a detached child process spawned by run-cmd after every autoTuneIntervalDays.
 */
async function runAutoTune(): Promise<void> {
  try {
    const cli = await loadCliConfig();
    const url = cli.userConfig.communityHeuristicsUrl ?? COMMUNITY_HEURISTICS_URL;
    if (!url) return;

    const res = await fetch(url);
    if (!res.ok) return;

    const community = (await res.json()) as HeuristicRule[];
    if (!Array.isArray(community) || community.length === 0) {
      await patchState({ autoTuneLastRunAt: new Date().toISOString() });
      return;
    }

    const existing = await loadUserHeuristics(DEFAULT_HEURISTICS);
    const existingPatterns = new Set(existing.map((r) => r.pattern));
    const newRules = community.filter((r) => !existingPatterns.has(r.pattern));

    if (newRules.length > 0) {
      await writeUserHeuristics([...existing, ...newRules]);
    }

    await patchState({ autoTuneLastRunAt: new Date().toISOString() });
  } catch {
    // background process — never surface errors to the user
  }
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

  lines.push("");
  lines.push(header("Maestro tune"));

  if (s.learnedHeuristics.length === 0) {
    lines.push(`  ${dim("no new patterns")} ${gray("(need ≥" + MIN_PATTERN_OCCURRENCES + " overrides on the same word in the last " + PATTERN_WINDOW_DAYS + " days)")}`);
  } else {
    lines.push(
      `  ${bold("candidate patterns")}  ${cyan(s.learnedHeuristics.length)}  ${dim("(from override events)")}`,
    );
    for (const r of s.learnedHeuristics) {
      lines.push(
        `    ${magenta("/" + r.pattern + "/")}  ${dim("→")}  ${classColor(r.class)(r.class)}  ${gray("×" + r.matchedCount)}  ${dim("conf " + r.confidence.toFixed(2))}`,
      );
    }
  }

  if (s.overrideAdjustments.length > 0) {
    lines.push("");
    lines.push(dim("  classes with high override rates"));
    for (const a of s.overrideAdjustments) {
      const match = /(\d+)\/(\d+) \((\d+)%\)/.exec(a.reason);
      const rate = match?.[3] ? parseInt(match[3], 10) / 100 : 0;
      lines.push(
        `    ${classColor(a.class)(a.class.padEnd(10))} ${yellow(pct(rate, 0))}  ${gray(a.reason.replace(/[\d.%/() ]+$/, ""))}`,
      );
    }
  }

  if (!applying && s.learnedHeuristics.length > 0) {
    lines.push("");
    lines.push(green("  → run `maestro tune --apply` to write these to ~/.maestro/heuristics.json"));
  }

  if (applying && s.learnedHeuristics.length > 0) {
    lines.push("");
    lines.push(green(`  ✓ wrote ${s.learnedHeuristics.length} heuristic(s) to ~/.maestro/heuristics.json`));
  }

  return lines.join("\n");
}

function classColor(cls: Class): (s: string | number) => string {
  switch (cls) {
    case "trivial":
      return gray;
    case "simple":
      return cyan;
    case "standard":
      return green;
    case "hard":
      return yellow;
    case "reasoning":
      return magenta;
    case "max":
      return (s) => bold(magenta(s));
  }
}
