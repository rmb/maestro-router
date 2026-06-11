// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0
// budget: 1ms

import { createClassifier } from "../core/classifier.js";
import type { Class, ClassifyFn, Diagnostic, Request } from "../core/types.js";

/**
 * Inline overrides in user prompts. Order matters in the alternation:
 * `fast+context` must come before `fast` so the longer variant wins.
 */
const OVERRIDE_RE = /(?:^|\s)@(opus|fable|deep|think|sonnet|fast\+context|fast|haiku)\b/i;

/**
 * Natural-language equivalents of @think/@deep. Requires an intensity
 * modifier so "I think", "rethink", "overthink" are excluded.
 */
const NATURAL_THINK_RE =
  /\bthink\s+(hard|harder|deeply|deep|carefully|more\s+carefully|step[\s-]+by[\s-]+step)\b/i;

type Mapping = { class: Class; disableBare?: boolean };

const MAPPING: Record<string, Mapping> = {
  opus: { class: "max" },
  fable: { class: "max" },
  deep: { class: "max" },
  think: { class: "reasoning" },
  sonnet: { class: "standard" },
  fast: { class: "trivial" },
  haiku: { class: "trivial" },
  "fast+context": { class: "trivial", disableBare: true },
};

const classify: ClassifyFn = (req: Request) => {
  // @-prefixed hint — checked first so @fast think hard stays trivial
  const match = req.prompt.match(OVERRIDE_RE);
  if (match) {
    const hint = match[1]?.toLowerCase();
    if (hint) {
      const mapping = MAPPING[hint];
      if (mapping) {
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
      }
    }
  }

  // Natural-language think hint ("think hard", "think step by step", …)
  if (NATURAL_THINK_RE.test(req.prompt)) {
    return {
      class: "max",
      confidence: 1.0,
      diagnostics: [
        { severity: "info", code: "override.nl_think", message: "natural-language think hint" },
      ],
    };
  }

  return null;
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
