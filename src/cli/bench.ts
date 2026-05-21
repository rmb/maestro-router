// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import type { Command } from "commander";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHeuristicClassifier, heuristicClassifier } from "../classifiers/heuristic.js";
import { llmClassifier } from "../classifiers/llm.js";
import { overrideClassifier } from "../classifiers/override.js";
import { turnTypeClassifier } from "../classifiers/turn-type.js";
import { ALL_CLASSES } from "../core/profile.js";
import { createPipeline } from "../core/pipeline.js";
import { loadProfile } from "../core/profile.js";
import type { Class, Classifier, HeuristicRule, Message, ProfileOverride, Request } from "../core/types.js";
import { format, loadCliConfig } from "./utils.js";

type ParentOptions = { json?: boolean; quiet?: boolean; config?: string };

type LabeledEntry = {
  prompt: string;
  expectedClass: Class;
  lastRole?: "user" | "assistant" | "tool" | "system";
  source: string;
};

type BenchReport = {
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
    .option("--eval <path>", "labeled JSONL file", "evals/labeled.jsonl")
    .option("--baseline <path>", "baseline JSON for regression check", "evals/baseline.json")
    .option("--gate <pct>", "regression gate (0-1)", "0.02")
    .option("--propose <path>", "validate a proposed profile-overrides.json before applying")
    .option("--tournament", "run model-tier downgrade tournament (v0.2 single-axis)")
    .option("--update-baseline", "write the new report as the baseline")
    .option("--llm", "include the LLM classifier (costs ~$0.001 per uncertain prompt; default off)")
    .action(
      async (cmdOpts: {
        eval: string;
        baseline: string;
        gate: string;
        propose?: string;
        tournament?: boolean;
        updateBaseline?: boolean;
        llm?: boolean;
      }) => {
        const parent = program.opts<ParentOptions>();
        const cli = await loadCliConfig(parent.config);

        const evalPath = resolve(cmdOpts.eval);
        const data = await readFile(evalPath, "utf8");
        const entries = data
          .split("\n")
          .filter((l) => l.trim().length > 0)
          .map((l) => JSON.parse(l) as LabeledEntry);

        // Apply --propose overlay if given
        let overrides: ProfileOverride = cli.profileOverrides;
        let extraHeuristics: HeuristicRule[] = cli.userHeuristics;
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
        const useLlm = cmdOpts.llm === true && cli.userConfig.useLlmClassifier !== false;
        const classifiers: Classifier[] = [overrideClassifier, turnTypeClassifier, heuristic];
        if (useLlm) classifiers.push(llmClassifier);
        const pipeline = createPipeline({
          classifiers,
          profile,
        });

        const report = await runEval(entries, pipeline);
        if (parent.json) {
          process.stdout.write(format(report, { json: true }) + "\n");
        } else if (!parent.quiet) {
          process.stdout.write(renderHuman(report) + "\n");
        }

        // Regression check
        const baseline = await readBaseline(cmdOpts.baseline);
        if (baseline) {
          const gate = parseFloat(cmdOpts.gate);
          const delta = baseline.accuracy - report.accuracy;
          if (!parent.quiet) {
            process.stderr.write(
              `\nRegression check: baseline=${baseline.accuracy.toFixed(4)} current=${report.accuracy.toFixed(4)} delta=${delta.toFixed(4)} (gate ${gate})\n`,
            );
          }
          if (delta > gate) {
            process.stderr.write(
              `FAIL: accuracy dropped by more than gate. ${cmdOpts.propose ? "Proposed overrides REJECTED." : ""}\n`,
            );
            process.exit(1);
          }
        }

        if (cmdOpts.updateBaseline) {
          await writeFile(
            resolve(cmdOpts.baseline),
            JSON.stringify(report, null, 2),
            "utf8",
          );
          if (!parent.quiet) {
            process.stdout.write(`Baseline updated at ${cmdOpts.baseline}\n`);
          }
        }

        if (cmdOpts.tournament) {
          if (!parent.quiet) {
            process.stdout.write(
              "\nTournament mode (v0.2 single-axis): real-Claude tournament is opt-in and costs tokens; not run by default.\n  Enable in v0.2.1 when budget guardrails are wired in.\n",
            );
          }
        }
      },
    );
}

async function readBaseline(path: string): Promise<{ accuracy: number } | null> {
  try {
    const raw = await readFile(resolve(path), "utf8");
    return JSON.parse(raw) as { accuracy: number };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

async function runEval(
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
  lines.push(`bench: ${r.correct}/${r.total} correct (${(r.accuracy * 100).toFixed(2)}%)`);
  lines.push(`latency p50=${r.latencyMs.p50}ms p95=${r.latencyMs.p95}ms`);
  lines.push("");
  for (const [cls, s] of Object.entries(r.perClass)) {
    lines.push(`  ${cls.padEnd(10)} ${s.correct}/${s.total}  (${(s.accuracy * 100).toFixed(1)}%)`);
  }
  return lines.join("\n");
}
