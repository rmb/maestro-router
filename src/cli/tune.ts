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
        const [overrides, corrections] = await Promise.all([
          queryClient.fetchOverrides({ since: new Date(cutoff) }),
          queryClient.fetchCorrections({ since: new Date(cutoff) }),
        ]);
        const overrideEvents: TelemetryEvent[] = overrides.map(
          (o): TelemetryEvent => ({
            type: "override",
            ts: o.ts,
            from: o.toClass,
            to: o.toClass,
            prompt: o.prompt,
          }),
        );
        const correctionEvents: TelemetryEvent[] = corrections.map(
          (c): TelemetryEvent => ({
            type: "correction",
            ts: c.ts,
            sessionId: "",
            prevClass: c.prevClass,
            correctedToClass: c.correctedToClass,
            hint: c.hint,
            prevPrompt: c.prevPrompt,
          }),
        );
        events = [...overrideEvents, ...correctionEvents];
        if (!parent.quiet) {
          process.stderr.write(
            `[maestro] fetched ${overrides.length} override(s) + ${corrections.length} correction(s) from PostHog\n`,
          );
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

// ── Structural feature extraction ────────────────────────────────────────────

type StructuralFeatures = {
  hasCodeBlock: boolean;
  hasTraceback: boolean;
  hasUrl: boolean;
  hasQuestion: boolean;
  firstWord: string;
  lengthBucket: "xs" | "sm" | "md" | "lg" | "xl";
};

function extractStructural(prompt: string): StructuralFeatures {
  const lower = prompt.toLowerCase();
  return {
    hasCodeBlock: /```|`[^`]+`/.test(prompt),
    hasTraceback: /traceback|error:|exception:|at line \d/i.test(prompt),
    hasUrl: /https?:\/\//i.test(prompt),
    hasQuestion: prompt.trimEnd().endsWith("?"),
    firstWord: lower.split(/\s+/)[0] ?? "",
    lengthBucket:
      prompt.length < 80 ? "xs"
      : prompt.length < 250 ? "sm"
      : prompt.length < 600 ? "md"
      : prompt.length < 1500 ? "lg"
      : "xl",
  };
}

function structuralFeatureKeys(sf: StructuralFeatures): string[] {
  const keys: string[] = [];
  if (sf.hasCodeBlock) keys.push("__has_code_block__");
  if (sf.hasTraceback) keys.push("__has_traceback__");
  if (sf.hasUrl) keys.push("__has_url__");
  if (sf.hasQuestion) keys.push("__ends_question__");
  if (sf.firstWord.length >= 3) keys.push(`__first_${sf.firstWord}__`);
  keys.push(`__len_${sf.lengthBucket}__`);
  return keys;
}

// ── Tokenizer: 1-grams + 2-grams ─────────────────────────────────────────────

const STOP_WORDS = new Set([
  "the", "and", "for", "this", "that", "with", "from", "have", "been", "will",
  "your", "they", "are", "was", "can", "but", "not", "you", "all", "any",
  "some", "one", "into", "how", "what", "when", "where", "which", "who",
  "its", "then", "than", "just", "also", "here", "there", "our",
]);

function tokenize(prompt: string): string[] {
  const words = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t));

  // 1-grams
  const tokens: string[] = [...words];
  // 2-grams (adjacent pairs)
  for (let i = 0; i < words.length - 1; i++) {
    tokens.push(`${words[i]} ${words[i + 1]}`);
  }
  return tokens;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Training sample: prompt → intended class ─────────────────────────────────

type TrainingSample = { prompt: string; cls: Class; weight: number };

function isFallbackDecision(classifier: string): boolean {
  return classifier === "forced.standard" || classifier === "default";
}

function resolveFallbackClass(
  prompt: string,
  affinity: ReadonlyMap<string, ReadonlyMap<Class, number>>,
): Class {
  const tally = new Map<Class, number>();
  for (const tok of tokenize(prompt)) {
    const aff = affinity.get(tok);
    if (!aff) continue;
    for (const [c, n] of aff) tally.set(c, (tally.get(c) ?? 0) + n);
  }
  let best: Class = "simple";
  let bestN = 0;
  for (const [c, n] of tally) {
    if (n > bestN) {
      best = c;
      bestN = n;
    }
  }
  return best;
}

function gatherSamples(events: ReadonlyArray<TelemetryEvent>): TrainingSample[] {
  // Pass 1: token → class affinity from successful, confidently auto-routed decisions.
  // Used to infer the intended class for `forced.standard` fallback prompts in pass 2 —
  // those have no class label by construction (the classifier chain produced no signal).
  const affinity = new Map<string, Map<Class, number>>();
  for (const e of events) {
    if (e.type !== "decision") continue;
    if (isFallbackDecision(e.decision.classifier)) continue;
    if (e.decision.confidence < 0.6) continue;
    const p = e.prompt;
    if (!p || p.length === 0) continue;
    for (const token of tokenize(p)) {
      const inner = affinity.get(token) ?? new Map<Class, number>();
      inner.set(e.decision.class, (inner.get(e.decision.class) ?? 0) + 1);
      affinity.set(token, inner);
    }
  }

  const samples: TrainingSample[] = [];
  for (const e of events) {
    if (e.type === "override" && e.prompt?.length > 0) {
      // Explicit user override: weight 1.0
      samples.push({ prompt: e.prompt, cls: e.to, weight: 1.0 });
    } else if (e.type === "correction" && e.prevPrompt?.length > 0) {
      // Implicit correction: prev prompt was mis-classified, weight 1.5 (stronger signal)
      samples.push({ prompt: e.prevPrompt, cls: e.correctedToClass, weight: 1.5 });
    } else if (
      e.type === "decision" &&
      isFallbackDecision(e.decision.classifier) &&
      e.prompt &&
      e.prompt.length > 0
    ) {
      // Forced fallback: classifier chain produced no signal — the prompt is
      // unambiguous evidence the heuristic layer needs to grow. Resolve the
      // intended class via token-affinity from successful decisions; default
      // to "simple" when no affinity exists (most fallbacks are short ambiguous
      // user turns). Weight 1.0 — treat fallbacks as strong signal.
      const cls = resolveFallbackClass(e.prompt, affinity);
      samples.push({ prompt: e.prompt, cls, weight: 1.0 });
    }
  }
  return samples;
}

// ── Learner: precision-calibrated pattern mining ──────────────────────────────

export function computeSuggestions(
  events: ReadonlyArray<TelemetryEvent>,
  opts: { learnOnly: boolean },
): Suggestion {
  const samples = gatherSamples(events);

  // Feature → { class → weighted_count }
  const featureStats = new Map<string, Map<Class, number>>();

  const accumulate = (feature: string, cls: Class, weight: number): void => {
    const inner = featureStats.get(feature) ?? new Map<Class, number>();
    inner.set(cls, (inner.get(cls) ?? 0) + weight);
    featureStats.set(feature, inner);
  };

  for (const { prompt, cls, weight } of samples) {
    for (const token of tokenize(prompt)) {
      accumulate(token, cls, weight);
    }
    for (const key of structuralFeatureKeys(extractStructural(prompt))) {
      accumulate(key, cls, weight);
    }
  }

  const ALPHA = 0.5; // Bayesian smoothing pseudo-count per class

  const learned: LearnedRule[] = [];
  for (const [feature, byClass] of featureStats) {
    // Total weighted count across all classes for this feature
    const totalRaw = [...byClass.values()].reduce((s, v) => s + v, 0);
    if (totalRaw < MIN_PATTERN_OCCURRENCES) continue;

    // Find dominant class
    let bestCls: Class = "standard";
    let bestCount = 0;
    for (const [cls, count] of byClass) {
      if (count > bestCount) {
        bestCls = cls;
        bestCount = count;
      }
    }

    // Precision with Laplace smoothing: (best_count + α) / (total + α * n_classes)
    const precision = (bestCount + ALPHA) / (totalRaw + ALPHA * ALL_CLASSES.length);

    // Only emit patterns with clear class dominance (precision ≥ 0.6)
    if (precision < 0.6) continue;

    const isStructural = feature.startsWith("__");
    const pattern = isStructural
      ? feature // structural keys are not regex patterns; stored as-is for now
      : `\\b${escapeRegex(feature)}\\b`;

    // Skip structural features that aren't directly usable as regex heuristics.
    // They inform override-adjustment reporting only.
    if (isStructural) continue;

    learned.push({
      pattern,
      class: bestCls,
      confidence: Math.min(0.95, Math.max(0.5, precision)),
      source: "auto",
      matchedCount: Math.round(totalRaw),
    });
  }

  const overrideAdjustments: Suggestion["overrideAdjustments"] = [];
  if (!opts.learnOnly) {
    const perClassCount = new Map<Class, number>();
    const perClassOverride = new Map<Class, number>();
    for (const e of events) {
      if (e.type === "decision") {
        perClassCount.set(e.decision.class, (perClassCount.get(e.decision.class) ?? 0) + 1);
      } else if (e.type === "override") {
        perClassOverride.set(e.from, (perClassOverride.get(e.from) ?? 0) + 1);
      } else if (e.type === "correction") {
        perClassOverride.set(e.prevClass, (perClassOverride.get(e.prevClass) ?? 0) + 1);
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
    patternStats: [...featureStats.entries()]
      .filter(([f]) => !f.startsWith("__"))
      .map(([token, m]) => ({
        token,
        correctedFromCount: m,
      })),
  };
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
