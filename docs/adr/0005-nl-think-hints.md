# ADR-0005 · Natural-language think hints in override classifier

## Status

Accepted · 2026-05-22

## Context

The override classifier recognises `@`-prefixed model hints (`@think`, `@deep`,
`@opus`, `@fast`, …) and short-circuits the pipeline at confidence 1.0. These hints
require the user to prefix their prompt with a sigil.

Users also write natural-language phrases that carry identical intent:

- "think hard if there is a way…"
- "think step by step through this"
- "think deeply about the design"

Without this ADR, those phrases escape `override.ts` entirely and reach the heuristic
or LLM stages, which may or may not upgrade the model. The user's intent is
unambiguous — they are asking for maximum deliberation — but Maestro ignores the signal.

## Decision

Add `NATURAL_THINK_RE` to `override.ts`:

```ts
const NATURAL_THINK_RE =
  /\bthink\s+(hard|harder|deeply|deep|carefully|more\s+carefully|step[\s-]+by[\s-]+step)\b/i;
```

- **Class:** `max` (Opus) — not `reasoning` (Sonnet+extended-thinking). "Think hard"
  is a stronger signal than `@think`; the user wants the best answer, not just more
  thinking time on a cheaper model.
- **Confidence:** 1.0 — same as `@`-prefixed hints. Short-circuits the pipeline.
- **Diagnostic code:** `override.nl_think` — distinguishes natural-language detections
  from `@hint` detections in telemetry.
- **`stripOverride` unchanged** — natural phrases are part of the user's sentence and
  must not be stripped before forwarding to Claude.
- **`@`-hints checked first** — `@fast think hard` stays `trivial` because the
  `@fast` match fires before the natural-language check.

## False-positive mitigation

The regex requires an intensity modifier immediately after `think`. The following
do not match: "I think", "rethink", "overthink", bare "think".

## Consequences

- Natural-language think signals route correctly without requiring the user to
  learn `@`-prefix syntax.
- Any phrase matching the regex pays Opus pricing. Acceptable: the user explicitly
  stated they want deep reasoning.
- Pattern coverage is intentionally narrow. Broader phrases ("consider carefully",
  "reason through") are left to the heuristic/LLM stages rather than hard-coding
  more patterns here, keeping the override classifier as a place for unambiguous
  explicit signals only.
