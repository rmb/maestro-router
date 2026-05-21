// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0
// budget: 10ms

import { readFile } from "node:fs/promises";
import { createClassifier } from "../core/classifier.js";
import type {
  Class,
  Classifier,
  Classification,
  ClassifyFn,
  Diagnostic,
  HeuristicRule,
  Request,
} from "../core/types.js";

const SIZE_THRESHOLD = 50_000;

/**
 * Built-in patterns. Ordering matters for ties; the engine picks highest
 * confidence overall but short-circuits as soon as it sees confidence >= 1.0
 * to keep the definite-trivial fast-path cheap.
 *
 * Patterns flagged `bareSafe: true` route to --bare mode (S6 safety). They
 * MUST be syntactically restricted to known no-context operations.
 */
export const BUILTIN_RULES: ReadonlyArray<HeuristicRule> = [
  // Definite-trivial fast-path (S6 safety): single-line, no shell chaining
  {
    pattern: "^\\s*(prettier|eslint)\\b(?:\\s+[^|&;`$\\n]*)?\\s*$",
    flags: "i",
    class: "trivial",
    confidence: 1.0,
    source: "builtin",
    bareSafe: true,
  },
  {
    pattern: "^\\s*git\\s+(status|diff|log)\\b(?:\\s+[^|&;`$\\n]*)?\\s*$",
    flags: "i",
    class: "trivial",
    confidence: 1.0,
    source: "builtin",
    bareSafe: true,
  },
  {
    pattern: "^\\s*(rename|format|lint)\\s+\\S+(?:\\s+\\S+)?\\s*$",
    flags: "i",
    class: "trivial",
    confidence: 1.0,
    source: "builtin",
    bareSafe: true,
  },

  // Trivial (with context)
  {
    pattern:
      "\\b(rename|format|lint|prettier|eslint|run the linter|run linter|run prettier)\\b",
    flags: "i",
    class: "trivial",
    confidence: 0.7,
    source: "builtin",
  },
  {
    pattern:
      "\\b(add|fix|update)\\s+(a |the )?(typo|comment|jsdoc|docstring|semicolon|copyright header|copyright)",
    flags: "i",
    class: "trivial",
    confidence: 0.75,
    source: "builtin",
  },
  {
    pattern: "\\b(lowercase|capitalize|format)\\s+(the|this)\\s+\\S+",
    flags: "i",
    class: "trivial",
    confidence: 0.7,
    source: "builtin",
  },

  // Simple
  {
    pattern:
      "\\b(update|change)\\s+(the\\s+)?(error message|timeout|default|placeholder|title|color|version|port|wording|icon)\\b",
    flags: "i",
    class: "simple",
    confidence: 0.75,
    source: "builtin",
  },
  {
    pattern:
      "\\b(add|update)\\s+(a |an |the )?(parameter|argument|comment|console\\.log|tooltip|todo|entry|hover|docstring)\\b",
    flags: "i",
    class: "simple",
    confidence: 0.7,
    source: "builtin",
  },

  // Hard — bugs and refactors that need investigation
  {
    pattern: "\\b(flaky|race condition|memory leak|deadlock|heisenbug|off-by-one)\\b",
    flags: "i",
    class: "hard",
    confidence: 0.85,
    source: "builtin",
  },
  {
    pattern: "\\b(security vulnerability|security flaw)\\b",
    flags: "i",
    class: "hard",
    confidence: 0.8,
    source: "builtin",
  },
  {
    pattern:
      "\\brefactor\\b.+(file|module|service|monolith|middleware|architecture|monorepo)",
    flags: "i",
    class: "hard",
    confidence: 0.75,
    source: "builtin",
  },
  {
    pattern:
      "\\b(slow|timing out|times out|crashes?|crashing|grows? linearly|under load|in CI but)\\b",
    flags: "i",
    class: "hard",
    confidence: 0.7,
    source: "builtin",
  },
  {
    pattern: "\\bmigrate\\b.+(endpoint|from|to|api)",
    flags: "i",
    class: "hard",
    confidence: 0.7,
    source: "builtin",
  },

  // Reasoning — design / compare / evaluate
  {
    pattern:
      "\\b(design|architect|architecture)\\b.+(system|service|layer|api|database|stack|pipeline|infrastructure|sharding|replication|strategy|model)",
    flags: "i",
    class: "reasoning",
    confidence: 0.85,
    source: "builtin",
  },
  {
    pattern:
      "\\b(should we|compare|evaluate|what['’]?s the best|how should we|design (our|a|the))\\b",
    flags: "i",
    class: "reasoning",
    confidence: 0.75,
    source: "builtin",
  },

  // Max — adversarial debugging
  {
    pattern: "\\b(production is down|prod (?:is )?down|here are the logs|here's the logs)\\b",
    flags: "i",
    class: "max",
    confidence: 0.95,
    source: "builtin",
  },
  {
    pattern:
      "\\b(can[''’]?t reproduce|cannot reproduce|unreproducible|intermittent(?:ly)?|silent (?:data )?loss|byzantine|heisenbug|no error in logs|no slow query log)\\b",
    flags: "i",
    class: "max",
    confidence: 0.9,
    source: "builtin",
  },
  {
    pattern:
      "\\b(oom-killed|cascading failure|stale content|consensus|exfil|breach|security breach|corrupt(?:ed)? data|missed a \\d+(?:-hour|-day) outage|byzantine fault)\\b",
    flags: "i",
    class: "max",
    confidence: 0.85,
    source: "builtin",
  },
  {
    pattern: "\\b(data loss|data race|vanishing|leak vulnerability|root cause)\\b",
    flags: "i",
    class: "max",
    confidence: 0.8,
    source: "builtin",
  },
];

const KNOWN_CLASSES: ReadonlyArray<Class> = [
  "trivial",
  "simple",
  "standard",
  "hard",
  "reasoning",
  "max",
];

export type HeuristicOptions = {
  /** Override built-in rules entirely (tests). */
  rules?: ReadonlyArray<HeuristicRule>;
  /** Extra user rules appended after built-ins. */
  extraRules?: ReadonlyArray<HeuristicRule>;
};

type Compiled = { rule: HeuristicRule; re: RegExp };

export function createHeuristicClassifier(opts: HeuristicOptions = {}): Classifier {
  const rules = opts.rules ?? [...BUILTIN_RULES, ...(opts.extraRules ?? [])];
  const compiled: Compiled[] = rules.map((r) => ({
    rule: r,
    re: new RegExp(r.pattern, r.flags ?? "i"),
  }));

  const classify: ClassifyFn = (req: Request): Classification | null => {
    const diagnostics: Diagnostic[] = [];

    if (req.prompt.length > SIZE_THRESHOLD) {
      diagnostics.push({
        severity: "info",
        code: "size.longcontext",
        message: `prompt is ${req.prompt.length} chars (>${SIZE_THRESHOLD}); favor sonnet`,
      });
      return { class: "standard", confidence: 0.7, diagnostics };
    }

    let best: Compiled | null = null;
    for (const c of compiled) {
      if (!c.re.test(req.prompt)) continue;
      if (c.rule.confidence >= 1.0) {
        best = c;
        break;
      }
      if (!best || c.rule.confidence > best.rule.confidence) {
        best = c;
      }
    }

    if (!best) return null;

    diagnostics.push({
      severity: "info",
      code: "heuristic.matched",
      message: `${best.rule.class} @${best.rule.confidence.toFixed(2)} (${best.rule.source ?? "user"})`,
    });
    if (best.rule.bareSafe === true) {
      diagnostics.push({
        severity: "info",
        code: "heuristic.bare_safe",
        message: "definite-trivial fast-path",
      });
    }

    return {
      class: best.rule.class,
      confidence: best.rule.confidence,
      diagnostics,
    };
  };

  return createClassifier({ name: "heuristic", weight: 0.7, classify });
}

/** Default classifier with built-in rules only. */
export const heuristicClassifier = createHeuristicClassifier();

/** Load and validate user heuristic rules from disk. Returns [] if file missing. */
export async function loadUserHeuristics(path: string): Promise<HeuristicRule[]> {
  let data: string;
  try {
    data = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const parsed: unknown = JSON.parse(data);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isValidHeuristic);
}

function isValidHeuristic(value: unknown): value is HeuristicRule {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  if (typeof r.pattern !== "string" || r.pattern.length === 0) return false;
  if (typeof r.confidence !== "number" || !Number.isFinite(r.confidence)) return false;
  if (r.confidence < 0 || r.confidence > 1) return false;
  if (typeof r.class !== "string") return false;
  if (!KNOWN_CLASSES.includes(r.class as Class)) return false;
  return true;
}
