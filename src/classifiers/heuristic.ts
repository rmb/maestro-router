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
  {
    pattern: "^\\s*(sort|reorder|organize)\\s+imports?\\s*$",
    flags: "i",
    class: "trivial",
    confidence: 1.0,
    source: "builtin",
    bareSafe: true,
  },
  {
    pattern: "^\\s*remove\\s+(?:all\\s+)?unused\\s+imports?\\s*$",
    flags: "i",
    class: "trivial",
    confidence: 1.0,
    source: "builtin",
    bareSafe: true,
  },

  // console.log / debug-logging add or remove — always trivial
  {
    pattern: "\\b(add|insert|remove|delete|clean\\s+up)\\s+(a\\s+|all\\s+)?(console\\.(log|warn|error|debug|trace)|log\\s+statement|debug\\s+statement|print\\s+statement)\\b",
    flags: "i",
    class: "trivial",
    confidence: 0.85,
    source: "builtin",
  },
  // strip trailing whitespace / blank lines
  {
    pattern: "\\b(remove|strip|trim)\\s+(trailing\\s+)?(whitespace|spaces?|blank\\s+lines?)\\b",
    flags: "i",
    class: "trivial",
    confidence: 0.9,
    source: "builtin",
    bareSafe: true,
  },
  // add return type annotation (one-pass TypeScript/Python annotation)
  {
    pattern: "\\badd\\s+(a\\s+)?return\\s+type\\s+(annotation|hint)?\\b",
    flags: "i",
    class: "trivial",
    confidence: 0.85,
    source: "builtin",
  },
  // add readonly modifier to property/field (add/make/mark)
  {
    pattern: "\\badd\\s+readonly\\s+(to\\b|modifier|keyword)?|\\b(make|mark)\\s+(this|the)\\s+(property|field|param|attribute)\\s+(as\\s+)?readonly\\b",
    flags: "i",
    class: "trivial",
    confidence: 0.85,
    source: "builtin",
  },
  // add empty / blank line between blocks
  {
    pattern: "\\badd\\s+an?\\s+(empty|blank)\\s+line\\b",
    flags: "i",
    class: "trivial",
    confidence: 0.9,
    source: "builtin",
  },
  // convert object/value to JSON (JSON.stringify one-liner)
  {
    pattern: "\\bconvert\\s+(this|the|a)\\s+(object|value|response|result|data)\\s+to\\s+json\\b",
    flags: "i",
    class: "trivial",
    confidence: 0.8,
    source: "builtin",
  },
  // "rename X to Y" — plain identifier rename with explicit "to" connector
  {
    pattern: "^\\s*rename\\s+\\w[\\w.]*\\s+to\\s+\\w[\\w.]*\\s*$",
    flags: "i",
    class: "trivial",
    confidence: 0.9,
    source: "builtin",
    bareSafe: true,
  },
  // change var/let to const — scope-only mechanical fix
  {
    pattern: "\\b(change|convert|replace)\\s+(var|let)\\s+to\\s+const\\b|\\bconvert\\s+(all\\s+)?(var|let)s?\\s+to\\s+consts?\\b",
    flags: "i",
    class: "trivial",
    confidence: 0.85,
    source: "builtin",
  },
  // convert arrow function to regular/named function — pure syntax transform
  {
    pattern: "\\bconvert\\s+(this\\s+|the\\s+)?arrow\\s+function\\s+(to|into)\\s+(a\\s+)?(?:named\\s+|regular\\s+)?function\\b",
    flags: "i",
    class: "trivial",
    confidence: 0.85,
    source: "builtin",
  },
  // remove commented-out code block
  {
    pattern: "\\b(remove|delete)\\s+(the\\s+|this\\s+|all\\s+)?commented(?:-out|\\s+out)?\\s+(code|block|lines?|section)s?\\b",
    flags: "i",
    class: "trivial",
    confidence: 0.85,
    source: "builtin",
  },
  // add trailing comma
  {
    pattern: "\\badd\\s+(a\\s+)?trailing\\s+comma\\b",
    flags: "i",
    class: "trivial",
    confidence: 0.9,
    source: "builtin",
  },
  // convert string concatenation to template literal
  {
    pattern: "\\bconvert\\s+(this\\s+|the\\s+)?string\\s+concatenation\\s+to\\s+(a\\s+)?template\\s+(literal|string)\\b",
    flags: "i",
    class: "trivial",
    confidence: 0.85,
    source: "builtin",
  },
  // add newline at end of file
  {
    pattern: "\\badd\\s+(a\\s+)?newline\\s+(at\\s+the\\s+end|at\\s+end)\\s+of\\s+(this\\s+)?file\\b",
    flags: "i",
    class: "trivial",
    confidence: 0.9,
    source: "builtin",
  },
  // convert require() to ES module import
  {
    pattern: "\\b(convert|change)\\s+(this\\s+|the\\s+|from\\s+)?require\\(?\\)?\\s*(call\\s+)?to\\s+(an?\\s+)?(?:es\\s+|esm\\s+)?(?:module\\s+)?import\\b|\\bchange\\s+(from\\s+)?require\\s+to\\s+import\\b",
    flags: "i",
    class: "trivial",
    confidence: 0.85,
    source: "builtin",
  },
  // change import style (default ↔ named)
  {
    pattern: "\\bchange\\s+(this\\s+|the\\s+)?(default\\s+import|named\\s+import)\\s+to\\s+(a\\s+)?(named|default)\\s+import\\b",
    flags: "i",
    class: "trivial",
    confidence: 0.85,
    source: "builtin",
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
      "\\b(add|fix|update)\\s+(a |the )?(php\\s+|missing\\s+|jsdoc\\s+)?(typo|comment|docstring|docblock|jsdoc|semicolon|copyright\\s+header|copyright)",
    flags: "i",
    class: "trivial",
    confidence: 0.75,
    source: "builtin",
  },
  // Trivial — add @deprecated annotation or TODO comment
  {
    pattern: "\\badd\\s+(a\\s+)?@deprecated\\b|\\badd\\s+(the\\s+)?deprecated\\s+(jsdoc\\s+)?(tag|annotation|comment)\\b",
    flags: "i",
    class: "trivial",
    confidence: 0.8,
    source: "builtin",
  },
  {
    pattern: "\\b(add|update)\\s+(a\\s+)?todo\\s+comment\\b",
    flags: "i",
    class: "trivial",
    confidence: 0.8,
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
    pattern: "\\b(bump|update|set)\\s+(the\\s+)?(patch|minor|major|package|semver)?\\s*version\\b",
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
  // Trivial — sort/reorder imports (flexible: "sort these imports alphabetically")
  {
    pattern: "\\b(sort|reorder|organize)\\s+(these\\s+|the\\s+|all\\s+)?imports?\\b",
    flags: "i",
    class: "trivial",
    confidence: 0.9,
    source: "builtin",
  },
  // Trivial — remove unused import(s) (handles "this/an unused import")
  {
    pattern: "\\b(remove|delete)\\s+(this\\s+|an?\\s+|the\\s+)?unused\\s+(?:imports?|variable|var|const(?:ant)?|param(?:eter)?)\\b",
    flags: "i",
    class: "trivial",
    confidence: 0.85,
    source: "builtin",
  },
  // Trivial — add default value to optional parameter
  {
    pattern: "\\badd\\s+(a\\s+)?default\\s+(value|parameter)\\s+(to|for)\\b",
    flags: "i",
    class: "trivial",
    confidence: 0.8,
    source: "builtin",
  },
  // Trivial — add deprecation notice/warning
  {
    pattern: "\\badd\\s+(a\\s+)?deprecat(ion|ed)\\s+(notice|warning|comment|annotation|decorator)\\b",
    flags: "i",
    class: "trivial",
    confidence: 0.85,
    source: "builtin",
  },
  // Trivial — PHP mechanical fixes (type hint, docblock, array syntax, class rename)
  {
    pattern: "\\badd\\s+(a\\s+)?(type\\s+hint|docblock|phpdoc|php\\s+doc)\\s+(to|for|on)\\b",
    flags: "i",
    class: "trivial",
    confidence: 0.85,
    source: "builtin",
  },
  {
    pattern: "\\bconvert\\s+(this\\s+)?php\\s+array\\s+syntax\\b|\\bconvert\\s+array\\(\\)\\s+to\\s+\\[\\]\\b",
    flags: "i",
    class: "trivial",
    confidence: 0.9,
    source: "builtin",
  },
  // Trivial — Next.js/React mechanical changes
  {
    pattern: "\\badd\\s+(a\\s+)?loading\\.tsx\\b|\\bconvert\\s+(this\\s+)?page\\s+to\\s+(a\\s+)?server\\s+component\\b|\\bmark\\s+(this\\s+|the\\s+)?component\\s+as\\s+['\"]?use\\s+client['\"]?\\b",
    flags: "i",
    class: "trivial",
    confidence: 0.85,
    source: "builtin",
  },

  // Trivial — pure greetings (no task, just a salutation)
  {
    pattern: "^\\s*(hello|hi|hey|howdy|greetings|sup|what'?s\\s+up)[\\s!?.]*$",
    flags: "i",
    class: "trivial",
    confidence: 0.9,
    source: "builtin",
  },
  // Simple — bare affirmations / one-word acknowledgments.
  // Confidence intentionally below short-circuit (0.6) so Markov prior can
  // overrule when session context suggests heavier work (e.g. "yes" approving
  // a complex implementation plan → Markov sees prior hard/standard → wins).
  {
    pattern: "^\\s*(yes|no|ok|okay|sure|yep|nope|nah|correct|exactly|approved?|confirmed?|sounds\\s+good|looks\\s+good|perfect|great|nice|good|got\\s+it|makes\\s+sense|understood)[\\s!?.]*$",
    flags: "i",
    class: "simple",
    confidence: 0.5,
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
  // Simple — write a unit test for a specific single function/method/component (not a whole module)
  {
    pattern: "\\b(write|add|create)\\s+(a\\s+)?(unit\\s+)?tests?\\s+(?:for|to|covering)\\s+(?:this|the)\\s+(?:\\w+\\s+)*(?:function|method|class|component|hook|util(?:ity)?|helper|service\\s+method|utility\\s+function|switch\\s+statement|logic)\\b",
    flags: "i",
    class: "simple",
    confidence: 0.75,
    source: "builtin",
  },
  // Simple — write a unit test covering specific cases/paths (for a named method or function)
  {
    pattern: "\\b(write|add|create)\\s+(a\\s+)?(?:unit\\s+|integration\\s+)?tests?\\s+covering\\b.{0,80}\\bfor\\s+this\\b",
    flags: "i",
    class: "simple",
    confidence: 0.75,
    source: "builtin",
  },
  // Simple — write tests for specific logic in a scoped context
  {
    pattern: "\\b(write|add|create)\\s+(a\\s+)?tests?\\s+for\\s+each\\s+(branch|case|path)\\s+(in|of)\\s+(this|the)\\s+\\w+\\b",
    flags: "i",
    class: "simple",
    confidence: 0.75,
    source: "builtin",
  },
  // Simple — add null checks / guard clauses or scoped error handling (single call/function, not whole client)
  {
    pattern: "\\b(add|implement|include)\\s+(a\\s+|an?\\s+|proper\\s+)?(null\\s+(check|guard)|null(?:able)?\\s+(check|guard|assertion)|guard\\s+clause|input\\s+sanitization)\\b",
    flags: "i",
    class: "simple",
    confidence: 0.75,
    source: "builtin",
  },
  // Simple — add error handling / try-catch to a single specific call or function
  {
    pattern: "\\b(add|implement)\\s+(a\\s+)?(try.?catch|error\\s+handling)\\s+(to|for|around)\\s+(this|the)\\s+(function|method|fetch|call|request|handler|operation|query)\\b",
    flags: "i",
    class: "simple",
    confidence: 0.75,
    source: "builtin",
  },
  // Simple — add input validation to a specific single endpoint/route/function (not a whole form/module)
  {
    pattern: "\\b(add|implement)\\s+(input\\s+|request\\s+)?(validation|sanitization)\\s+(to|for)\\s+(this|the)\\s+(endpoint|route|handler|function|method|controller|api\\s+endpoint)\\b",
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
  // Simple — extract repeated string/literal/query/logic to a named constant, function, or utility
  {
    pattern: "\\bextract\\s+(this\\s+|the\\s+)?(repeated\\s+|inline\\s+|hard-?coded\\s+)?(?:\\w+\\s+)?(string|literal|sql(?:\\s+query)?|query|value|logic|function)\\s+(into|to|as)\\s+(a\\s+)?(constant|const|variable|named\\s+function|shared\\s+utility|helper|util(?:ity)?)\\b",
    flags: "i",
    class: "simple",
    confidence: 0.75,
    source: "builtin",
  },
  // Simple — convert callback to async/await
  {
    pattern: "\\bconvert\\s+(this\\s+)?callback\\s+to\\s+async\\b|\\bpromisify\\s+(this|the)\\b",
    flags: "i",
    class: "simple",
    confidence: 0.75,
    source: "builtin",
  },
  // Simple — create TypeScript/language interface for a shape
  {
    pattern: "\\bcreate\\s+(a?n?\\s+)?(TypeScript\\s+|TS\\s+)?interface\\s+for\\b",
    flags: "i",
    class: "simple",
    confidence: 0.75,
    source: "builtin",
  },
  // Simple — add rate limiter to route/handler
  {
    pattern: "\\badd\\s+(a\\s+)?rate\\s+limit(er)?\\s+(to|for)\\b",
    flags: "i",
    class: "simple",
    confidence: 0.75,
    source: "builtin",
  },
  // Simple — convert class component to function component (React)
  {
    pattern: "\\bconvert\\s+(this\\s+)?class\\s+component\\s+to\\s+(a\\s+)?function\\s+component\\b",
    flags: "i",
    class: "simple",
    confidence: 0.8,
    source: "builtin",
  },
  // Simple — add logging or request middleware
  {
    pattern: "\\badd\\s+(a\\s+)?(logging|request\\s+logging|morgan|access\\s+log)\\s+middleware\\b",
    flags: "i",
    class: "simple",
    confidence: 0.7,
    source: "builtin",
  },
  // Simple — implement builder pattern (single class, bounded scope)
  {
    pattern: "\\b(implement|add|create)\\s+(a\\s+)?(builder\\s+pattern|fluent\\s+builder|builder\\s+class)\\b",
    flags: "i",
    class: "simple",
    confidence: 0.75,
    source: "builtin",
  },
  // Simple — write a snapshot test
  {
    pattern: "\\b(write|add|create)\\s+(a\\s+)?snapshot\\s+tests?\\s+(for|to|covering)\\b",
    flags: "i",
    class: "simple",
    confidence: 0.75,
    source: "builtin",
  },
  // Simple — implement a retry wrapper (explicitly a wrapper/decorator, not full logic with backoff)
  {
    pattern: "\\b(implement|add|create|write)\\s+(a\\s+)?(simple\\s+)?retry\\s+(wrapper|decorator)\\b",
    flags: "i",
    class: "simple",
    confidence: 0.75,
    source: "builtin",
  },
  // Standard — generic pagination to a list/endpoint (non-trivial wiring)
  {
    pattern: "\\badd\\s+pagination\\s+(to\\s+)?(the\\s+|this\\s+)?\\w+(?:\\s+\\w+)*\\b",
    flags: "i",
    class: "standard",
    confidence: 0.72,
    source: "builtin",
  },
  // Standard — search filtering (and optional sorting) on an endpoint
  {
    pattern: "\\bimplement\\s+search\\s+(filter(?:ing)?|sort(?:ing)?)\\b",
    flags: "i",
    class: "standard",
    confidence: 0.75,
    source: "builtin",
  },
  // Simple — add specific pagination type to a single endpoint (cursor/offset naming — not a full feature)
  {
    pattern: "\\badd\\s+(cursor|offset|keyset|page-based|limit-based)\\s+pagination\\b",
    flags: "i",
    class: "simple",
    confidence: 0.7,
    source: "builtin",
  },
  // Simple — PHP scoped changes (null coalescing, PHPUnit test, trait, input sanitization)
  {
    pattern: "\\badd\\s+(null\\s+coalescing|the\\s+\\?\\?\\s+operator|null\\s+coalesce)\\b",
    flags: "i",
    class: "simple",
    confidence: 0.75,
    source: "builtin",
  },
  {
    pattern: "\\bwrite\\s+(a\\s+)?(phpunit|pest)\\s+tests?\\s+(for|covering)\\b",
    flags: "i",
    class: "simple",
    confidence: 0.75,
    source: "builtin",
  },
  // Simple — add Node.js/Express middleware (request scoped)
  {
    pattern: "\\badd\\s+(a\\s+)?(express|fastify|koa|hapi|nest(js)?)\\s+middleware\\b|\\badd\\s+(a\\s+)?(cors|helmet|compression|body-parser|json-parser)\\s+(middleware|plugin)\\b",
    flags: "i",
    class: "simple",
    confidence: 0.75,
    source: "builtin",
  },
  // Simple — add Zod/Joi/Yup validation schema
  {
    pattern: "\\b(add|create|write)\\s+(a\\s+)?(zod|joi|yup|valibot|ajv)\\s+(schema|validator|validation)\\b",
    flags: "i",
    class: "simple",
    confidence: 0.75,
    source: "builtin",
  },
  // Simple — add Next.js API route handler
  {
    pattern: "\\badd\\s+(a\\s+)?(next\\.?js\\s+)?(api\\s+route|route\\s+handler)\\b",
    flags: "i",
    class: "simple",
    confidence: 0.75,
    source: "builtin",
  },

  // extract string/value into a named constant (single-file scope change)
  {
    pattern: "\\bextract\\s+(this\\s+|the\\s+)?(repeated\\s+|hardcoded\\s+|inline\\s+)?(string|value|number|url|path|config\\s+value)\\s+(into|to|as)\\s+(a\\s+)?(constant|const|named\\s+constant|config\\s+variable)\\b",
    flags: "i",
    class: "simple",
    confidence: 0.8,
    source: "builtin",
  },
  // convert callback / promise chain to async/await
  {
    pattern: "\\b(convert|refactor|rewrite|change)\\s+(this\\s+|the\\s+)?(callback|promise\\s+chain|\\.then\\s+chain|nested\\s+callbacks?)\\s+(to|into|using)\\s+(async|promises?)\\b|\\bpromisify\\b|\\bconvert\\s+to\\s+async\\/await\\b",
    flags: "i",
    class: "simple",
    confidence: 0.8,
    source: "builtin",
  },
  // create TypeScript interface or type alias
  {
    pattern: "\\b(create|add|define|write|generate)\\s+(a\\s+)?(typescript\\s+)?(interface|type\\s+alias)\\s+(for|to\\s+represent)\\b",
    flags: "i",
    class: "simple",
    confidence: 0.8,
    source: "builtin",
  },
  // add rate limiting to a route/handler
  {
    pattern: "\\badd\\s+(a\\s+)?rate\\s+(limit(?:er)?|limiting)\\s+(to|for|on|middleware)?\\b",
    flags: "i",
    class: "simple",
    confidence: 0.75,
    source: "builtin",
  },
  // convert class component → function component
  {
    pattern: "\\bconvert\\s+(this\\s+|the\\s+)?class(?:\\s+-?based)?\\s+component\\s+to\\s+(a\\s+)?function(?:al)?\\s+component\\b",
    flags: "i",
    class: "simple",
    confidence: 0.8,
    source: "builtin",
  },
  // add request/HTTP logging middleware
  {
    pattern: "\\badd\\s+(?:request\\s+|http\\s+|access\\s+|morgan\\s+)?logging\\s+middleware\\b",
    flags: "i",
    class: "simple",
    confidence: 0.75,
    source: "builtin",
  },
  // move function/method/class to a shared utils/lib file (handles "helper function", "validation logic" etc.)
  {
    pattern: "\\b(move|extract)\\s+(this\\s+|the\\s+)?(?:\\w+\\s+)?(function|method|class|helper|utility|util|logic|handler|validator)\\s+(to|into)\\s+(a\\s+)?(shared\\s+)?(utils|lib|helpers?|services?|file|module|utility|class)\\b",
    flags: "i",
    class: "simple",
    confidence: 0.75,
    source: "builtin",
  },
  // Simple — PHP class-level scoped changes
  {
    pattern: "\\badd\\s+(a\\s+)?php\\s+trait\\b|\\bconvert\\s+(this\\s+)?php\\s+class\\s+to\\s+use\\b|\\bphp\\s+constructor\\s+property\\s+promotion\\b",
    flags: "i",
    class: "simple",
    confidence: 0.75,
    source: "builtin",
  },
  // Simple — add/improve test coverage for a specific module or edge case
  {
    pattern: "\\badd\\s+(test\\s+coverage|coverage)\\s+(for|to)\\b|\\b(increase|improve|restore|boost)\\s+(test\\s+coverage|coverage\\s+for)\\b",
    flags: "i",
    class: "simple",
    confidence: 0.7,
    source: "builtin",
  },
  // add a health check endpoint
  {
    pattern: "\\badd\\s+(a\\s+)?health\\s+(check|probe)\\s+(endpoint|route|handler)?\\b",
    flags: "i",
    class: "simple",
    confidence: 0.75,
    source: "builtin",
  },
  // write a mock / stub for a service or dependency
  {
    pattern: "\\bwrite\\s+(a\\s+)?(?:jest\\s+|unit\\s+|test\\s+)?mock\\s+(for|of)\\b",
    flags: "i",
    class: "simple",
    confidence: 0.75,
    source: "builtin",
  },
  // add a retry mechanism / policy
  {
    pattern: "\\badd\\s+(a\\s+)?retry\\s+(mechanism|logic|wrapper|policy|strategy)\\b",
    flags: "i",
    class: "simple",
    confidence: 0.75,
    source: "builtin",
  },
  // implement a debounce / memoize / throttle utility
  {
    pattern: "\\bimplement\\s+(a\\s+)?(debounce|memoize|throttle|deep.?equali(?:ty)?|deep.?equal|deep.?clone)\\s+(hook|wrapper|function|utility|helper|check)?\\b",
    flags: "i",
    class: "simple",
    confidence: 0.75,
    source: "builtin",
  },
  // create a custom error / exception class
  {
    pattern: "\\b(create|implement)\\s+(a\\s+)?custom\\s+(error|exception)\\s+class\\b",
    flags: "i",
    class: "simple",
    confidence: 0.8,
    source: "builtin",
  },
  // add environment variable validation
  {
    pattern: "\\badd\\s+(environment\\s+variable|env\\s+var(?:iable)?)\\s+validation\\b",
    flags: "i",
    class: "simple",
    confidence: 0.75,
    source: "builtin",
  },
  // add CORS configuration/headers/support
  {
    pattern: "\\badd\\s+cors\\s+(config(?:uration)?|headers?|support|settings?|allow|middleware)?\\b",
    flags: "i",
    class: "simple",
    confidence: 0.75,
    source: "builtin",
  },

  // Hard — bugs and refactors that need investigation
  {
    pattern: "\\b(flaky|race\\s+conditions?|memory leak|deadlock|heisenbug|off-by-one)\\b",
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
      "\\b(slow\\w*|timing out|times out|crashes?|crashing|grows?\\s+(?:linearly|by\\s+\\d|steadily|over\\s+time)|under load|in CI but|runs?\\s+out\\s+of\\s+memory|out\\s+of\\s+memory)\\b",
    flags: "i",
    class: "hard",
    confidence: 0.7,
    source: "builtin",
  },
  {
    pattern: "\\bmigrate\\b.+(endpoint|api)\\b|\\bmigrate\\s+this\\s+endpoint\\b",
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
  // Hard — sweeping scope amplifier. Any mechanical-sounding verb (rename,
  // format, lint, refactor, add, update, move, migrate, document, write tests,
  // make, redesign) becomes hard when paired with a "touch everywhere"
  // qualifier. Confidence is set above the 0.7 broad "rename|format|lint"
  // trivial rule so it wins the highest-confidence pick — prevents "rename
  // all methods in the entire codebase" from being routed trivial.
  {
    pattern:
      "\\b(rename|format|lint|refactor|redesign|update|add|move|migrate|document|write\\s+tests?|cover|make|change)\\b.{0,80}\\b(entire\\s+(codebase|repo|repository|monorepo|project|api|service|app|application|component\\s+library|public\\s+api|color\\s+system)|across\\s+(the\\s+)?(entire|whole|all|monorepo|codebase|component\\s+library|public\\s+api|app|application|service)|everywhere|monorepo|across\\s+\\d+\\s+(services?|files?|repos?|projects?)|across\\s+all\\b|all\\s+API\\s+responses?)",
    flags: "i",
    class: "hard",
    confidence: 0.8,
    source: "builtin",
  },
  // Hard — multi-action chained imperatives ("add X and also update Y and then
  // refactor Z", "add X and measure Y", "add X, do Y, and write tests"). Multiple
  // discrete deliverables in one prompt — needs planning/coordination.
  {
    pattern:
      "\\b(add|update|fix|implement|refactor|write|change|move|rename|build|create)\\b[^.]{0,120}\\b(and\\s+(also|then|measure|verify|validate|benchmark|profile)|,\\s*(then|and))\\b[^.]{0,80}\\b(and\\s+\\w+|tests?|measure|verify|validate|benchmark|profile)\\b",
    flags: "i",
    class: "hard",
    confidence: 0.75,
    source: "builtin",
  },
  // Hard — single prompt requesting multiple cross-concern resilience
  // features ("add robust error handling with retry, circuit breaker, and
  // dead-letter queue"). Triggers only when the "with X, Y, and Z" follows
  // an "error handling" / "resilience" / "robustness" keyword — narrower than
  // generic 3-item bundles which are often legitimate standard-scope work
  // ("file upload with S3 storage, size limits, and MIME type validation").
  {
    pattern:
      "\\b(robust|resilient|production[-\\s]grade|production[-\\s]ready)\\s+(error|retry|fault|failure)\\b[^.]{0,80},\\s*[^.]{0,60},\\s*(and\\s+)?",
    flags: "i",
    class: "hard",
    confidence: 0.75,
    source: "builtin",
  },
  // Hard — short ambiguous imperative without explicit object ("just fix it",
  // "make it work", "clean up everything", "update it to match"). Pronoun
  // referents without prior context force the model to investigate.
  // Anchor at start only — these short forms can have a trailing object
  // ("update it to match the new spec"), but the leading form is the signal.
  {
    pattern:
      "^\\s*(just\\s+fix\\s+it|make\\s+it\\s+work|clean\\s+up\\s+everything|update\\s+it\\s+to\\s+(match|fit|work|conform|align)|fix\\s+(everything|all\\s+of\\s+it)|sort\\s+it\\s+(out|all\\s+out)|it\\s+crashed\\s+again)\\b",
    flags: "i",
    class: "hard",
    confidence: 0.85,
    source: "builtin",
  },
  // Hard — diagnostic question with vague referent ("what's wrong with this?",
  // "what does this do?" without a snippet, "the X is not firing"). The model
  // must investigate to even know what "this" or "it" refers to.
  {
    pattern:
      "^\\s*(what[''’]s\\s+wrong(\\s+with\\s+(this|it|that))?\\??|why\\s+(isn[''’]t|is)\\s+(this|it|that)\\s+working\\??)\\s*$",
    flags: "i",
    class: "hard",
    confidence: 0.85,
    source: "builtin",
  },
  // Hard — production symptom without a reproduction (intermittent, sometimes,
  // sporadic, randomly). Forces investigation across logs, timing, infra.
  {
    pattern:
      "\\b(sometimes|occasionally|randomly|every\\s+so\\s+often)\\s+(throws?|breaks?|fails?|crashes?|errors?|times?\\s+out|hangs?)\\b",
    flags: "i",
    class: "hard",
    confidence: 0.8,
    source: "builtin",
  },
  // Hard — "explain the (entire|whole) X" / "document the (entire|whole) X" —
  // sweeping understand-and-summarise tasks across a codebase.
  {
    pattern:
      "\\b(explain|document|summarize|describe|walk\\s+me\\s+through)\\s+(the\\s+)?(entire|whole|full|complete)\\s+(architecture|codebase|system|api|service|app|stack|design|public\\s+api)\\b",
    flags: "i",
    class: "hard",
    confidence: 0.8,
    source: "builtin",
  },
  // Hard — vague-object failure report ("the webhook is not firing",
  // "the X is broken/not working/not loading"). Short statement, no repro.
  {
    pattern:
      "^\\s*the\\s+\\S+(\\s+\\S+){0,2}\\s+(is|are|isn[''’]t|aren[''’]t)\\s+(not\\s+)?(firing|working|loading|responding|happening|sending|saving|persisting|updating|rendering|displaying|showing|going\\s+through)\\.?\\s*$",
    flags: "i",
    class: "hard",
    confidence: 0.75,
    source: "builtin",
  },
  // Simple — "design a simple/small/basic X component/form/button/card" — these
  // are bounded single-file UI primitives, not architecture work. Confidence
  // above 0.75 so it beats the generic "design (a|the|our)" reasoning rule
  // that would otherwise pull these into reasoning.
  {
    pattern:
      "\\bdesign\\s+(a\\s+|the\\s+)?(simple|small|basic|minimal|tiny|trivial)\\s+\\S+\\s+(component|button|form|card|modal|popover|tooltip|input|toggle|switch|badge|chip|tag|avatar|icon)\\b",
    flags: "i",
    class: "simple",
    confidence: 0.85,
    source: "builtin",
  },
  // Hard — implementation at scale ("for 10 million records", "for 1B rows",
  // "to handle 100k concurrent users"). Scale numbers signal capacity-design.
  {
    pattern:
      "\\b(implement|build|design|add|create|support|handle)\\b[^.]{0,80}\\b(?:for|to\\s+handle|to\\s+support|across|on|with|over)\\s+\\d+(?:[\\.,]\\d+)?\\s*(?:k|m|b|million|billion|thousand|million\\+|billion\\+)?\\s+(records?|rows?|users?|requests?|events?|connections?|messages?|writes?|reads?|tps|rps|qps|ops|transactions?)\\b",
    flags: "i",
    class: "hard",
    confidence: 0.8,
    source: "builtin",
  },
  // Hard — sweeping completeness for test coverage ("write tests that cover
  // all the edge cases", "make sure nothing regresses"). Unbounded surface,
  // requires the model to enumerate cases.
  {
    pattern:
      "\\b(write|add|cover|ensure)\\s+(?:that\\s+)?(?:tests?\\s+(?:that\\s+|to\\s+)?)?(?:cover\\s+|capture\\s+|exercise\\s+|exhaustively\\s+)?(?:all\\s+(?:the\\s+)?(?:edge\\s+cases?|corner\\s+cases?|paths?|branches?|scenarios?|permutations?)|every\\s+(?:edge\\s+case|corner\\s+case|path|branch|scenario|permutation))\\b|\\bmake\\s+sure\\s+nothing\\s+regresses?\\b",
    flags: "i",
    class: "hard",
    confidence: 0.75,
    source: "builtin",
  },
  // Reasoning — "is X worth (it|the Y) (for Z)?" — evaluation/trade-off
  // framed as a single question. Captures TypeScript-worth-it style prompts.
  {
    pattern:
      "\\bis\\s+\\S+(?:\\s+\\S+){0,3}\\s+worth\\s+(?:it|the\\s+\\S+(?:\\s+\\S+){0,3})\\b",
    flags: "i",
    class: "reasoning",
    confidence: 0.8,
    source: "builtin",
  },
  // Simple — short context-free imperative ("add an index", "add error
  // handling", "what does this function do") with no scale/scope/multi-action
  // qualifier. Anchored full-prompt — must be the entire prompt to avoid
  // catching longer sentences that include these phrases.
  {
    pattern:
      "^\\s*(add\\s+(?:an?\\s+)?(index|error\\s+handling|validation|null\\s+check|loading\\s+state|spinner|tooltip|placeholder|aria\\s+label|alt\\s+text)|what\\s+does\\s+(?:this|that)\\s+(?:function|method|class|module|file|code)\\s+do\\??|how\\s+does\\s+(?:this|that)\\s+(?:function|method|class|module|file)\\s+work\\??)\\s*\\.?\\s*$",
    flags: "i",
    class: "simple",
    confidence: 0.8,
    source: "builtin",
  },
  // Max — production incident with concrete impact signal (production +
  // (spike|surge|drop|outage|silent failure|customer impact) within a short
  // window). High confidence — money/customers at stake.
  {
    pattern:
      "\\b(production|prod|live|customer|customers)\\b[^.]{0,80}\\b(spiked?|surged?|grew\\s+\\d+x|crashed|outage|silent(?:ly)?\\s+fail(?:ing|ed)?|silently\\s+(?:dropping|losing|corrupting)|data\\s+(?:loss|corruption)|isn[''’]?t\\s+showing\\s+up|aren[''’]?t\\s+showing\\s+up|not\\s+showing\\s+up)\\b",
    flags: "i",
    class: "max",
    confidence: 0.85,
    source: "builtin",
  },

  // Hard — failing tests or CI (requires investigation, not just a re-run)
  {
    pattern: "\\b(tests?|test\\s+suite|specs?|CI|build|pipeline)\\s+(is\\s+|are\\s+)?(all\\s+)?(failing|broken|red|not\\s+passing)\\b",
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
  // Hard — explicit bug report ("there's a bug", "I found a bug")
  {
    pattern: "\\b(there[''']?s\\s+a\\s+bug|i\\s+(?:think\\s+)?found\\s+a\\s+bug|there\\s+is\\s+a\\s+bug|found\\s+a\\s+(?:bug|regression))\\b",
    flags: "i",
    class: "hard",
    confidence: 0.75,
    source: "builtin",
  },
  // Hard — performance investigation / optimization request
  {
    pattern: "\\b(speed\\s+(?:this\\s+)?up|improve\\s+(?:the\\s+)?performance|reduce\\s+(?:the\\s+)?latency|optimize\\s+(?:for\\s+)?(?:speed|performance|throughput))\\b",
    flags: "i",
    class: "hard",
    confidence: 0.75,
    source: "builtin",
  },
  // Hard — network connections dropping/disconnecting (requires investigation)
  {
    pattern: "\\b(connection|connections|websocket|socket)s?\\s+(are\\s+)?(dropping|dropped|disconnecting|disconnect)\\b",
    flags: "i",
    class: "hard",
    confidence: 0.8,
    source: "builtin",
  },
  // Hard — test/build/CI "fails" (present tense, not just "failing")
  {
    pattern: "\\b(test|tests|spec|CI|build|pipeline)\\s+(only\\s+)?fails?\\s+(on|in|when|with)\\b",
    flags: "i",
    class: "hard",
    confidence: 0.75,
    source: "builtin",
  },
  // Hard — fails when run in parallel (concurrency issue)
  {
    pattern: "\\bfails?\\s+(when|if)\\s+(run|running|executed)\\s+in\\s+parallel\\b",
    flags: "i",
    class: "hard",
    confidence: 0.85,
    source: "builtin",
  },
  // Hard — silent failure with no visible error (deployment, job, queue)
  {
    pattern: "\\bfails?\\s+silently\\b|\\bsilent\\s+(failure|drop|error)\\b",
    flags: "i",
    class: "hard",
    confidence: 0.8,
    source: "builtin",
  },
  // Hard — auth/session issues (stale tokens plural/singular, wrong redirect, premature expiry)
  {
    pattern: "\\b(stale\\s+tokens?|tokens?\\s+stale|sessions?\\s+expire\\s+too\\s+(quickly|fast|soon)|redirect(s|ing)?\\s+to\\s+the\\s+wrong)\\b",
    flags: "i",
    class: "hard",
    confidence: 0.8,
    source: "builtin",
  },
  // Hard — CI/test fails only on a specific branch/environment (branching bug)
  {
    pattern: "\\b(tests?|CI|build|pipeline)\\s+(only\\s+)?fails?\\s+(only\\s+)?(on|in)\\s+(the\\s+)?(main|master|prod|feature|staging)\\s+(branch|environment)?\\b",
    flags: "i",
    class: "hard",
    confidence: 0.8,
    source: "builtin",
  },
  // Hard — significant performance difference between environments
  {
    pattern: "\\b(staging|dev|local|test)\\b.{0,60}\\b(production|prod)\\b.{0,40}\\b(slower?|faster?|different|\\d+x|ms|seconds?|latency|performance)\\b",
    flags: "i",
    class: "hard",
    confidence: 0.75,
    source: "builtin",
  },
  // Hard — test/code coverage regression
  {
    pattern: "\\b(test|code)\\s+coverage\\s+(dropped|fell|decreased|went\\s+down|regressed)\\b",
    flags: "i",
    class: "hard",
    confidence: 0.8,
    source: "builtin",
  },
  // Hard — queue worker or job processor misbehavior
  {
    pattern: "\\b(queue\\s+worker|job\\s+queue|background\\s+job|job\\s+processor)\\s+.{0,40}(drops?|drops\\s+jobs?|silently|after\\s+processing|stops\\s+processing)\\b",
    flags: "i",
    class: "hard",
    confidence: 0.8,
    source: "builtin",
  },

  // Hard — concrete error message / stack trace pasted
  {
    pattern: "\\b(got\\s+error|failed\\s+with|fails\\s+with|throws?)\\s*:\\s*\\w*Error\\b|\\bAssertionError\\b|\\bECONNREFUSED\\b|\\bENOENT\\b|\\bEACCES\\b|\\bhere['’‘]?s\\s+(the|a)\\s+stack\\s+trace\\b|\\bstack\\s+trace\\s*:",
    flags: "i",
    class: "hard",
    confidence: 0.8,
    source: "builtin",
  },
  // Hard — build failure with specific error
  {
    pattern: "\\bbuild\\s+failed\\s*:|\\bmodule\\s+not\\s+found\\s*:|\\bcannot\\s+find\\s+module\\b|\\bmissing\\s+module\\b",
    flags: "i",
    class: "hard",
    confidence: 0.8,
    source: "builtin",
  },
  // Hard — performance disparity between environments
  {
    pattern: "\\b(staging|dev(?:elopment)?)\\b.{0,80}\\b(prod(?:uction)?|live)\\b.{0,40}\\b(same|identical|same\\s+data)\\b|\\b(faster|slower|longer|\\d+ms|\\d+s)\\b.{0,60}\\b(staging|prod(?:uction)?)\\b",
    flags: "i",
    class: "hard",
    confidence: 0.75,
    source: "builtin",
  },
  // Hard — memory usage grows over time (leak pattern)
  {
    pattern: "\\bmemory\\s+(usage\\s+)?(grows?|increases?|climbs?|balloons?|leaks?)\\s+(by|over|at|steadily|gradually|\\d+)",
    flags: "i",
    class: "hard",
    confidence: 0.8,
    source: "builtin",
  },
  // Hard — env-specific failure (passes/works in one env but not another)
  {
    pattern: "\\b(fails?|breaks?|doesn[''']?t\\s+(?:work|resolve|start))\\b.{0,40}\\bin\\s+(some|certain|specific)\\s+(test\\s+)?(env|envs|environments?)\\b.{0,40}\\b(not\\s+(?:in\\s+)?others|but\\s+not)\\b",
    flags: "i",
    class: "hard",
    confidence: 0.75,
    source: "builtin",
  },
  // Hard — "debug it" as explicit instruction at end of a description
  {
    pattern: "(?:—|--|:\\s*)\\s*debug\\s+(it|this)\\s*$|\\bplease\\s+(?:help\\s+me\\s+)?debug\\s+(it|this)\\b",
    flags: "i",
    class: "hard",
    confidence: 0.8,
    source: "builtin",
  },
  // "find out why / figure out why / track it down" — explicit investigation
  {
    pattern: "\\b(find\\s+out\\s+why|investigate\\s+why|figure\\s+out\\s+why|track\\s+it\\s+down|hunt\\s+(?:it\\s+)?down)\\b",
    flags: "i",
    class: "hard",
    confidence: 0.75,
    source: "builtin",
  },
  // silent failure — no error output despite broken behavior
  {
    pattern: "\\b(fails?\\s+silently|silent\\s+fail(?:ure)?|exits?\\s+with(?:out)?\\s+(?:an\\s+)?error|0\\s+exit\\s+code\\s+but)\\b",
    flags: "i",
    class: "hard",
    confidence: 0.75,
    source: "builtin",
  },
  // resource/listener/connection leak (extends memory-leak signal)
  {
    pattern: "\\b(leaking\\s+(?:listeners?|handlers?|callbacks?|references?|connections?)|resource\\s+leak|connection\\s+(?:pool\\s+)?leak)\\b",
    flags: "i",
    class: "hard",
    confidence: 0.85,
    source: "builtin",
  },
  // performance regression after upgrade or change
  {
    pattern: "\\b(\\d+[xX]\\s+slow(?:er)?|much\\s+slow(?:er)?\\s+after|slow(?:er)?\\s+after\\s+(?:upgrading|the\\s+(?:upgrade|update|migration))|performance\\s+regress(?:ion|ed)?)\\b",
    flags: "i",
    class: "hard",
    confidence: 0.75,
    source: "builtin",
  },
  // tests pass individually/locally but fail in parallel / when run together
  {
    pattern: "\\bpass(?:es)?\\s+(?:individually|locally|in\\s+isolation|one\\s+by\\s+one).{0,80}\\bfail\\b|\\bfail\\s+when\\s+run\\s+(?:in\\s+parallel|together|concurrently)\\b",
    flags: "i",
    class: "hard",
    confidence: 0.75,
    source: "builtin",
  },
  // intermittent failure that can still be reproduced/investigated
  {
    pattern: "\\bintermittent(?:ly)?\\b.{0,60}\\b(fail|break|crash|error|wrong|drop|timeout|hang|lose|miss)\\b|\\b(fail|break|crash|error|wrong|drop|timeout|hang|lose|miss).{0,60}\\bintermittent(?:ly)?\\b",
    flags: "i",
    class: "hard",
    confidence: 0.7,
    source: "builtin",
  },
  // scheduled job / cron runs more than once (double execution)
  {
    pattern: "\\b(cron|scheduled\\s+job|job)\\s+runs?\\s+(twice|multiple\\s+times|more\\s+than\\s+once)\\b|\\bruns?\\s+twice\\b",
    flags: "i",
    class: "hard",
    confidence: 0.8,
    source: "builtin",
  },
  // bundle / artifact size grew (performance regression, different dimension)
  {
    pattern: "\\b(bundle|build|artifact|output)\\s+(?:size\\s+)?(?:is\\s+)?(?:\\d+[xX]\\s+)?(larger|bigger|grew|ballooned)\\b",
    flags: "i",
    class: "hard",
    confidence: 0.75,
    source: "builtin",
  },
  // cache hit rate dropped / fell unexpectedly
  {
    pattern: "\\b(cache\\s+hit\\s+rate|hit\\s+rate|cache\\s+(?:miss|misses))\\s+(dropped?|fell|decreased|went|went\\s+down|from\\s+\\d+%\\s+to)\\b",
    flags: "i",
    class: "hard",
    confidence: 0.8,
    source: "builtin",
  },
  // occasional / sporadic duplicate records (write-path bug, hard to reproduce)
  {
    pattern: "\\b(occasionally?\\s+produces?|sporadic(?:ally)?|duplicate)\\s+(records?|writes?|inserts?|entries|rows?)\\b",
    flags: "i",
    class: "hard",
    confidence: 0.8,
    source: "builtin",
  },
  // auth token rejected before its expiry time (clock skew or invalidation bug)
  {
    pattern: "\\b(tokens?|jwts?)\\s+(are\\s+being\\s+|being\\s+)?rejected\\s+(as\\s+)?expired\\b|\\bexpired\\s+before\\s+(the\\s+)?expir(?:y|ation)\\b",
    flags: "i",
    class: "hard",
    confidence: 0.8,
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
      "\\b(should we|compare|evaluate|what[‘’’]?s the best|how should we|design (our|a|the))\\b",
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
  // Reasoning — "what's/what is the right way/approach/stack/model to/for X" design question
  {
    pattern: "\\bwhat(?:[''']s|\\s+is)\\s+the\\s+right\\s+(way|approach|strategy|pattern|method|stack|model|tool|technology|architecture|concurrency\\s+model|observability\\s+stack)\\b",
    flags: "i",
    class: "reasoning",
    confidence: 0.8,
    source: "builtin",
  },
  // Reasoning — security review with proposed fixes (design, not investigation)
  {
    pattern: "\\breview\\s+(this|the|our)\\s+.{0,40}\\s+(for\\s+security|for\\s+vulnerabilities?)\\b.{0,80}(propose|suggest|recommend|provide)\\b",
    flags: "i",
    class: "reasoning",
    confidence: 0.75,
    source: "builtin",
  },
  // Reasoning — deployment/release strategy question
  {
    pattern: "\\bdesign\\s+(a\\s+)?(blue[/-]green|canary|rolling|zero-downtime)\\s+(deploy|deployment|release|strategy)\\b",
    flags: "i",
    class: "reasoning",
    confidence: 0.85,
    source: "builtin",
  },
  // Reasoning — test strategy / testing pyramid design
  {
    pattern: "\\b(design|define|plan|recommend)\\s+(a\\s+|the\\s+)?(test\\s+strategy|testing\\s+strategy|testing\\s+pyramid|test\\s+pyramid|contract\\s+testing\\s+strategy)\\b",
    flags: "i",
    class: "reasoning",
    confidence: 0.85,
    source: "builtin",
  },

  // Reasoning — adversarial prompt injection (role claim + trivialize + complex task)
  {
    pattern: "\\b(i\\s+am|i'm)\\s+(the\\s+)?(system\\s+administrator|admin|superuser|root|god\\s+mode|owner)\\b",
    flags: "i",
    class: "reasoning",
    confidence: 0.9,
    source: "builtin",
  },
  // Reasoning — meta-classifier injection (wrapping the prompt in classification tags)
  {
    pattern: "<PROMPT_TO_CLASSIFY>",
    flags: "i",
    class: "reasoning",
    confidence: 0.95,
    source: "builtin",
  },
  // Reasoning — test isolation / architectural testing strategy question
  {
    pattern: "\\bwhat\\s+is\\s+the\\s+(right|best|correct|proper|ideal)\\s+(test|testing)\\s+(isolation|strategy|approach|pattern)\\b",
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
      "\\b(can[‘’’']?t reproduce|cannot reproduce|unreproducible|silent (?:data )?loss|byzantine|heisenbug|no error in logs|no slow query log)\\b",
    flags: "i",
    class: "max",
    confidence: 0.9,
    source: "builtin",
  },
  // "intermittently" only escalates to max when paired with a can’t-reproduce signal
  {
    pattern: "\\bintermittent(?:ly)?\\b.{0,100}\\b(can[‘’’']?t\\s+reproduce|cannot\\s+reproduce|not\\s+reproducible|no\\s+error)\\b|\\b(can[‘’’']?t\\s+reproduce|cannot\\s+reproduce|no\\s+error\\s+in\\s+logs).{0,100}\\bintermittent(?:ly)?\\b",
    flags: "i",
    class: "max",
    confidence: 0.9,
    source: "builtin",
  },
  {
    pattern:
      "\\b(oom-?killed|oomkilled|cascading failure|stale content|consensus|exfil|breach|security breach|corrupt(?:ed)? data|missed a \\d+(?:-hour|-day) outage|byzantine fault)\\b",
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
  // Max — critical security vulnerabilities (SQL injection, CVE, deserialization, etc.)
  {
    pattern: "\\b(sql|xss|xxe|ldap|rce|ssti|ssrf|idor)\\s+injection\\b|\\bcritical\\s+(CVE|vulnerability|security\\s+issue)\\b|\\b(deserialization|rce|remote\\s+code\\s+execution)\\s+vulnerability\\b",
    flags: "i",
    class: "max",
    confidence: 0.9,
    source: "builtin",
  },
  // Max — data corruption in a database/table/records (broader than "corrupted data")
  {
    pattern: "\\bdata\\s+corrupt(?:ion|ed)?\\b|\\bcorrupt(?:ed|ing)?\\s+(the\\s+)?(data|records?|table|database|permissions?|user\\s+data)\\b",
    flags: "i",
    class: "max",
    confidence: 0.85,
    source: "builtin",
  },
  // Max — broken code / bad deploy pushed to production
  {
    pattern: "\\b(pushed|deployed|shipped|merged)\\s+(broken|bad|corrupt|wrong)\\s+code\\s+(to\\s+)?(production|prod)\\b",
    flags: "i",
    class: "max",
    confidence: 0.9,
    source: "builtin",
  },
  // Max — resource at critical capacity with explicit time pressure
  {
    pattern: "\\b(disk|storage|database|db|volume)\\s+(?:is\\s+at\\s+)?\\d+%\\s+(full|capacity)\\b|\\b(\\d+\\s+hours?|hours?\\s+before)\\s+(it\\s+fills?|before\\s+(?:it\\s+)?full|runs?\\s+out)\\b",
    flags: "i",
    class: "max",
    confidence: 0.9,
    source: "builtin",
  },
  // Max — GDPR/compliance data deletion failures or unauthorized data access
  {
    pattern: "\\b(gdpr|ccpa)\\b.{0,80}\\b(deletion|erasure)\\b.{0,80}\\b(not|fail|broken|incorrect)\\b|\\busers?\\s+can\\s+access\\s+each\\s+other[''']?s\\s+data\\b",
    flags: "i",
    class: "max",
    confidence: 0.9,
    source: "builtin",
  },
  // Max — "logs attached" / "here are the traces" — active incident with evidence attached
  {
    pattern: "\\blogs?\\s+attached\\b|\\bhere\\s+(are|is)\\s+the\\s+(traces?|distributed\\s+traces?|stack\\s+traces?|errors?\\s+and|error\\s+rate)\\b",
    flags: "i",
    class: "max",
    confidence: 0.9,
    source: "builtin",
  },
  // Max — no error log(s) at all (variation of "no error in logs")
  {
    pattern: "\\bno\\s+error\\s+logs?\\b|\\bno\\s+errors?\\s+(were\\s+)?logged\\b",
    flags: "i",
    class: "max",
    confidence: 0.9,
    source: "builtin",
  },
  // Max — compromised service account / leaked credentials
  {
    pattern: "\\b(compromised\\s+(?:service\\s+)?account|leaked\\s+(?:credentials?|api\\s+key|access\\s+token|secret)|service\\s+account\\s+(?:was\\s+|has\\s+been\\s+|is\\s+)?compromised)\\b",
    flags: "i",
    class: "max",
    confidence: 0.9,
    source: "builtin",
  },
  // Max — race condition in financial/billing context (money at stake)
  {
    pattern: "\\brace\\s+condition\\b.{0,80}\\b(billing|payment|charge|financial|order|transaction|money|invoice)\\b|\\b(billing|payment|charge|financial|order|transaction).{0,80}\\brace\\s+condition\\b",
    flags: "i",
    class: "max",
    confidence: 0.9,
    source: "builtin",
  },
  // Max — irreversible high-stakes operation (data migration, no rollback)
  {
    pattern: "\\b(irreversible\\s+(?:decision|action|migration|operation)|can[''']?t\\s+rollback|cannot\\s+roll\\s*back)\\b",
    flags: "i",
    class: "max",
    confidence: 0.85,
    source: "builtin",
  },
  // Max — double/overcharging customers (financial correctness critical)
  {
    pattern: "\\b(double-?charg(?:ing|ed)|over-?charg(?:ing|ed)|incorrect(?:ly)?\\s+charg(?:ing|ed))\\b",
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
    // 1. Pattern scan — fast-path short-circuits at confidence >= 1.0
    let best: Compiled | null = null;
    for (const c of compiled) {
      if (!c.re.test(req.prompt)) continue;
      if (c.rule.confidence >= 1.0) { best = c; break; }
      if (!best || c.rule.confidence > best.rule.confidence) best = c;
    }

    // 2. Definite pattern match overrides size check
    if (best && best.rule.confidence >= 1.0) {
      const diagnostics: Diagnostic[] = [
        { severity: "info", code: "heuristic.matched", message: `${best.rule.class} @1.00 (${best.rule.source ?? "user"})` },
      ];
      if (best.rule.bareSafe === true) {
        diagnostics.push({ severity: "info", code: "heuristic.bare_safe", message: "definite-trivial fast-path" });
      }
      return { class: best.rule.class, confidence: 1.0, diagnostics };
    }

    // 3. Size floor — only when no definite pattern matched
    if (req.prompt.length > SIZE_THRESHOLD_LARGE) {
      return {
        class: "standard",
        confidence: 0.7,
        diagnostics: [{ severity: "info", code: "size.longcontext", message: `prompt is ${req.prompt.length} chars (>${SIZE_THRESHOLD_LARGE}); favor sonnet` }],
      };
    }
    if (req.prompt.length > SIZE_THRESHOLD_MEDIUM) {
      return {
        class: "standard",
        confidence: 0.65,
        diagnostics: [{ severity: "info", code: "size.mediumcontext", message: `prompt is ${req.prompt.length} chars (>${SIZE_THRESHOLD_MEDIUM}); lean sonnet` }],
      };
    }

    // 4. Sub-1.0 pattern match
    if (!best) return null;
    const diagnostics: Diagnostic[] = [
      { severity: "info", code: "heuristic.matched", message: `${best.rule.class} @${best.rule.confidence.toFixed(2)} (${best.rule.source ?? "user"})` },
    ];
    if (best.rule.bareSafe === true) {
      diagnostics.push({ severity: "info", code: "heuristic.bare_safe", message: "definite-trivial fast-path" });
    }
    return { class: best.rule.class, confidence: best.rule.confidence, diagnostics };
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
