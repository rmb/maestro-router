// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0
//
// Shared class rubric + few-shot examples for all LLM classifier stages.
// Single source of truth — CLAUDE.md forbids inline duplicates so any future
// LLM stage (e.g. cascade reviewer) imports from here.

import type { Class } from "../core/types.js";
import { EXEMPLAR_SEEDS } from "./exemplars-seeds.js";

export type FewShotExample = {
  readonly prompt: string;
  readonly class: Class;
  readonly confidence: number;
};

/**
 * Class definitions. Adjectives matter — "no logic decisions" prevents the
 * model upcasting a one-line rename to "simple" or "standard".
 */
export const CLASS_RUBRIC = `- trivial: format, rename, one-liners; no logic decisions
- simple: small edits, docs, single-call API tweaks; localized to one place
- standard: normal coding; new endpoint, function, test file
- hard: tricky bugs, multi-file refactors, perf tuning, race conditions
- reasoning: architecture/design, tradeoff analysis, "should we…" questions
- max: production incidents, byzantine bugs, security forensics`;

const EXAMPLES_PER_CLASS = 3;
const CLASS_ORDER: ReadonlyArray<Class> = [
  "trivial",
  "simple",
  "standard",
  "hard",
  "reasoning",
  "max",
];

/**
 * Three representative examples per class, drawn from EXEMPLAR_SEEDS in
 * declared order. Order is load-bearing — Anthropic prompt caching keys on
 * exact bytes, so reordering invalidates the cache on the next call.
 */
export const FEW_SHOT_EXAMPLES: ReadonlyArray<FewShotExample> = (() => {
  const byClass = new Map<Class, string[]>();
  for (const seed of EXEMPLAR_SEEDS) {
    let arr = byClass.get(seed.class);
    if (!arr) {
      arr = [];
      byClass.set(seed.class, arr);
    }
    if (arr.length < EXAMPLES_PER_CLASS) arr.push(seed.prompt);
  }
  const out: FewShotExample[] = [];
  for (const cls of CLASS_ORDER) {
    for (const prompt of byClass.get(cls) ?? []) {
      out.push({ prompt, class: cls, confidence: 0.95 });
    }
  }
  return out;
})();

/**
 * Render examples as a system-prompt block. Format mirrors what the model
 * is asked to produce: tagged input → JSON output. Trailing newline omitted
 * so callers control spacing in the surrounding template.
 */
export function renderFewShotBlock(
  examples: ReadonlyArray<FewShotExample> = FEW_SHOT_EXAMPLES,
): string {
  return examples
    .map(
      (ex) =>
        `<PROMPT_TO_CLASSIFY>${ex.prompt}</PROMPT_TO_CLASSIFY>\n→ {"class":"${ex.class}","confidence":${ex.confidence}}`,
    )
    .join("\n\n");
}
