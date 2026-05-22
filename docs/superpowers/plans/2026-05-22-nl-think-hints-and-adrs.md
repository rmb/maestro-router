# Natural-language think hints & ADRs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `override.ts` so natural-language phrases like "think hard" / "think step by step" route to `max` (Opus) at confidence 1.0, and write ADR-0005 and ADR-0007 documenting this decision and the already-shipped per-tool model switching.

**Architecture:** A second regex `NATURAL_THINK_RE` is added alongside the existing `OVERRIDE_RE` in `override.ts`. Both run in the same `classify` function; natural-language hits emit diagnostic code `override.nl_think` and return `class: "max"`. `stripOverride` is unchanged — natural phrases stay in the forwarded prompt. Two ADR docs are written: 0005 covers this classifier change, 0007 documents the as-built per-tool switching via sdk-proxy + tool-override.

**Tech Stack:** TypeScript (ESM strict), Vitest, no new deps.

---

## File map

| Action | Path | Responsibility |
|---|---|---|
| Modify | `src/classifiers/override.ts` | Add `NATURAL_THINK_RE`, extend `classify` |
| Modify | `src/classifiers/override.test.ts` | Tests for natural-language patterns |
| Create | `docs/adr/0005-nl-think-hints.md` | ADR: natural-language think hints decision |
| Create | `docs/adr/0007-per-tool-model-switching.md` | ADR: per-tool routing as-built in v0.3 |

---

## Task 1: Tests for natural-language think hints (TDD — write failing tests first)

**Files:**
- Modify: `src/classifiers/override.test.ts`

- [ ] **Step 1: Add a new describe block with failing tests**

Open `src/classifiers/override.test.ts`. After the closing `});` of the `describe("stripOverride", ...)` block, append:

```typescript
describe("natural-language think hints", () => {
  test("'think hard' → max", async () => {
    expect(await call("think hard if there is a way")).toMatchObject({
      class: "max",
      confidence: 1.0,
    });
  });

  test("'think harder' → max", async () => {
    expect(await call("think harder about this")).toMatchObject({ class: "max" });
  });

  test("'think deeply' → max", async () => {
    expect(await call("think deeply about the design")).toMatchObject({ class: "max" });
  });

  test("'think deep' → max", async () => {
    expect(await call("think deep on this")).toMatchObject({ class: "max" });
  });

  test("'think carefully' → max", async () => {
    expect(await call("think carefully before answering")).toMatchObject({ class: "max" });
  });

  test("'think more carefully' → max", async () => {
    expect(await call("please think more carefully")).toMatchObject({ class: "max" });
  });

  test("'think step by step' → max", async () => {
    expect(await call("think step by step through this problem")).toMatchObject({ class: "max" });
  });

  test("'think step-by-step' → max", async () => {
    expect(await call("think step-by-step please")).toMatchObject({ class: "max" });
  });

  test("case insensitive", async () => {
    expect(await call("THINK HARD")).toMatchObject({ class: "max" });
    expect(await call("Think Deeply")).toMatchObject({ class: "max" });
  });

  test("emits override.nl_think diagnostic", async () => {
    const result = await call("think hard about this");
    const codes = result!.diagnostics!.map((d) => d.code);
    expect(codes).toContain("override.nl_think");
  });

  test("'I think' does NOT match", async () => {
    expect(await call("I think this is fine")).toBeNull();
  });

  test("'rethink' does NOT match", async () => {
    expect(await call("rethink the approach")).toBeNull();
  });

  test("'overthink' does NOT match", async () => {
    expect(await call("don't overthink it")).toBeNull();
  });

  test("'think' alone does NOT match", async () => {
    expect(await call("think")).toBeNull();
  });

  test("natural hint does not block existing @-hint", async () => {
    // @fast wins — override.ts checks @-hints first
    expect(await call("@fast think hard")).toMatchObject({ class: "trivial" });
  });
});
```

- [ ] **Step 2: Run the new tests to confirm they all fail**

```bash
cd /Users/rui.barreira/Desktop/CLAUDE_SANDBOX_DO_NOT_DELETE/personal/Maestro
pnpm test src/classifiers/override.test.ts 2>&1 | tail -30
```

Expected: 15 failures in the `natural-language think hints` suite. All others should still pass.

- [ ] **Step 3: Commit the failing tests**

```bash
git add src/classifiers/override.test.ts
git commit -m "test(override): add failing tests for natural-language think hints"
```

---

## Task 2: Implement natural-language think hints in override.ts

**Files:**
- Modify: `src/classifiers/override.ts`

- [ ] **Step 1: Add `NATURAL_THINK_RE` constant after `OVERRIDE_RE`**

In `src/classifiers/override.ts`, after line 11 (the `OVERRIDE_RE` declaration), add:

```typescript
/**
 * Natural-language equivalents of @think/@deep. Requires an intensity
 * modifier so "I think", "rethink", "overthink" are excluded.
 */
const NATURAL_THINK_RE =
  /\bthink\s+(hard|harder|deeply|deep|carefully|more\s+carefully|step[\s-]+by[\s-]+step)\b/i;
```

- [ ] **Step 2: Extend `classify` to check `NATURAL_THINK_RE`**

Replace the existing `classify` function body (lines 25–43 in the current file) with:

```typescript
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
```

- [ ] **Step 3: Run the full override test suite**

```bash
pnpm test src/classifiers/override.test.ts 2>&1 | tail -20
```

Expected: all tests pass, 0 failures.

- [ ] **Step 4: Run typecheck and lint**

```bash
pnpm typecheck 2>&1 && pnpm lint 2>&1
```

Expected: `$ tsc --noEmit` with no output, `ESLint: No issues found`.

- [ ] **Step 5: Run the full test suite to check for regressions**

```bash
pnpm test 2>&1 | tail -20
```

Expected: all suites pass.

- [ ] **Step 6: Commit**

```bash
git add src/classifiers/override.ts
git commit -m "classifier: natural-language think hints route to max (override.ts)"
```

---

## Task 3: Write ADR-0005 — natural-language think hints

**Files:**
- Create: `docs/adr/0005-nl-think-hints.md`

- [ ] **Step 1: Create the ADR file**

```bash
cat > /Users/rui.barreira/Desktop/CLAUDE_SANDBOX_DO_NOT_DELETE/personal/Maestro/docs/adr/0005-nl-think-hints.md << 'ADRDOC'
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
ADRDOC
```

- [ ] **Step 2: Commit**

```bash
git add docs/adr/0005-nl-think-hints.md
git commit -m "docs: ADR-0005 natural-language think hints in override classifier"
```

---

## Task 4: Write ADR-0007 — per-tool model switching (as-built)

**Files:**
- Create: `docs/adr/0007-per-tool-model-switching.md`

- [ ] **Step 1: Create the ADR file**

```bash
cat > /Users/rui.barreira/Desktop/CLAUDE_SANDBOX_DO_NOT_DELETE/personal/Maestro/docs/adr/0007-per-tool-model-switching.md << 'ADRDOC'
# ADR-0007 · Per-tool model switching during multi-step execution

## Status

Accepted · 2026-05-22

## Context

When Maestro spawns `claude --print`, the model is locked for the full invocation.
All tool calls (Edit, Bash, Read, Write, …) that Claude makes internally run on the
same model that was selected at turn start. A `Read` call on Opus pays Opus prices;
a multi-file architectural judgement on Haiku gets the wrong model. The per-turn
routing captures the dominant cost signal but cannot optimise within a single turn.

The question surfaced in a session review: "Is there a way to change models during a
multi-layer execution?"

## Constraint

`claude --print` owns the tool-execution loop internally. A CLI wrapper has no hook
between tool calls. The only interception point is the stream-json SDK protocol used
by the VS Code extension, where each `tool_result` is a distinct frame on stdin.

## Decision

Implement per-tool model switching via the existing stream-json SDK proxy path
(`claudeProcessWrapper`). Three components ship together:

### 1. `src/classifiers/tool-override.ts`

A classifier that maps tool names to routing classes at confidence 1.0:

| Tool | Class | Rationale |
|---|---|---|
| Read, Glob, Grep, LS | trivial | Pure reads; no generation |
| Edit, Write, MultiEdit, NotebookEdit, Bash | simple | Structured writes / shell execs |
| Task, WebFetch, WebSearch | standard | May require multi-step reasoning |

Unknown tools return `null` (pipeline falls through to other classifiers).

### 2. `src/wrapper/sdk-proxy.ts` (per-tool routing extension)

On every assistant stdout frame, the proxy records `tool_use_id → tool_name` in a
bounded map (cap 50, oldest-first eviction). On every `tool_result` stdin frame,
it resolves the tool name, injects it as `metadata.resolvedToolName` into the
`Request`, and routes via the full pipeline. `tool-override` fires at conf=1.0 for
known tools. The selected model is injected via `set_model` before the frame is
forwarded to Claude.

### 3. `src/cli/wire-compat.ts`

`toolOverrideClassifier` inserted into the pipeline so it runs on every turn,
including `tool_result` turns.

## Why not `claude --print`?

`--print` mode does not expose individual tool calls as re-routable turns. Supporting
per-tool switching in `--print` mode would require forking the Claude CLI or parsing
its internal output format — both out of scope. The SDK proxy path is the correct
integration layer.

## Consequences

- Tool-result turns in SDK/VS Code mode are routed cheaply: `Read` drops to Haiku,
  `Edit` to Sonnet, complex tool calls stay on Sonnet.
- `--print` mode (non-SDK) is unchanged; model is still locked per turn.
- The `TOOL_CLASS` routing table is static. Per-project overrides (C12) are deferred
  to a future iteration; the table covers the common case.
- `tool-override` runs before heuristic/LLM classifiers — zero per-call cost for
  known tools.

## Deferred

Per-project `TOOL_CLASS` overrides via `.maestro/config.json` (C12) — deferred.
Requires `maestro stats` evidence that per-tool savings justify the config surface.
ADRDOC
```

- [ ] **Step 2: Commit**

```bash
git add docs/adr/0007-per-tool-model-switching.md
git commit -m "docs: ADR-0007 per-tool model switching via sdk-proxy (as-built v0.3)"
```

---

## Verification

- [ ] **Final check: all tests green, typecheck and lint clean**

```bash
pnpm typecheck 2>&1 && pnpm lint 2>&1 && pnpm test 2>&1 | tail -10
```

Expected:
```
$ tsc --noEmit
ESLint: No issues found
...
Test Files  N passed
Tests       N passed
```
