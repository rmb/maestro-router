// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import type { Command } from "commander";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { embeddingClassifier } from "../classifiers/embedding.js";
import { createHeuristicClassifier, heuristicClassifier } from "../classifiers/heuristic.js";
import { llmClassifier } from "../classifiers/llm.js";
import { markovClassifier } from "../classifiers/markov.js";
import { overrideClassifier } from "../classifiers/override.js";
import { turnTypeClassifier } from "../classifiers/turn-type.js";
import { ALL_CLASSES } from "../core/profile.js";
import { createPipeline } from "../core/pipeline.js";
import { loadProfile } from "../core/profile.js";
import type { Class, Classifier, HeuristicRule, Message, Profile, ProfileOverride, Request } from "../core/types.js";
import { stratifiedSample } from "../eval/sample-stratified.js";
import {
  buildProposedHeuristics,
  DOWNGRADE,
  runTournament,
  type MatrixCell,
  type MatrixResult,
  type TournamentInput,
  type TournamentProgress,
  type TournamentReport,
  type TournamentRowResult,
} from "../eval/tournament.js";
import {
  accuracyColor,
  bar,
  bold,
  cyan,
  dim,
  gray,
  header,
  magenta,
  pct,
  yellow,
} from "./render.js";
import { format, loadCliConfig } from "./utils.js";

type ParentOptions = { json?: boolean; quiet?: boolean; config?: string };

export type LabeledEntry = {
  prompt: string;
  expectedClass: Class;
  lastRole?: "user" | "assistant" | "tool" | "system";
  source: string;
};

export type BenchReport = {
  total: number;
  correct: number;
  accuracy: number;
  perClass: Record<string, { total: number; correct: number; accuracy: number }>;
  confusion: Record<string, number>;
  latencyMs: { p50: number; p95: number };
};

export function registerBenchCommand(program: Command): void {
  program
    .command("bench")
    .description("Run the eval suite against the current pipeline")
    .option("--eval <path>", "labeled JSONL file (default: bundled evals/labeled.jsonl)")
    .option("--baseline <path>", "baseline JSON for regression check (default: bundled evals/baseline.json)")
    .option("--gate <pct>", "regression gate (0-1)", "0.02")
    .option("--propose <path>", "validate a proposed profile-overrides.json before applying")
    .option("--eval-heuristics <path>", "merge a bare HeuristicRule[] JSON (community/heuristics.json) before evaling — used by CI gate")
    .option("--tournament", "run model-tier downgrade tournament with real Claude calls (S4)")
    .option("--tournament-sample <n>", "tournament: number of prompts to run", "10")
    .option("--tournament-budget <usd>", "tournament: cost cap before aborting", "5")
    .option("--tournament-seed <n>", "tournament: deterministic sample seed (default: input order)")
    .option("--tournament-resume <path>", "tournament: resume from a partial-result JSONL")
    .option("--confirm-cost", "tournament: required to actually spend money")
    .option("--tournament-output <path>", "tournament: write proposed overrides + heuristics here")
    .option("--tournament-matrix", "tournament: also test same-model effort-step-down variant per prompt (matrix mode)")
    .option("--update-baseline", "write the new report as the baseline")
    .option("--llm", "include the LLM classifier (costs ~$0.001 per uncertain prompt; default off)")
    .option("--embedding", "include the in-process embedding classifier (requires @xenova/transformers; default off)")
    .action(
      async (cmdOpts: {
        eval: string;
        baseline: string;
        gate: string;
        propose?: string;
        evalHeuristics?: string;
        tournament?: boolean;
        tournamentSample?: string;
        tournamentBudget?: string;
        tournamentSeed?: string;
        tournamentResume?: string;
        confirmCost?: boolean;
        tournamentOutput?: string;
        tournamentMatrix?: boolean;
        updateBaseline?: boolean;
        llm?: boolean;
        embedding?: boolean;
      }) => {
        const parent = program.opts<ParentOptions>();
        const cli = await loadCliConfig(parent.config);

        const evalPath = resolveBundledEval(cmdOpts.eval);
        const data = await readFile(evalPath, "utf8");
        const entries = data
          .split("\n")
          .filter((l) => l.trim().length > 0)
          .map((l) => JSON.parse(l) as LabeledEntry);

        // Apply --propose overlay if given
        let overrides: ProfileOverride = cli.profileOverrides;
        let extraHeuristics: HeuristicRule[] = cli.userHeuristics;
        if (cmdOpts.evalHeuristics) {
          const raw = await readFile(resolve(cmdOpts.evalHeuristics), "utf8");
          const communityRules = JSON.parse(raw) as HeuristicRule[];
          if (Array.isArray(communityRules)) {
            extraHeuristics = [...extraHeuristics, ...communityRules];
          }
        }
        if (cmdOpts.propose) {
          const proposedRaw = await readFile(resolve(cmdOpts.propose), "utf8");
          const proposed = JSON.parse(proposedRaw) as
            | ProfileOverride
            | { overrides?: ProfileOverride; heuristics?: HeuristicRule[] };
          if (
            typeof proposed === "object" &&
            proposed !== null &&
            ("overrides" in proposed || "heuristics" in proposed)
          ) {
            const obj = proposed as { overrides?: ProfileOverride; heuristics?: HeuristicRule[] };
            overrides = obj.overrides ?? overrides;
            extraHeuristics = obj.heuristics ?? extraHeuristics;
          } else {
            overrides = proposed as ProfileOverride;
          }
        }

        const { profile } = loadProfile({
          userConfig: cli.userConfig,
          overrides,
        });
        const heuristic =
          extraHeuristics.length > 0
            ? createHeuristicClassifier({ extraRules: extraHeuristics })
            : heuristicClassifier;
        // bench excludes the LLM classifier by default — running 100+ live
        // Claude calls per `pnpm eval` costs real money and is slow. Use
        // --llm to opt in (and ensure your subscription tolerates the cost).
        // Embedding is opt-in via --embedding so default `pnpm eval` stays fast
        // and reproducible when @xenova/transformers isn't installed. The
        // classifier returns null gracefully when the peer is missing, but the
        // first call on a cold model load costs >1s and would dominate p95.
        const useEmbedding =
          cmdOpts.embedding === true && cli.userConfig.useEmbeddingClassifier !== false;
        const useLlm = cmdOpts.llm === true && cli.userConfig.useLlmClassifier !== false;
        // K2: markov prior in classifiers array (pipeline only uses it when sessionContext.recentClasses present)
        const classifiers: Classifier[] = [overrideClassifier, turnTypeClassifier, markovClassifier, heuristic];
        if (useEmbedding) classifiers.push(embeddingClassifier);
        if (useLlm) classifiers.push(llmClassifier);
        const pipeline = createPipeline({
          classifiers,
          profile,
        });

        if (cmdOpts.tournament) {
          await runTournamentMode({
            entries,
            pipeline,
            profile,
            cmdOpts,
            parent,
          });
          return;
        }

        const report = await runEval(entries, pipeline);
        if (parent.json) {
          process.stdout.write(format(report, { json: true }) + "\n");
        } else if (!parent.quiet) {
          process.stdout.write(renderHuman(report) + "\n");
        }

        // Regression check
        const baseline = await readBaseline(resolveBundledBaseline(cmdOpts.baseline));
        if (baseline) {
          const gate = parseFloat(cmdOpts.gate);
          const delta = baseline.accuracy - report.accuracy;
          if (!parent.quiet) {
            const sign = delta >= 0 ? "+" : "";
            const deltaStr = `${sign}${(delta * 100).toFixed(2)}pp`;
            const deltaColor = delta > gate ? accuracyColor(0) : accuracyColor(1);
            process.stderr.write(
              `\n${dim("regression")} baseline ${baseline.accuracy.toFixed(4)} → current ${report.accuracy.toFixed(4)} ${deltaColor(`Δ ${deltaStr}`)} ${dim(`(gate ${(gate * 100).toFixed(1)}pp)`)}\n`,
            );
          }
          if (delta > gate) {
            process.stderr.write(
              accuracyColor(0)(
                `FAIL: accuracy dropped by more than gate. ${cmdOpts.propose ? "Proposed overrides REJECTED." : ""}\n`,
              ),
            );
            process.exit(1);
          }
        }

        if (cmdOpts.updateBaseline) {
          const baselinePath = resolveBundledBaseline(cmdOpts.baseline);
          await writeFile(baselinePath, JSON.stringify(report, null, 2), "utf8");
          if (!parent.quiet) {
            process.stdout.write(`Baseline updated at ${baselinePath}\n`);
          }
        }
      },
    );
}

/**
 * Conservative per-claude-call cost estimate used in the upfront preview
 * (`bench --tournament` without `--confirm-cost`). Real cost depends on
 * model, prompt length, and output length — this number is intentionally
 * on the high side so users don't get surprised.
 */
const TOURNAMENT_COST_PER_CALL_ESTIMATE_USD = 0.05;
const TOURNAMENT_CALLS_PER_ROW_STANDARD = 3;
const TOURNAMENT_CALLS_PER_ROW_MATRIX = 5; // A + B_tier + judge_tier + B_effort + judge_effort
const DEFAULT_TOURNAMENT_SAMPLE = 10;
const DEFAULT_TOURNAMENT_BUDGET_USD = 5;

type TournamentModeArgs = {
  entries: LabeledEntry[];
  pipeline: ReturnType<typeof createPipeline>;
  profile: Profile;
  cmdOpts: {
    tournamentSample?: string;
    tournamentBudget?: string;
    tournamentSeed?: string;
    tournamentResume?: string;
    confirmCost?: boolean;
    tournamentOutput?: string;
    tournamentMatrix?: boolean;
  };
  parent: ParentOptions;
};

async function runTournamentMode(args: TournamentModeArgs): Promise<void> {
  const sample = Math.max(
    1,
    parseInt(args.cmdOpts.tournamentSample ?? "", 10) || DEFAULT_TOURNAMENT_SAMPLE,
  );
  const budget = (() => {
    const raw = parseFloat(args.cmdOpts.tournamentBudget ?? "");
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TOURNAMENT_BUDGET_USD;
  })();
  const callsPerRow = args.cmdOpts.tournamentMatrix === true
    ? TOURNAMENT_CALLS_PER_ROW_MATRIX
    : TOURNAMENT_CALLS_PER_ROW_STANDARD;
  const estimatedCost =
    sample * callsPerRow * TOURNAMENT_COST_PER_CALL_ESTIMATE_USD;

  if (!args.cmdOpts.confirmCost) {
    if (!args.parent.quiet) {
      const modeLabel = args.cmdOpts.tournamentMatrix === true ? " [matrix mode]" : "";
      process.stdout.write(
        `Tournament estimate${modeLabel}: ${sample} prompts × ${callsPerRow} calls = ${sample * callsPerRow} claude invocations\n`,
      );
      process.stdout.write(
        `Estimated cost: ~$${estimatedCost.toFixed(2)} (conservative @ $${TOURNAMENT_COST_PER_CALL_ESTIMATE_USD.toFixed(2)}/call). Hard cap: $${budget.toFixed(2)}.\n`,
      );
      process.stdout.write("Use --confirm-cost to proceed.\n");
    }
    return;
  }

  if (estimatedCost > budget) {
    process.stderr.write(
      `Tournament estimated cost $${estimatedCost.toFixed(2)} exceeds budget cap $${budget.toFixed(2)}. ` +
        `Raise --tournament-budget or lower --tournament-sample.\n`,
    );
    process.exit(1);
  }

  let seed: number | undefined;
  if (args.cmdOpts.tournamentSeed !== undefined) {
    const raw = args.cmdOpts.tournamentSeed.trim();
    const parsed = Number(raw);
    if (raw === "" || !Number.isInteger(parsed)) {
      process.stderr.write("--tournament-seed must be an integer\n");
      process.exit(2);
    }
    seed = parsed;
  }

  // Sample with stratified coverage across classes (deterministic — no
  // RNG). `trivial` is excluded because it has no cheaper tier; including
  // it would just produce "no cheaper tier" skips and waste the sample
  // slot. Round-robin per class so partial budget runs still hit every
  // tier rather than burning the budget on one class.
  const sampled = stratifiedSample(args.entries, sample, {
    excludeClasses: ["trivial"],
    ...(seed !== undefined ? { seed } : {}),
  });

  // Pre-classify each prompt through the current pipeline to get its assigned class.
  const inputs: TournamentInput[] = [];
  for (const entry of sampled) {
    const req = buildRequest(entry);
    const d = await args.pipeline.route(req);
    inputs.push({
      prompt: entry.prompt,
      currentClass: d.class,
      currentSpec: d.spec,
    });
  }

  if (!args.parent.quiet) {
    const callDesc = args.cmdOpts.tournamentMatrix === true
      ? `${inputs.length} prompts × 5 calls (A + B + judge + B_effort + judge_effort) [matrix mode]`
      : `${inputs.length} prompts × 3 calls (A + B + judge)`;
    process.stderr.write(
      `\n${bold("Tournament")} ${dim(`${callDesc}, cap ${"$" + budget.toFixed(2)}, sequential`)}\n\n`,
    );
  }

  const startedAt = Date.now();
  const verdictGlyph: Record<string, string> = {
    A_wins: gray("• keep"),
    B_wins: cyan("✓ downgrade"),
    tie: cyan("≈ downgrade"),
    judge_failed: yellow("? judge failed"),
  };

  const onProgress = (e: TournamentProgress): void => {
    const i = `[${(e.index + 1).toString().padStart(2)}/${e.total}]`;
    switch (e.type) {
      case "row_start": {
        const tgt = e.downgradedClass ?? "—";
        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        process.stderr.write(
          `${dim(i)} ${e.currentClass.padEnd(10)} ${dim("→")} ${cyan(tgt.padEnd(10))} ${dim(`(${elapsed}s elapsed) `)} ${dim(e.prompt.slice(0, 50))}${e.prompt.length > 50 ? dim("…") : ""}\n`,
        );
        break;
      }
      case "a_done":
        process.stderr.write(`        ${dim("A")} ${gray(`$${e.costUsd.toFixed(4)}`)}\n`);
        break;
      case "b_done":
        process.stderr.write(`        ${dim("B")} ${gray(`$${e.costUsd.toFixed(4)}`)}\n`);
        break;
      case "judge_done":
        process.stderr.write(
          `        ${dim("J")} ${gray(`$${e.costUsd.toFixed(4)}`)}  ${verdictGlyph[e.verdict] ?? e.verdict}  ${dim(`spent $${e.totalSpent.toFixed(4)}`)}\n`,
        );
        break;
      case "b_effort_done":
        process.stderr.write(
          `        ${dim("B~")} ${gray(`$${e.costUsd.toFixed(4)}`)} ${dim(`effort→${e.effortLevel}`)}\n`,
        );
        break;
      case "judge_effort_done":
        process.stderr.write(
          `        ${dim("J~")} ${gray(`$${e.costUsd.toFixed(4)}`)}  ${verdictGlyph[e.verdict] ?? e.verdict}  ${dim(`effort→${e.effortLevel}  spent $${e.totalSpent.toFixed(4)}`)}\n`,
        );
        break;
      case "skipped":
        process.stderr.write(`        ${yellow("⤬ skip")} ${dim(e.reason)}\n`);
        break;
      case "budget_reached":
        process.stderr.write(
          `\n${yellow("⚠ budget cap reached")} ${dim(`at $${e.totalSpent.toFixed(2)}; remaining rows skipped`)}\n`,
        );
        break;
    }
  };

  const resumePath =
    args.cmdOpts.tournamentResume !== undefined
      ? resolve(args.cmdOpts.tournamentResume)
      : undefined;

  const report = await runTournament(inputs, {
    getSpec: (c) => args.profile.classes[c],
    budgetCapUsd: budget,
    matrix: args.cmdOpts.tournamentMatrix === true,
    ...(args.parent.quiet ? {} : { onProgress }),
    ...(resumePath !== undefined ? { resumePath } : {}),
  });

  if (args.parent.json) {
    process.stdout.write(format(report, { json: true }) + "\n");
  } else if (!args.parent.quiet) {
    process.stdout.write(renderTournamentHuman(report) + "\n");
  }

  if (args.cmdOpts.tournamentOutput) {
    const effortReductions = report.matrixResults.flatMap((mr: MatrixResult) =>
      mr.cells
        .filter((cell: MatrixCell) => {
          const total = cell.wins + cell.ties + cell.losses + cell.failed;
          return total > 0 && (cell.wins + cell.ties) > cell.losses;
        })
        .map((cell: MatrixCell) => ({
          class: mr.class,
          currentEffort: mr.currentEffort,
          reducedEffort: cell.effort,
          winRate: Number(
            ((cell.wins + cell.ties) / (cell.wins + cell.ties + cell.losses + cell.failed)).toFixed(4),
          ),
          sampleCount: cell.wins + cell.ties + cell.losses + cell.failed,
        })),
    );

    const proposal = {
      overrides: {} as ProfileOverride,
      heuristics: buildProposedHeuristics(report.recommendedDowngrades),
      ...(report.matrixResults.length > 0 ? { effortReductions } : {}),
    };
    await writeFile(
      resolve(args.cmdOpts.tournamentOutput),
      JSON.stringify(proposal, null, 2),
      "utf8",
    );
    if (!args.parent.quiet) {
      process.stdout.write(
        `\nWrote tournament proposal to ${args.cmdOpts.tournamentOutput}\n` +
          `Validate with: maestro bench --propose ${args.cmdOpts.tournamentOutput}\n`,
      );
    }
  }
}

function renderTournamentHuman(report: TournamentReport): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(header("Tournament results"));
  lines.push(
    `  ${bold("prompts")}   ${cyan(`${report.ran}/${report.totalPrompts}`)}  ${dim("ran")}`,
  );
  lines.push(`  ${bold("spent")}     ${cyan("$" + report.totalCostUsd.toFixed(4))}`);
  lines.push("");
  lines.push(dim("  class            tier-down      verdict"));
  for (const cls of ALL_CLASSES) {
    const target = DOWNGRADE[cls];
    if (target === null) {
      lines.push(`    ${cls.padEnd(10)} ${gray("—".padEnd(13))} ${dim("skipped (no cheaper tier)")}`);
      continue;
    }
    const wr = report.perClassWinRates[cls];
    if (wr.ran === 0) {
      lines.push(`    ${cls.padEnd(10)} ${gray((`→ ${target}`).padEnd(13))} ${dim("not sampled")}`);
      continue;
    }
    const wins = wr.downgradeWins + wr.ties;
    const recommend = wins > wr.aLosses;
    const ratio = wr.ran > 0 ? wins / wr.ran : 0;
    const verdict = recommend
      ? `${accuracyColor(ratio)("✓ recommend downgrade")}${wr.ran < 3 ? dim(` (n=${wr.ran})`) : ""}`
      : gray("keep current");
    lines.push(
      `    ${cls.padEnd(10)} ${cyan((`→ ${target}`).padEnd(13))} ${accuracyColor(ratio)(`${wins}/${wr.ran}`)}  ${verdict}`,
    );
    const suggested = report.recommendedDowngrades.find(
      (r) => r.from === cls && r.to === target,
    );
    if (suggested) {
      lines.push(
        `                              ${dim("→ pattern")} ${magenta(suggested.promptPattern)} ${dim("conf 0.85")}`,
      );
    }
  }
  // Matrix section
  if (report.matrixResults.length > 0) {
    lines.push("");
    lines.push(dim("  effort matrix (same model, lower effort)"));
    lines.push(dim("  class            effort-step    wins  ties  losses  failed"));
    for (const mr of report.matrixResults) {
      for (const cell of mr.cells) {
        const total = cell.wins + cell.ties + cell.losses + cell.failed;
        const recommend = total > 0 && (cell.wins + cell.ties) > cell.losses;
        const ratio = total > 0 ? (cell.wins + cell.ties) / total : 0;
        const verdict = recommend
          ? accuracyColor(ratio)("✓ reduce effort")
          : gray("keep effort");
        lines.push(
          `    ${mr.class.padEnd(10)} ${cyan((`${mr.currentEffort}→${cell.effort}`).padEnd(13))} ` +
          `${String(cell.wins).padStart(4)}  ${String(cell.ties).padStart(4)}  ${String(cell.losses).padStart(6)}  ${String(cell.failed).padStart(6)}  ${verdict}`,
        );
      }
    }
  }

  const skippedBudget = report.rows.filter(
    (r: TournamentRowResult) => r.skipReason === "budget_cap_reached",
  ).length;
  if (skippedBudget > 0) {
    lines.push("");
    lines.push(`  ${yellow("⚠")} ${yellow("budget cap reached")} ${dim(`— ${skippedBudget} prompt(s) not run`)}`);
  }
  return lines.join("\n");
}

/**
 * Resolve the eval JSONL path. If the user passed an explicit path, honor it
 * (cwd-relative or absolute). Otherwise look for the bundled `evals/labeled.jsonl`
 * relative to the maestro package install dir, falling back to cwd-relative.
 */
export function resolveBundledEval(userPath: string | undefined): string {
  return resolveBundled(userPath, "evals/labeled.jsonl");
}

export function resolveBundledBaseline(userPath: string | undefined): string {
  return resolveBundled(userPath, "evals/baseline.json");
}

function resolveBundled(userPath: string | undefined, relative: string): string {
  if (userPath !== undefined && userPath.length > 0) {
    return isAbsolute(userPath) ? userPath : resolve(userPath);
  }
  // dist/cli/bench.js → walk up to package root, then evals/...
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    join(here, "..", "..", relative),
    join(here, "..", "..", "..", relative),
    resolve(relative),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return resolve(relative);
}

export async function readBaseline(path: string): Promise<{ accuracy: number } | null> {
  try {
    const raw = await readFile(resolve(path), "utf8");
    return JSON.parse(raw) as { accuracy: number };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

export async function runEval(
  entries: LabeledEntry[],
  pipeline: ReturnType<typeof createPipeline>,
): Promise<BenchReport> {
  type Bucket = { total: number; correct: number };
  const perClass = new Map<Class, Bucket>();
  const confusion = new Map<string, number>();
  const latencies: number[] = [];

  let total = 0;
  let correct = 0;

  for (const entry of entries) {
    const req = buildRequest(entry);
    const d = await pipeline.route(req);
    latencies.push(d.latencyMs);
    total++;
    const got = d.class;
    const want = entry.expectedClass;
    if (got === want) correct++;
    const bkt = perClass.get(want) ?? { total: 0, correct: 0 };
    bkt.total++;
    if (got === want) bkt.correct++;
    perClass.set(want, bkt);
    const key = `${want}>${got}`;
    confusion.set(key, (confusion.get(key) ?? 0) + 1);
  }
  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)] ?? 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? 0;

  return {
    total,
    correct,
    accuracy: Number((correct / total).toFixed(4)),
    perClass: Object.fromEntries(
      ALL_CLASSES.filter((c) => perClass.has(c)).map((c) => {
        const b = perClass.get(c)!;
        return [c, { total: b.total, correct: b.correct, accuracy: Number((b.correct / b.total).toFixed(4)) }];
      }),
    ),
    confusion: Object.fromEntries(confusion),
    latencyMs: { p50, p95 },
  };
}

function buildRequest(entry: LabeledEntry): Request {
  if (entry.lastRole === "tool") {
    const messages: Message[] = [
      { role: "user", content: "earlier" },
      { role: "assistant", content: "doing" },
      { role: "tool", content: entry.prompt },
    ];
    return { prompt: entry.prompt, messages };
  }
  if (entry.lastRole === "assistant") {
    const messages: Message[] = [{ role: "assistant", content: entry.prompt }];
    return { prompt: entry.prompt, messages };
  }
  return { prompt: entry.prompt };
}

function renderHuman(r: BenchReport): string {
  const lines: string[] = [];
  const accColor = accuracyColor(r.accuracy);

  lines.push("");
  lines.push(header("Bench results"));
  lines.push(
    `  ${bold("accuracy")}  ${accColor(`${r.correct}/${r.total}`)}  ${accColor(`(${pct(r.accuracy, 2)})`)}  ${dim(bar(r.accuracy, 24))}`,
  );
  lines.push(
    `  ${bold("latency")}   ${cyan(`p50=${r.latencyMs.p50}ms`)}  ${cyan(`p95=${r.latencyMs.p95}ms`)}`,
  );
  lines.push("");
  lines.push(dim("  per-class"));
  for (const [cls, s] of Object.entries(r.perClass)) {
    const c = accuracyColor(s.accuracy);
    lines.push(
      `    ${cls.padEnd(10)} ${c(`${s.correct}/${s.total}`.padStart(7))}  ${c(pct(s.accuracy, 1).padStart(6))}  ${gray(bar(s.accuracy, 16))}`,
    );
  }
  return lines.join("\n");
}
