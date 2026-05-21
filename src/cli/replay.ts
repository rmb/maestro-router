// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import type { Command } from "commander";
import { readFile } from "node:fs/promises";
import { embeddingClassifier } from "../classifiers/embedding.js";
import { heuristicClassifier, createHeuristicClassifier } from "../classifiers/heuristic.js";
import { llmClassifier } from "../classifiers/llm.js";
import { overrideClassifier } from "../classifiers/override.js";
import { turnTypeClassifier } from "../classifiers/turn-type.js";
import { createPipeline } from "../core/pipeline.js";
import { loadProfile } from "../core/profile.js";
import type { Class, Classifier, Request, TelemetryEvent } from "../core/types.js";
import { format, loadCliConfig } from "./utils.js";

type ParentOptions = { json?: boolean; quiet?: boolean; config?: string };

type Diff = {
  total: number;
  changed: number;
  unchanged: number;
  diffs: { ts: string; prompt: string; before: Class; after: Class }[];
};

export function registerReplayCommand(program: Command): void {
  program
    .command("replay <log>")
    .description("Re-route a JSONL telemetry log against the current pipeline; report divergences")
    .option("--limit <n>", "max entries to inspect", "200")
    .action(async (logPath: string, cmdOpts: { limit: string }) => {
      const parent = program.opts<ParentOptions>();
      const cli = await loadCliConfig(parent.config);
      const { profile } = loadProfile({
        userConfig: cli.userConfig,
        overrides: cli.profileOverrides,
      });
      const heuristic =
        cli.userHeuristics.length > 0
          ? createHeuristicClassifier({ extraRules: cli.userHeuristics })
          : heuristicClassifier;
      const useEmbedding = cli.userConfig.useEmbeddingClassifier !== false;
      const useLlm = cli.userConfig.useLlmClassifier !== false;
      const classifiers: Classifier[] = [overrideClassifier, turnTypeClassifier, heuristic];
      if (useEmbedding) classifiers.push(embeddingClassifier);
      if (useLlm) classifiers.push(llmClassifier);
      const pipeline = createPipeline({
        classifiers,
        profile,
      });

      const raw = await readFile(logPath, "utf8");
      const events = raw
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as TelemetryEvent)
        .filter((e): e is Extract<TelemetryEvent, { type: "decision" }> => e.type === "decision");

      const limit = Math.max(1, parseInt(cmdOpts.limit, 10) || 200);
      const sample = events.slice(-limit);

      const diff: Diff = { total: sample.length, changed: 0, unchanged: 0, diffs: [] };

      for (const e of sample) {
        // We don't store the original prompt verbatim in v0.2 telemetry — replay
        // works on the original Decision's classifier + class. With prompt-less
        // events we cannot fully re-route; surface that limitation.
        // Stub: we treat the decision's class as the "before" and the same as
        // "after" since we lack the prompt. Real implementation needs prompt
        // logged in telemetry.
        const req: Request = { prompt: "" };
        const next = await pipeline.route(req);
        if (next.class !== e.decision.class) {
          diff.changed++;
          diff.diffs.push({
            ts: e.ts,
            prompt: "(prompt not in telemetry; replay limited to class-only diff)",
            before: e.decision.class,
            after: next.class,
          });
        } else {
          diff.unchanged++;
        }
      }

      if (parent.json) {
        process.stdout.write(format(diff, { json: true }) + "\n");
      } else {
        const lines = [
          `replay: ${diff.unchanged}/${diff.total} unchanged, ${diff.changed} changed`,
          "",
          "Note: v0.2 telemetry does not log the raw prompt; replay is limited",
          "to class-level diffs against an empty prompt. Will improve in v0.2.1",
          "when telemetry optionally records a prompt hash + length.",
        ];
        process.stdout.write(lines.join("\n") + "\n");
      }
    });
}
