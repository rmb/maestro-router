// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0
//
// Shared class rubric + few-shot examples for all LLM classifier stages.
// Single source of truth — CLAUDE.md forbids inline duplicates so any future
// LLM stage (e.g. cascade reviewer) imports from here.

import type { Class } from "../core/types.js";
import { EXEMPLAR_SEEDS } from "./exemplars-seeds.js";

export type Scope =
  | "single_line"
  | "one_function"
  | "one_file"
  | "multi_file"
  | "system_design"
  | "incident";

export type FewShotExample = {
  readonly prompt: string;
  readonly verb: string;
  readonly scope: Scope;
  readonly needsContext: boolean;
  readonly class: Class;
  readonly confidence: number;
};

/**
 * Hand-curated reasoning metadata per exemplar prompt. Pinned because the
 * model sees these as its template for the CoT scaffold — drift here moves
 * accuracy. Lookup by prompt string; missing entries fall back to safe
 * defaults so reordering EXEMPLAR_SEEDS doesn't crash.
 */
const REASONING_META: Record<string, { verb: string; scope: Scope; needsContext: boolean }> = {
  // trivial
  "rename foo to bar": { verb: "rename", scope: "single_line", needsContext: false },
  "format this file with prettier": { verb: "format", scope: "one_file", needsContext: false },
  "run eslint on this file": { verb: "run", scope: "one_file", needsContext: false },
  // simple
  "add a parameter to this function": { verb: "edit", scope: "one_function", needsContext: false },
  "update the error message to be clearer": { verb: "edit", scope: "single_line", needsContext: false },
  "change the default port to 3000": { verb: "edit", scope: "single_line", needsContext: false },
  // standard
  "implement a debounce utility": { verb: "implement", scope: "one_file", needsContext: false },
  "add a REST endpoint for user search": { verb: "implement", scope: "multi_file", needsContext: true },
  "write a function to merge two arrays without duplicates": {
    verb: "implement",
    scope: "one_function",
    needsContext: false,
  },
  // hard
  "this test is flaky, find out why": { verb: "debug", scope: "multi_file", needsContext: true },
  "refactor this 800-line file into smaller modules": {
    verb: "refactor",
    scope: "multi_file",
    needsContext: true,
  },
  "fix the race condition in the worker pool": {
    verb: "debug",
    scope: "multi_file",
    needsContext: true,
  },
  // reasoning
  "design a caching layer for our auth service": {
    verb: "design",
    scope: "system_design",
    needsContext: true,
  },
  "should we move from REST to GraphQL?": {
    verb: "evaluate",
    scope: "system_design",
    needsContext: true,
  },
  "what's the best architecture for a multi-tenant SaaS billing system?": {
    verb: "design",
    scope: "system_design",
    needsContext: true,
  },
  // max
  "production is down, here are the logs": {
    verb: "debug",
    scope: "incident",
    needsContext: true,
  },
  "memory leak we cannot reproduce locally": {
    verb: "debug",
    scope: "incident",
    needsContext: true,
  },
  "our database has corrupt data, here are the symptoms": {
    verb: "debug",
    scope: "incident",
    needsContext: true,
  },
};

const FALLBACK_META_BY_CLASS: Record<Class, { verb: string; scope: Scope; needsContext: boolean }> = {
  trivial: { verb: "edit", scope: "single_line", needsContext: false },
  simple: { verb: "edit", scope: "one_function", needsContext: false },
  standard: { verb: "implement", scope: "one_file", needsContext: false },
  hard: { verb: "debug", scope: "multi_file", needsContext: true },
  reasoning: { verb: "design", scope: "system_design", needsContext: true },
  max: { verb: "debug", scope: "incident", needsContext: true },
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
      const meta = REASONING_META[prompt] ?? FALLBACK_META_BY_CLASS[cls];
      out.push({
        prompt,
        verb: meta.verb,
        scope: meta.scope,
        needsContext: meta.needsContext,
        class: cls,
        confidence: 0.95,
      });
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
        `<PROMPT_TO_CLASSIFY>${ex.prompt}</PROMPT_TO_CLASSIFY>\n→ {"verb":"${ex.verb}","scope":"${ex.scope}","needsContext":${ex.needsContext},"class":"${ex.class}","confidence":${ex.confidence}}`,
    )
    .join("\n\n");
}
