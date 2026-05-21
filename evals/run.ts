// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { heuristicClassifier } from "../src/classifiers/heuristic.js";
import { overrideClassifier } from "../src/classifiers/override.js";
import { turnTypeClassifier } from "../src/classifiers/turn-type.js";
import { createPipeline } from "../src/core/pipeline.js";
import { balancedProfile } from "../src/core/profile.js";
import type { Class, Message, Request } from "../src/core/types.js";

type EvalEntry = {
  prompt: string;
  expectedClass: Class;
  lastRole?: "user" | "assistant" | "tool" | "system";
  expectedTurnType?: string;
  source: string;
};

const ALL_CLASSES: Class[] = ["trivial", "simple", "standard", "hard", "reasoning", "max"];
const __dirname = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const labeledPath = join(__dirname, "labeled.jsonl");
  const data = await readFile(labeledPath, "utf8");
  const entries = data
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as EvalEntry);

  const pipeline = createPipeline({
    classifiers: [overrideClassifier, turnTypeClassifier, heuristicClassifier],
    profile: balancedProfile,
  });

  type Stats = { total: number; correct: number };
  const perClass = new Map<Class, Stats>();
  const confusion = new Map<string, number>();
  const failures: Array<{
    prompt: string;
    expected: Class;
    predicted: Class;
    classifier: string;
    source: string;
  }> = [];

  let total = 0;
  let correct = 0;
  const latencies: number[] = [];

  for (const entry of entries) {
    const req = buildRequest(entry);
    const decision = await pipeline.route(req);
    const predicted = decision.class;
    const expected = entry.expectedClass;

    total++;
    if (predicted === expected) correct++;

    const stats = perClass.get(expected) ?? { total: 0, correct: 0 };
    stats.total++;
    if (predicted === expected) stats.correct++;
    perClass.set(expected, stats);

    const key = `${expected}>${predicted}`;
    confusion.set(key, (confusion.get(key) ?? 0) + 1);

    latencies.push(decision.latencyMs);

    if (predicted !== expected) {
      failures.push({
        prompt: entry.prompt.slice(0, 80),
        expected,
        predicted,
        classifier: decision.classifier,
        source: entry.source,
      });
    }
  }

  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)] ?? 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? 0;

  const report = {
    total,
    correct,
    accuracy: Number((correct / total).toFixed(4)),
    perClass: Object.fromEntries(
      ALL_CLASSES.filter((c) => perClass.has(c)).map((c) => {
        const s = perClass.get(c)!;
        return [c, { total: s.total, correct: s.correct, accuracy: Number((s.correct / s.total).toFixed(4)) }];
      }),
    ),
    confusion: Object.fromEntries(confusion),
    latencyMs: { p50, p95 },
    failures: failures.slice(0, 20),
  };

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(report, null, 2));

  const baselinePath = join(__dirname, "baseline.json");
  await writeFile(baselinePath, JSON.stringify(report, null, 2));
}

function buildRequest(entry: EvalEntry): Request {
  if (entry.lastRole === "tool") {
    const messages: Message[] = [
      { role: "user", content: "earlier" },
      { role: "assistant", content: "okay" },
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

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
