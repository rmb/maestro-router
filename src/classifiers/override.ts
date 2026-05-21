// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0
// budget: 1ms

import { createClassifier } from "../core/classifier.js";
import type { Class, ClassifyFn, Diagnostic, Request } from "../core/types.js";

/**
 * Inline overrides in user prompts. Order matters in the alternation:
 * `fast+context` must come before `fast` so the longer variant wins.
 */
const OVERRIDE_RE = /(?:^|\s)@(opus|deep|think|sonnet|fast\+context|fast|haiku)\b/i;

type Mapping = { class: Class; disableBare?: boolean };

const MAPPING: Record<string, Mapping> = {
  opus: { class: "max" },
  deep: { class: "max" },
  think: { class: "reasoning" },
  sonnet: { class: "standard" },
  fast: { class: "trivial" },
  haiku: { class: "trivial" },
  "fast+context": { class: "trivial", disableBare: true },
};

const classify: ClassifyFn = (req: Request) => {
  const match = req.prompt.match(OVERRIDE_RE);
  if (!match) return null;
  const hint = match[1]?.toLowerCase();
  if (!hint) return null;
  const mapping = MAPPING[hint];
  if (!mapping) return null;

  const diagnostics: Diagnostic[] = [
    { severity: "info", code: "override.matched", message: `@${hint}` },
  ];
  if (mapping.disableBare) {
    diagnostics.push({
      severity: "info",
      code: "override.disable_bare",
      message: "preserve project context (@fast+context)",
    });
  }
  return { class: mapping.class, confidence: 1.0, diagnostics };
};

export const overrideClassifier = createClassifier({
  name: "override",
  weight: 1.0,
  classify,
});

/** Remove the first override hint from a prompt; useful before forwarding to claude. */
export function stripOverride(prompt: string): string {
  const match = prompt.match(OVERRIDE_RE);
  if (!match) return prompt;
  const idx = match.index ?? 0;
  const len = match[0].length;
  return (prompt.slice(0, idx) + prompt.slice(idx + len)).trimStart();
}
