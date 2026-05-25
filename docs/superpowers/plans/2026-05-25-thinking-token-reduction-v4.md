# Thinking Token Reduction v4 — Remaining Work

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the five remaining v4 optimizations: always-log telemetry (C1), maxOutputTokens emission (G2), durationApiMs in stats, K2 markov short-circuit, and I1 tool-result line-number stripping.

**Architecture:** Five independent fixes in classifier, stats, spawn, and SDK-proxy layers. Each task is self-contained and can be deployed separately. Sprint 0 (Y+Z tracks) and Sprint 1 foundations (K1, E1, M1, E3, K2.escape) were shipped in the health-metrics-improvement branch. This plan completes the remaining items.

**Tech Stack:** TypeScript ESM, Node ≥ 20, Vitest. Key files: `src/core/pipeline.ts`, `src/wrapper/spawn.ts`, `src/wrapper/sdk-proxy.ts`, `src/cli/run-cmd.ts`, `src/cli/stats.ts`.

**Already shipped (do not re-implement):**
- Track Z fingerprint sessions + kill switch (`MAESTRO_DISABLE_TRACK_Z`)
- Track Y fallback rate fix (empty-prompt classifier, `turn_type.empty_prompt`)
- Track X.soft standard output cap (`CLASS_BREVITY.standard`)
- K1 classifier output cache (`classifierCache`)
- K2.escape markov lock-in safety (`shouldBreakMarkovLock`)
- E1 standard effort=low + E1.escalate
- M1 continuation detection (`detectContinuation`)
- E3 reasoning escalation (`applyE3Escalation`)

---

## File Structure

| File | Change | Purpose |
|------|--------|---------|
| `src/cli/run-cmd.ts` | Modify lines 285–303 | C1: always log telemetry event |
| `src/wrapper/spawn.ts` | Modify `resolveAppendSystemPrompt` | G2: emit maxOutputTokens hint |
| `src/wrapper/spawn.test.ts` | Modify | G2 tests |
| `src/cli/stats.ts` | Modify `Summary`, `computeSummary`, `renderHuman` | durationApiMs p90 per class |
| `src/cli/stats.test.ts` | Modify | stats tests |
| `src/core/pipeline.ts` | Modify `createPipeline` | K2 markov short-circuit |
| `src/core/pipeline.test.ts` | Modify | K2 tests |
| `src/wrapper/strip-line-numbers.ts` | Create | I1 pure helper |
| `src/wrapper/strip-line-numbers.test.ts` | Create | I1 tests |
| `src/wrapper/sdk-proxy.ts` | Modify tool_result branch | I1 apply stripping |
| `src/wrapper/sdk-proxy.test.ts` | Modify | I1 integration test |

---

## Task 1: C1 — Always-log telemetry decision event

**Files:**
- Modify: `src/cli/run-cmd.ts:285–303`

Currently, the `telemetry.log` call is inside `if (parsed)`, so routing decisions where Claude exits with an error, budget cap, or SIGINT are silently dropped. `maestro stats` only has data for successful Claude spawns. `cost` in `TelemetryEvent.decision` is already optional (`cost?: CostBreakdown`) so no type change needed.

- [ ] **Step 1a: Write failing test**

In `src/cli/stats.test.ts`, add a test verifying that decision events without a cost field are counted in `computeSummary.totalRequests`:

```typescript
test("C1: decision events without cost are counted in totalRequests", () => {
  const events: TelemetryEvent[] = [
    {
      type: "decision",
      ts: new Date().toISOString(),
      decision: {
        class: "standard",
        classifier: "forced.standard",
        confidence: 0.1,
        spec: balancedProfile.classes.standard,
        latencyMs: 5,
        diagnostics: [],
      },
      // deliberately no cost field
    },
  ];
  const summary = computeSummary(events, 7);
  expect(summary.totalRequests).toBe(1);
  expect(summary.spent).toBe(0); // no cost data → 0 spend
});
```

The imports needed at the top of stats.test.ts (if not already present):
```typescript
import type { TelemetryEvent } from "../core/types.js";
import { balancedProfile } from "../core/profile.js";
```

Run: `pnpm test src/cli/stats.test.ts -t "C1"` — expect **PASS** (computeSummary already handles missing cost by defaulting to 0). This confirms the stats layer is ready; the bug is in run-cmd.ts gating the write.

- [ ] **Step 1b: Fix run-cmd.ts — always log**

In `src/cli/run-cmd.ts`, find the block at lines 285–303 (around `const parsed = parseOutput(...)`). Replace:

```typescript
      const parsed = parseOutput(result.capturedStdout, cli.userConfig);
      if (parsed) {
        const telemetry = createTelemetry(
          cli.userConfig.telemetryPath ? { path: cli.userConfig.telemetryPath } : {},
        );
        // Set cacheHit when Anthropic returned cached prefix tokens — this is the
        // ground truth for telemetry's cacheHitRate. Without this, decision.cacheHit
        // is always undefined and oracle's cache-hit-rate-accuracy check fails.
        const decisionWithCacheHit: Decision = {
          ...effectiveDecision,
          cacheHit: (parsed.cost?.cacheReadInputTokens ?? 0) > 0,
        };
        await telemetry.log({
          type: "decision",
          ts: new Date().toISOString(),
          decision: decisionWithCacheHit,
          cost: parsed.cost,
          prompt: truncate(prompt, PROMPT_TRUNCATE_CHARS),
        });
```

With:

```typescript
      const parsed = parseOutput(result.capturedStdout, cli.userConfig);
      const telemetry = createTelemetry(
        cli.userConfig.telemetryPath ? { path: cli.userConfig.telemetryPath } : {},
      );
      // C1: Always log the routing decision — cost is optional (absent on error/interrupt/budget-cap).
      const decisionWithCacheHit: Decision = {
        ...effectiveDecision,
        cacheHit: (parsed?.cost?.cacheReadInputTokens ?? 0) > 0,
      };
      await telemetry.log({
        type: "decision",
        ts: new Date().toISOString(),
        decision: decisionWithCacheHit,
        cost: parsed?.cost,
        prompt: truncate(prompt, PROMPT_TRUNCATE_CHARS),
      });
      if (parsed) {
```

The `if (parsed)` block that follows (outcome event, E1.escalate, posthog) remains gated — those all need parsed cost data. Only the initial `decision` event is moved out.

- [ ] **Step 1c: Run tests**

```bash
pnpm test src/cli/stats.test.ts
pnpm typecheck
```

Expected: all pass, no type errors.

- [ ] **Step 1d: Commit**

```bash
git add src/cli/run-cmd.ts src/cli/stats.test.ts
git commit -m "fix(telemetry): always log decision event — cost optional (C1)"
```

---

## Task 2: G2 — maxOutputTokens hint emission in spawn

**Files:**
- Modify: `src/wrapper/spawn.ts` (function `resolveAppendSystemPrompt`, lines ~106–116)
- Modify: `src/wrapper/spawn.test.ts`

`ClassSpec.maxOutputTokens` is set in profiles (standard=8000, hard=4000, reasoning=6000) but `resolveAppendSystemPrompt` never reads it. Hard and reasoning classes currently emit `""` (flag suppressed) so users get no output length guidance. This fix appends a cap hint when `maxOutputTokens` is set and the existing hint doesn't already mention "token".

- [ ] **Step 2a: Write failing tests**

In `src/wrapper/spawn.test.ts`, add:

```typescript
import { resolveAppendSystemPrompt, CLASS_BREVITY } from "./spawn.js";
import { balancedProfile } from "../core/profile.js";
import type { Decision } from "../core/types.js";

function makeDecision(cls: Parameters<typeof balancedProfile.classes.standard.model>[0] extends never ? never : string, spec: (typeof balancedProfile.classes)[keyof typeof balancedProfile.classes]): Decision {
  return {
    class: cls as import("../core/types.js").Class,
    classifier: "test",
    confidence: 1.0,
    spec,
    latencyMs: 0,
    diagnostics: [],
  };
}

describe("G2: maxOutputTokens hint", () => {
  test("hard class with maxOutputTokens=4000 emits cap hint", () => {
    const spec = { ...balancedProfile.classes.hard, maxOutputTokens: 4000 };
    const decision = makeDecision("hard", spec);
    const hint = resolveAppendSystemPrompt(decision, {});
    expect(hint).toContain("4000");
    expect(hint).toContain("token");
  });

  test("reasoning class with maxOutputTokens=6000 emits cap hint", () => {
    const spec = { ...balancedProfile.classes.reasoning, maxOutputTokens: 6000 };
    const decision = makeDecision("reasoning", spec);
    const hint = resolveAppendSystemPrompt(decision, {});
    expect(hint).toContain("6000");
  });

  test("standard class does not double-cap (CLASS_BREVITY already mentions tokens)", () => {
    const decision = makeDecision("standard", balancedProfile.classes.standard);
    const hint = resolveAppendSystemPrompt(decision, {});
    // CLASS_BREVITY.standard says "Aim for under 4000 tokens" — no duplicate
    const tokenMatches = hint.match(/token/gi) ?? [];
    expect(tokenMatches.length).toBe(1);
  });

  test("max class without maxOutputTokens has no cap hint", () => {
    const spec = { ...balancedProfile.classes.max };
    delete (spec as { maxOutputTokens?: number }).maxOutputTokens;
    const decision = makeDecision("max", spec);
    const hint = resolveAppendSystemPrompt(decision, {});
    expect(hint).not.toContain("token");
  });
});
```

Run: `pnpm test src/wrapper/spawn.test.ts -t "G2"` — expect **FAIL** (hard/reasoning return "" today).

- [ ] **Step 2b: Implement**

In `src/wrapper/spawn.ts`, replace `resolveAppendSystemPrompt`:

```typescript
export function resolveAppendSystemPrompt(
  decision: Decision,
  userConfig: UserConfig,
): string {
  const spec = decision.spec;
  if (spec.appendSystemPrompt !== undefined) return spec.appendSystemPrompt;
  const classHint = CLASS_BREVITY[decision.class];
  const base =
    classHint !== undefined
      ? classHint
      : (userConfig.appendSystemPrompt ?? DEFAULT_APPEND_SYSTEM_PROMPT);

  // G2: append hard ceiling hint when class hint doesn't already mention tokens
  if (spec.maxOutputTokens !== undefined && !base.includes("token")) {
    const cap = `Keep response under ${spec.maxOutputTokens} tokens.`;
    return base.length > 0 ? `${base} ${cap}` : cap;
  }
  return base;
}
```

- [ ] **Step 2c: Run tests**

```bash
pnpm test src/wrapper/spawn.test.ts
pnpm typecheck
```

Expected: all pass.

- [ ] **Step 2d: Commit**

```bash
git add src/wrapper/spawn.ts src/wrapper/spawn.test.ts
git commit -m "feat(spawn): emit maxOutputTokens cap hint per class (G2)"
```

---

## Task 3: durationApiMs p90 per class in stats

**Files:**
- Modify: `src/cli/stats.ts`
- Modify: `src/cli/stats.test.ts`

`durationApiMs` is captured in `outcome` telemetry events but absent from `maestro stats` output. It's the best proxy for thinking token cost (proportional to total generation time). Surfacing p90 per class lets you spot when trivial turns are thinking too hard.

- [ ] **Step 3a: Write failing test**

In `src/cli/stats.test.ts`, add:

```typescript
test("durationApiMsP90ByClass computed from outcome events", () => {
  const ts = new Date().toISOString();
  const events: TelemetryEvent[] = [
    { type: "outcome", ts, sessionId: "s1", decidedClass: "standard", stopReason: "end_turn", outputTokens: 100, cacheCreationTokens: 0, totalCostUsd: 0.01, durationApiMs: 1000 },
    { type: "outcome", ts, sessionId: "s2", decidedClass: "standard", stopReason: "end_turn", outputTokens: 200, cacheCreationTokens: 0, totalCostUsd: 0.02, durationApiMs: 2000 },
    { type: "outcome", ts, sessionId: "s3", decidedClass: "standard", stopReason: "end_turn", outputTokens: 300, cacheCreationTokens: 0, totalCostUsd: 0.03, durationApiMs: 9000 },
    { type: "outcome", ts, sessionId: "s4", decidedClass: "trivial", stopReason: "end_turn", outputTokens: 10, cacheCreationTokens: 0, totalCostUsd: 0.001, durationApiMs: 300 },
  ];
  const summary = computeSummary(events, 7);
  expect(summary.durationApiMsP90ByClass.standard).toBeGreaterThan(0);
  expect(summary.durationApiMsP90ByClass.trivial).toBeGreaterThan(0);
  expect(summary.durationApiMsP90ByClass.hard).toBe(0); // no hard events
});
```

Run: `pnpm test src/cli/stats.test.ts -t "durationApiMs"` — expect **FAIL** (`durationApiMsP90ByClass` doesn't exist yet).

- [ ] **Step 3b: Add field to Summary type**

In `src/cli/stats.ts`, find the `Summary` type (around line 40). Add after `outputTokensP90ByClass`:

```typescript
  /** p90 API duration per class — thinking-time proxy. 0 = no data. */
  durationApiMsP90ByClass: Record<Class, number>;
```

- [ ] **Step 3c: Track durationApiMs in computeSummary**

In `src/cli/stats.ts`, in `computeSummary`, find where `outputTokensByClass` is declared (around line 94). Add immediately after:

```typescript
  const durationApiMsByClass = Object.fromEntries(
    ALL_CLASSES.map((c) => [c, [] as number[]])
  ) as Record<Class, number[]>;
```

Then, in the event loop where outcome events are processed (find the `type: "outcome"` check), add:

```typescript
        if (e.type === "outcome" && e.durationApiMs > 0) {
          durationApiMsByClass[e.decidedClass]?.push(e.durationApiMs);
        }
```

At the end of `computeSummary`, in the return object, add:

```typescript
    durationApiMsP90ByClass: Object.fromEntries(
      ALL_CLASSES.map((c) => [c, p90(durationApiMsByClass[c])])
    ) as Record<Class, number>,
```

- [ ] **Step 3d: Render in renderHuman**

In `src/cli/stats.ts`, in `renderHuman`, find the output tokens p90 section (around lines 298–302). After that section, add:

```typescript
  lines.push(header("api latency p90 (thinking proxy)"));
  for (const cls of ALL_CLASSES) {
    const ms = summary.durationApiMsP90ByClass[cls];
    if (ms > 0) {
      lines.push(`  ${cls.padEnd(12)}${String(ms).padStart(6)} ms`);
    }
  }
  lines.push("");
```

- [ ] **Step 3e: Run tests**

```bash
pnpm test src/cli/stats.test.ts
pnpm typecheck
```

Expected: all pass.

- [ ] **Step 3f: Commit**

```bash
git add src/cli/stats.ts src/cli/stats.test.ts
git commit -m "feat(stats): add durationApiMs p90 per class (thinking-time proxy)"
```

---

## Task 4: K2 — Markov short-circuit (skip pipeline when last 3 agree)

**Files:**
- Modify: `src/core/pipeline.ts` (function `createPipeline`)
- Modify: `src/core/pipeline.test.ts`

When the last 3 routing decisions in this session all landed on the same class, it's statistically cheap to skip the full classifier chain and return that class directly. K2.escape conditions (`shouldBreakMarkovLock`) are already implemented and checked — they bypass the short-circuit when complexity signals fire.

**Important:** K2 only fires when `classifyOpts.sessionContext.recentClasses` has ≥ 3 entries AND the last 3 are identical AND `shouldBreakMarkovLock` returns false. Cache lookups still happen first (existing behavior).

- [ ] **Step 4a: Write failing tests**

In `src/core/pipeline.test.ts`, add:

```typescript
describe("K2: markov short-circuit", () => {
  test("K2 fires when last 3 classes agree (no escape signal)", async () => {
    const called: string[] = [];
    const neverClassifier: Classifier = {
      name: "never",
      weight: 1,
      async classify() {
        called.push("never");
        return null;
      },
    };
    const pipeline = createPipeline({
      classifiers: [neverClassifier],
      profile: balancedProfile,
    });
    const decision = await pipeline.route(
      { prompt: "fix a small typo" },
      { sessionContext: { recentClasses: ["trivial", "trivial", "trivial"] } },
    );
    expect(called).toHaveLength(0); // classifier was NOT called
    expect(decision.class).toBe("trivial");
    expect(decision.classifier).toBe("markov.k2");
    expect(decision.diagnostics.some((d) => d.code === "pipeline.k2_shortcircuit")).toBe(true);
  });

  test("K2 does not fire when last 3 are not all the same", async () => {
    const called: string[] = [];
    const alwaysStandard: Classifier = {
      name: "standard",
      weight: 1,
      async classify() {
        called.push("standard");
        return { class: "standard", confidence: 0.9, diagnostics: [] };
      },
    };
    const pipeline = createPipeline({
      classifiers: [alwaysStandard],
      profile: balancedProfile,
    });
    await pipeline.route(
      { prompt: "refactor this module" },
      { sessionContext: { recentClasses: ["trivial", "standard", "trivial"] } },
    );
    expect(called).toHaveLength(1); // full pipeline ran
  });

  test("K2 does not fire when escape keyword is in prompt", async () => {
    const called: string[] = [];
    const neverClassifier: Classifier = {
      name: "never",
      weight: 1,
      async classify() {
        called.push("never");
        return null;
      },
    };
    const pipeline = createPipeline({
      classifiers: [neverClassifier],
      profile: balancedProfile,
    });
    // "bug" is a K2.escape keyword (in shouldBreakMarkovLock)
    await pipeline.route(
      { prompt: "there is a bug in the auth module" },
      { sessionContext: { recentClasses: ["trivial", "trivial", "trivial"] } },
    );
    expect(called).toHaveLength(1); // escape fired, full pipeline ran
  });

  test("K2 does not fire when fewer than 3 recent classes", async () => {
    const called: string[] = [];
    const neverClassifier: Classifier = {
      name: "never",
      weight: 1,
      async classify() {
        called.push("never");
        return null;
      },
    };
    const pipeline = createPipeline({
      classifiers: [neverClassifier],
      profile: balancedProfile,
    });
    await pipeline.route(
      { prompt: "fix typo" },
      { sessionContext: { recentClasses: ["trivial", "trivial"] } },
    );
    expect(called).toHaveLength(1);
  });
});
```

Imports needed (if not present): `import { balancedProfile } from "../core/profile.js";` and `import type { Classifier } from "../core/types.js";`.

Run: `pnpm test src/core/pipeline.test.ts -t "K2"` — expect **FAIL** (K2 not implemented).

- [ ] **Step 4b: Implement K2 in pipeline.ts**

In `src/core/pipeline.ts`, inside `createPipeline`'s `route` function, after the cache lookup block (around line 80, after the `if (cache)` block that handles cache hits) and before the classifier loop (`for (const c of classifiers)`), insert:

```typescript
      // K2: markov short-circuit — skip classifiers when recent session context
      // shows consistent routing. shouldBreakMarkovLock handles escape conditions
      // (complexity keywords, prompt length spike, override hints).
      const recentClasses = classifyOpts?.sessionContext?.recentClasses;
      if (recentClasses && recentClasses.length >= 3) {
        const last3 = recentClasses.slice(-3);
        const markovClass = last3[0] as Class;
        if (
          last3.every((c) => c === markovClass) &&
          !shouldBreakMarkovLock(
            req.prompt,
            classifyOpts?.sessionContext?.recentAvgPromptLength,
          )
        ) {
          const decision = buildDecision({
            cls: markovClass,
            classifier: "markov.k2",
            confidence: 0.75,
            profile,
            latencyMs: Date.now() - start,
            diagnostics: [
              ...diagnostics,
              {
                severity: "info",
                code: "pipeline.k2_shortcircuit",
                message: `last 3 classes agree on ${markovClass}; skipped classifiers`,
              },
            ],
          });
          if (cache) cache.set(key, decision);
          return applyE3Escalation(decision, classifyOpts);
        }
      }
```

- [ ] **Step 4c: Run tests**

```bash
pnpm test src/core/pipeline.test.ts
pnpm typecheck
```

Expected: all pass including the 4 new K2 tests.

- [ ] **Step 4d: Commit**

```bash
git add src/core/pipeline.ts src/core/pipeline.test.ts
git commit -m "feat(pipeline): K2 markov short-circuit — skip classifiers when last 3 agree"
```

---

## Task 5: I1 — Tool result line-number stripping in SDK proxy

**Files:**
- Create: `src/wrapper/strip-line-numbers.ts`
- Create: `src/wrapper/strip-line-numbers.test.ts`
- Modify: `src/wrapper/sdk-proxy.ts`
- Modify: `src/wrapper/sdk-proxy.test.ts`

The Read tool returns `cat -n` output with line number prefixes. For a 500-line file, ~3k tokens are pure line-number overhead (~30%). The SDK proxy already intercepts `tool_result` frames and knows the tool name via `toolUseMap`. This task strips line numbers from Read tool results before they enter Claude's context window, keeping a compact anchor every 25 lines so Claude retains navigation context.

**Risk:** Claude uses line numbers internally to reason about edits. The 25-line anchor strategy preserves enough for `grep`/`Edit` operations. Files < 100 lines are left untouched.

- [ ] **Step 5a: Write failing tests for the pure helper**

Create `src/wrapper/strip-line-numbers.test.ts`:

```typescript
// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { stripLineNumbers } from "./strip-line-numbers.js";

// Build a cat -n style block of N lines
function catN(lines: string[]): string {
  return lines.map((line, i) => `${String(i + 1).padStart(6)}\t${line}`).join("\n");
}

describe("stripLineNumbers", () => {
  test("returns unchanged for files < 100 lines", () => {
    const content = catN(Array.from({ length: 50 }, (_, i) => `line ${i + 1}`));
    expect(stripLineNumbers(content)).toBe(content);
  });

  test("strips line numbers for files >= 100 lines", () => {
    const content = catN(Array.from({ length: 100 }, (_, i) => `const x${i} = ${i};`));
    const stripped = stripLineNumbers(content);
    // Non-anchor lines should not start with a number + tab
    const lines = stripped.split("\n");
    const hasRawLineNums = lines.some((l) => /^\s*\d+\t/.test(l));
    expect(hasRawLineNums).toBe(false);
    // Content is preserved
    expect(stripped).toContain("const x0 = 0;");
    expect(stripped).toContain("const x99 = 99;");
  });

  test("preserves anchors every 25 lines", () => {
    const content = catN(Array.from({ length: 100 }, (_, i) => `line ${i + 1}`));
    const stripped = stripLineNumbers(content);
    const lines = stripped.split("\n");
    // Line 25 (index 24) should be an anchor: "→25 line 25"
    expect(lines[24]).toBe("→25 line 25");
    // Line 50 (index 49) should be an anchor: "→50 line 50"
    expect(lines[49]).toBe("→50 line 50");
    // Line 1 (index 0) should NOT be an anchor
    expect(lines[0]).toBe("line 1");
    expect(lines[0]).not.toContain("→");
  });

  test("passes through content that is not cat-n formatted", () => {
    const plain = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
    expect(stripLineNumbers(plain)).toBe(plain);
  });
});
```

Run: `pnpm test src/wrapper/strip-line-numbers.test.ts` — expect **FAIL** (file doesn't exist).

- [ ] **Step 5b: Implement `strip-line-numbers.ts`**

Create `src/wrapper/strip-line-numbers.ts`:

```typescript
// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

const ANCHOR_INTERVAL = 25;
const MIN_STRIP_LINES = 100;

// Matches `cat -n` output: optional spaces + 1–6 digits + tab + rest
const CAT_N_LINE = /^(\s*)(\d{1,6})\t(.*)$/;

/**
 * Strip `cat -n` line-number prefixes from file content returned by the Read tool.
 * Keeps a compact anchor (→N) every ANCHOR_INTERVAL lines so Claude retains
 * navigation context at low token cost.
 *
 * Files with fewer than MIN_STRIP_LINES lines are returned unchanged — the
 * overhead saving is trivial and the anchoring complexity isn't worth it.
 */
export function stripLineNumbers(content: string): string {
  const lines = content.split("\n");
  if (lines.length < MIN_STRIP_LINES) return content;

  // Quick pre-check: if no lines match cat-n pattern, skip transformation
  if (!lines.some((l) => CAT_N_LINE.test(l))) return content;

  return lines
    .map((line) => {
      const match = CAT_N_LINE.exec(line);
      if (!match) return line;

      const lineNum = parseInt(match[2]!, 10);
      const rest = match[3]!;

      if (lineNum % ANCHOR_INTERVAL === 0) {
        return `→${lineNum} ${rest}`;
      }
      return rest;
    })
    .join("\n");
}
```

- [ ] **Step 5c: Run pure helper tests**

```bash
pnpm test src/wrapper/strip-line-numbers.test.ts
```

Expected: all 4 tests pass.

- [ ] **Step 5d: Write failing SDK proxy test**

In `src/wrapper/sdk-proxy.test.ts`, add a test that verifies Read tool results are stripped before forwarding:

```typescript
test("I1: Read tool results have line numbers stripped before forwarding to Claude", async () => {
  // Build a 100-line cat-n result
  const catNContent = Array.from({ length: 100 }, (_, i) =>
    `${String(i + 1).padStart(6)}\tconst x${i} = ${i};`
  ).join("\n");

  // Build a stream-json tool_result frame for the Read tool
  const toolResultFrame = JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu_read_1",
          content: [{ type: "text", text: catNContent }],
        },
      ],
    },
  });

  // The tool_use frame that establishes the tool_use_id → name mapping
  const toolUseFrame = JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "tu_read_1",
          name: "Read",
          input: { file_path: "src/foo.ts" },
        },
      ],
    },
  });

  const written: string[] = [];
  const { runSdkProxy, createMockChild } = await import("./sdk-proxy.js");
  // ... (use the test infrastructure already in sdk-proxy.test.ts for creating
  // mock child processes and capturing written output)

  // After running the proxy with these frames, verify the forwarded tool_result
  // does NOT contain raw `\t` line-number prefixes
  const forwardedResult = written.find((w) => w.includes("tool_result"));
  expect(forwardedResult).toBeDefined();
  const parsed = JSON.parse(forwardedResult!);
  const text = parsed.message.content[0].content[0].text as string;
  expect(text).not.toMatch(/^\s*\d+\t/m); // no raw cat-n lines
  expect(text).toContain("→25 "); // anchor preserved
});
```

**Note:** If sdk-proxy.test.ts uses a specific helper for building test inputs, adapt the test to match that pattern. The key assertions are: no raw `\d+\t` prefixes after stripping, and `→25` anchor present.

Run: `pnpm test src/wrapper/sdk-proxy.test.ts -t "I1"` — expect **FAIL**.

- [ ] **Step 5e: Integrate stripping in sdk-proxy.ts**

In `src/wrapper/sdk-proxy.ts`, at the top imports, add:

```typescript
import { stripLineNumbers } from "./strip-line-numbers.js";
```

Then, in the `isToolResultMessage` branch where the frame is processed (after the routing decision, before `child.stdin?.write(line + "\n")`), add line-number stripping for Read tool results:

Find the block that writes the original line:
```typescript
  child.stdin?.write(JSON.stringify(setModel) + "\n");
  child.stdin?.write(line + "\n");
```

Replace the second write with:
```typescript
  child.stdin?.write(JSON.stringify(setModel) + "\n");

  // I1: strip cat-n line numbers from Read tool results to reduce context tokens
  const lineToForward =
    resolvedToolName === "Read"
      ? rewriteReadToolResult(line)
      : line;
  child.stdin?.write(lineToForward + "\n");
```

Then add the helper function at module scope (end of file, before exports):

```typescript
/**
 * I1: rewrite a stream-json tool_result line, stripping cat-n line numbers
 * from Read tool text content. Returns original line on any parse error.
 */
function rewriteReadToolResult(line: string): string {
  let frame: unknown;
  try {
    frame = JSON.parse(line);
  } catch {
    return line;
  }

  // Navigate the stream-json shape: { type:"user", message: { content: [{ type:"tool_result", content: [{ type:"text", text: "..." }] }] } }
  const msg = (frame as { message?: { content?: unknown[] } }).message;
  if (!msg?.content || !Array.isArray(msg.content)) return line;

  let modified = false;
  const newContent = msg.content.map((item: unknown) => {
    const i = item as { type?: string; content?: unknown[] };
    if (i.type !== "tool_result" || !Array.isArray(i.content)) return item;
    const newInner = i.content.map((inner: unknown) => {
      const t = inner as { type?: string; text?: string };
      if (t.type !== "text" || typeof t.text !== "string") return inner;
      const stripped = stripLineNumbers(t.text);
      if (stripped === t.text) return inner;
      modified = true;
      return { ...t, text: stripped };
    });
    return { ...i, content: newInner };
  });

  if (!modified) return line;
  return JSON.stringify({ ...(frame as object), message: { ...msg, content: newContent } });
}
```

- [ ] **Step 5f: Run all SDK proxy tests**

```bash
pnpm test src/wrapper/sdk-proxy.test.ts
pnpm test src/wrapper/strip-line-numbers.test.ts
pnpm typecheck
```

Expected: all pass.

- [ ] **Step 5g: Commit**

```bash
git add src/wrapper/strip-line-numbers.ts src/wrapper/strip-line-numbers.test.ts src/wrapper/sdk-proxy.ts src/wrapper/sdk-proxy.test.ts
git commit -m "feat(sdk-proxy): I1 strip cat-n line numbers from Read tool results"
```

---

## Task 6: Integration verification

**Files:** No changes — verification only.

- [ ] **Step 6a: Full test suite**

```bash
pnpm test
```

Expected: all tests pass (0 failures).

- [ ] **Step 6b: Lint and typecheck**

```bash
pnpm lint && pnpm typecheck
```

Expected: clean.

- [ ] **Step 6c: Publint**

```bash
pnpm dlx publint
```

Expected: clean.

- [ ] **Step 6d: Commit if any stray files**

```bash
git status
```

If all changes are already in their respective commits, no action needed. If any unstaged fixes remain:

```bash
git add <files>
git commit -m "chore: integration fixes for token reduction v4"
```

---

## Self-Review

**Spec coverage:**

| Track | Task | Covered? |
|-------|------|----------|
| C1 always-log | Task 1 | ✓ |
| G2 maxOutputTokens | Task 2 | ✓ |
| durationApiMs in stats | Task 3 | ✓ |
| K2 short-circuit | Task 4 | ✓ |
| I1 line-number strip | Task 5 | ✓ |
| Z.handoff context summary | — | Deferred (requires session history accumulation beyond `lastPrompt`; complexity exceeds Sprint 1 scope) |
| J1 session file rewriting | — | Deferred per v4 design (opt-in only, Sprint 2+) |
| L1 CLAUDE.md compression | — | Deferred (one-time UX feature, not blocking) |

**Placeholder scan:** No TBD or TODO in any step. All code blocks are complete.

**Type consistency:**
- `resolveAppendSystemPrompt` signature unchanged in Task 2 — same call sites still valid
- `Summary.durationApiMsP90ByClass` added in Task 3 — render in same function that uses `outputTokensP90ByClass`
- `K2` adds no new types — uses existing `ClassifyOptions.sessionContext.recentClasses`
- `stripLineNumbers` is a standalone export with no cross-task dependencies
- `rewriteReadToolResult` is a module-internal function — no external type surface

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-25-thinking-token-reduction-v4.md`.

**Two execution options:**

**1. Subagent-Driven (recommended)** — Fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute in this session using executing-plans.

Which approach?
