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

const SIZE_THRESHOLD_LARGE = 50_000;
const SIZE_THRESHOLD_MEDIUM = 15_000;

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
  // Git write operations: mechanical commands, no model reasoning needed.
  // Not bareSafe (side-effectful) but unambiguously trivial.
  {
    pattern: "^\\s*git\\s+(add|commit|push|pull|stash|fetch|checkout|tag|restore)\\b(?:\\s+[^|&;`$\\n]*)?\\s*$",
    flags: "i",
    class: "trivial",
    confidence: 0.85,
    source: "builtin",
  },
  {
    pattern: "^\\s*(rename|format|lint)\\s+\\S+(?:\\s+\\S+)?\\s*$",
    flags: "i",
    class: "trivial",
    confidence: 1.0,
    source: "builtin",
    bareSafe: true,
  },

  // Trivial — tool/command output looks like a finished tool result. These
  // appear in panels where the user pastes context for the next prompt;
  // they need no model thinking on their own. Conservative confidence:
  // a wider, less specific pattern catches these without claiming high
  // certainty.
  {
    pattern:
      "^(tool result:|glob results:|grep returned:|command output:|build output:|here are the file contents|<file>|file (written|already exists))",
    flags: "i",
    class: "trivial",
    confidence: 0.85,
    source: "builtin",
  },
  // Multi-line bare path list (e.g. "src/index.ts\nsrc/lib.ts") — common
  // tool output shape, no prose.
  {
    pattern: "^(?:[\\w./@-]+\\.[a-z]{1,5}\\s*\\n){2,}",
    flags: "",
    class: "trivial",
    confidence: 0.8,
    source: "builtin",
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
    pattern: "\\bfix\\s+(the\\s+)?(indentation|whitespace|spacing|formatting)\\b",
    flags: "i",
    class: "trivial",
    confidence: 0.85,
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
  // Trivial — bump version (single field in package.json / pyproject.toml)
  {
    pattern: "\\b(bump|update|set)\\s+(the\\s+)?(package\\s+)?version\\b",
    flags: "i",
    class: "trivial",
    confidence: 0.8,
    source: "builtin",
  },
  // Trivial — add to .gitignore
  {
    pattern: "\\b(add|append).+\\.?gitignore\\b",
    flags: "i",
    class: "trivial",
    confidence: 0.85,
    source: "builtin",
  },
  // Trivial — add to exports/barrel/index (one-liner re-export)
  {
    pattern: "\\b(re-?export|add|include)\\s+.+\\b(to\\s+(the\\s+)?(index|exports?|barrel)|re-?export)\\b",
    flags: "i",
    class: "trivial",
    confidence: 0.75,
    source: "builtin",
  },
  // Trivial — move/relocate a file (mechanical path change)
  {
    pattern: "\\b(move|relocate)\\s+(this\\s+|the\\s+)?(file|module|component)\\b",
    flags: "i",
    class: "trivial",
    confidence: 0.75,
    source: "builtin",
  },

  // Simple
  {
    pattern:
      "\\b(update|change)\\s+(the\\s+)?(error message|timeout|default|placeholder|title|color|version|port|wording|icon|readme|success message|message)\\b",
    flags: "i",
    class: "simple",
    confidence: 0.75,
    source: "builtin",
  },
  {
    pattern:
      "\\b(add|update)\\s+(a |an |the )?(parameter|argument|optional|comment|console\\.log|tooltip|todo|entry|hover|docstring)\\b",
    flags: "i",
    class: "simple",
    confidence: 0.7,
    source: "builtin",
  },
  // Single-spot config/value tweaks ("change http to https", "add a new
  // entry to the enum"). Bounded to short prompts so we don't catch
  // multi-step requests of the same shape.
  {
    pattern:
      "\\bchange\\s+(http|https|the\\s+(host|url|endpoint|protocol|scheme))\\s+to\\b",
    flags: "i",
    class: "simple",
    confidence: 0.7,
    source: "builtin",
  },
  {
    pattern:
      "\\badd\\s+(a |an |the )?new\\s+(entry|value|item|option|case)\\s+to\\s+(the\\s+)?(enum|list|array|map|switch|select|dropdown)\\b",
    flags: "i",
    class: "simple",
    confidence: 0.75,
    source: "builtin",
  },
  // Simple — write a unit/integration test for a specific function/component
  {
    pattern: "\\b(write|add|create)\\s+(a\\s+)?(unit\\s+|integration\\s+|e2e\\s+)?tests?\\s+(for|to|covering)\\b",
    flags: "i",
    class: "simple",
    confidence: 0.75,
    source: "builtin",
  },
  // Simple — add error handling / null checks / guard clauses
  {
    pattern: "\\b(add|implement|include)\\s+(proper\\s+)?(error\\s+handling|null\\s+(check|guard)|guard\\s+clause|input\\s+validation)\\b",
    flags: "i",
    class: "simple",
    confidence: 0.75,
    source: "builtin",
  },
  // Simple — remove unused code/imports (scoped, single-pass cleanup)
  {
    pattern: "\\b(remove|delete|clean\\s+up)\\s+(unused|dead|orphaned)\\s+(import|variable|code|export|param|function|class|dep)s?\\b",
    flags: "i",
    class: "simple",
    confidence: 0.75,
    source: "builtin",
  },
  // Simple — add type annotations (TypeScript/Python type pass)
  {
    pattern: "\\b(add|annotate\\s+with|apply)\\s+(type\\s+annotations?|types)\\s+to\\b",
    flags: "i",
    class: "simple",
    confidence: 0.75,
    source: "builtin",
  },
  // Simple — extract a function/method/component (local refactor, single spot)
  {
    pattern: "\\bextract\\s+(this|it)?\\s*(into\\s+)?(a\\s+)?(function|method|component|helper|util|hook)\\b",
    flags: "i",
    class: "simple",
    confidence: 0.75,
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
  // Cross-codebase or "split this file into..." work that requires
  // touching many files without a tight spec.
  {
    pattern:
      "\\b(find\\s+and\\s+fix|fix\\s+all|remove\\s+all|clean\\s+up\\s+all|split\\s+this|break\\s+this\\s+up)\\b",
    flags: "i",
    class: "hard",
    confidence: 0.75,
    source: "builtin",
  },
  {
    pattern: "\\b(eviction|invalidation)\\s+(is|seems|appears)\\s+(wrong|off|broken|buggy)\\b",
    flags: "i",
    class: "hard",
    confidence: 0.8,
    source: "builtin",
  },

  // Hard — failing tests or CI (requires investigation, not just a re-run)
  {
    pattern: "\\b(tests?|test\\s+suite|specs?|CI|build|pipeline)\\s+(is\\s+|are\\s+)?(failing|broken|red|not\\s+passing)\\b",
    flags: "i",
    class: "hard",
    confidence: 0.75,
    source: "builtin",
  },
  // Hard — "why does/is/are X not work/fail/crash" debugging question
  {
    pattern: "\\bwhy\\s+(does|is|are|did|do|would)\\b.+\\b(not\\s+work|fail|break|crash|throw|hang|return\\s+null|return\\s+undefined)\\b",
    flags: "i",
    class: "hard",
    confidence: 0.75,
    source: "builtin",
  },
  // Hard — explicit request for debugging help
  {
    pattern: "\\b(help\\s+me\\s+debug|debug\\s+this|can[''']?t\\s+figure\\s+out\\s+why|can[''']?t\\s+understand\\s+why)\\b",
    flags: "i",
    class: "hard",
    confidence: 0.75,
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
      "\\b(should we|compare|evaluate|what[‘’]?s the best|how should we|design (our|a|the))\\b",
    flags: "i",
    class: "reasoning",
    confidence: 0.75,
    source: "builtin",
  },
  // Reasoning — trade-off analysis
  {
    pattern: "\\b(pros\\s+and\\s+cons|trade-?offs?|what\\s+are\\s+the\\s+(advantages|disadvantages|benefits|drawbacks))\\b",
    flags: "i",
    class: "reasoning",
    confidence: 0.8,
    source: "builtin",
  },
  // Reasoning — best approach/practice/way for/to
  {
    pattern: "\\bbest\\s+(approach|practice|way|strategy|pattern)\\s+(for|to)\\b",
    flags: "i",
    class: "reasoning",
    confidence: 0.8,
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
  // "customers report random X, no error in logs" — adversarial-debugging
  // signature: visible user-facing symptom + invisible cause.
  {
    pattern:
      "\\b(customers?\\s+report|users?\\s+report|reports?\\s+of)\\b.+\\b(random|intermittent|sometimes|occasional|flaky)\\b",
    flags: "i",
    class: "max",
    confidence: 0.85,
    source: "builtin",
  },
  // Multi-service blast radius: explicit count of services affected.
  {
    pattern: "\\b(took\\s+down|brought\\s+down|knocked\\s+out)\\s+(\\d+|several|multiple|many)\\s+services?\\b",
    flags: "i",
    class: "max",
    confidence: 0.9,
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
