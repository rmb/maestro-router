// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

// Phase 2 smoke test: wires the full Maestro path against a real `claude`
// subprocess. Costs a few cents per run. Not part of `pnpm test`.
//
//   tsx examples/smoke.ts "rename foo to bar"

import { heuristicClassifier } from "../src/classifiers/heuristic.js";
import { overrideClassifier, stripOverride } from "../src/classifiers/override.js";
import { turnTypeClassifier } from "../src/classifiers/turn-type.js";
import { createPipeline } from "../src/core/pipeline.js";
import { loadProfile } from "../src/core/profile.js";
import { parseOutput } from "../src/wrapper/output.js";
import { preflight } from "../src/wrapper/preflight.js";
import { createSessionStore } from "../src/wrapper/session.js";
import { buildClaudeArgs } from "../src/wrapper/spawn.js";
import { streamClaude } from "../src/wrapper/stream.js";

const log = (msg: string): void => {
  process.stderr.write(`[maestro] ${msg}\n`);
};

async function main(): Promise<void> {
  const prompt = process.argv.slice(2).join(" ").trim();
  if (!prompt) {
    process.stderr.write("Usage: tsx examples/smoke.ts <prompt>\n");
    process.exit(2);
  }

  const pre = preflight();
  if (!pre.ok) {
    process.stderr.write(`Preflight failed: ${pre.reason}\n`);
    process.exit(1);
  }
  log(`preflight ok (claude ${pre.version})`);

  const { profile } = loadProfile();
  const pipeline = createPipeline({
    classifiers: [overrideClassifier, turnTypeClassifier, heuristicClassifier],
    profile,
  });

  const decision = await pipeline.route({ prompt });
  log(
    `route: ${decision.classifier} → class=${decision.class} conf=${decision.confidence.toFixed(2)} model=${decision.spec.model} effort=${decision.spec.effort} budget=$${decision.spec.maxBudgetUsd}`,
  );

  const sessions = createSessionStore();
  const { sessionId, isNew } = await sessions.getOrCreate(process.cwd());
  log(`session: id=${sessionId} new=${isNew}`);

  const args = buildClaudeArgs({
    decision,
    userConfig: {},
    sessionId,
    isResume: !isNew,
  });
  log(`claude args: ${args.join(" ")}`);

  const stripped = stripOverride(prompt);
  const result = await streamClaude({
    args,
    prompt: stripped,
    stdout: process.stdout,
    stderr: process.stderr,
  });
  process.stdout.write("\n");

  const parsed = parseOutput(result.capturedStdout);
  if (parsed) {
    log(
      `cost: $${parsed.cost.totalCostUsd.toFixed(6)} in=${parsed.cost.inputTokens} out=${parsed.cost.outputTokens} cache_create=${parsed.cost.cacheCreationInputTokens} cache_read=${parsed.cost.cacheReadInputTokens}`,
    );
    if (parsed.diagnostics.length > 0) {
      for (const d of parsed.diagnostics) {
        log(`diag: ${d.severity} ${d.code} — ${d.message}`);
      }
    }
  } else {
    log("could not parse cost JSON from output");
  }

  process.exit(result.exitCode ?? 0);
}

main().catch((err: unknown) => {
  process.stderr.write(`smoke error: ${(err as Error).message}\n`);
  process.exit(1);
});
