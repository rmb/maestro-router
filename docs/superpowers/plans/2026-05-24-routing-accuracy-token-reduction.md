# Routing Accuracy + Token Reduction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the 2% cache hit rate (highest cost lever), improve routing accuracy for unclassified prompts, and add quality monitoring metrics to `maestro stats`.

**Architecture:** Six independent tasks ordered by impact. Tasks 1-2 are pure token-reduction fixes. Tasks 3-4 improve accuracy by making the vote path smarter. Task 5 adds quality monitoring. Task 6 makes the eval set adversarial so future regressions are caught before they ship.

**Tech Stack:** TypeScript (ESM, strict), Vitest, Node ≥ 20, existing `src/wrapper/session.ts`, `src/core/pipeline.ts`, `src/cli/stats.ts`.

---

## Why the cache hit rate is 2%

Every turn that routes to a different model tier than the previous turn in the same session pays full `cache_creation` (~$0.02-$0.05) — the prompt cache is keyed by `(content, model)`. With one session per cwd, a session that goes `trivial→haiku`, `standard→sonnet`, `trivial→haiku` pays three cache boots. Model-affinity sessions (one session per `(cwd, model)`) collapse that to one boot per tier per cwd — subsequent same-model turns become `cache_read` ($0.0002 instead of $0.02).

## What telemetry does and doesn't track

`decisions.jsonl` records only Maestro-routed outer turns (prompts you type). It does **not** track:
- Claude's internal tool calls (`Read`, `Edit`, `Bash`) spawned inside the `claude --print` process
- `/model`, `/help`, `/compact` passthrough commands
- VSCode extension's own synthetic tool-result turns

The "simple avg $0.00" and "hard avg $0.00" in `maestro stats` are entries where the spawned Claude process didn't return valid JSON (budget error, early exit) — the cost field is absent. This is a telemetry gap, not a routing gap.

---

## Task 1: Model-affinity session store

**Impact:** Expected 10-40× reduction in cache_creation cost for mixed-model sessions.

**Files:**
- Modify: `src/wrapper/session.ts`
- Modify: `src/wrapper/session.test.ts`
- Modify: `src/cli/run-cmd.ts` (2 lines)

- [ ] **Step 1: Write failing tests for model-tier isolation**

Add at the end of `src/wrapper/session.test.ts`:

```typescript
describe("model-tier affinity", () => {
  test("same cwd, different modelTier → different sessions", async () => {
    const store = createSessionStore({ path: join(dir, "s.json") });
    const haiku = await store.getOrCreate("/foo", "haiku");
    const sonnet = await store.getOrCreate("/foo", "sonnet");
    expect(haiku.sessionId).not.toBe(sonnet.sessionId);
    expect(haiku.isNew).toBe(true);
    expect(sonnet.isNew).toBe(true);
  });

  test("same cwd, same modelTier → session reused", async () => {
    const store = createSessionStore({ path: join(dir, "s.json") });
    const first = await store.getOrCreate("/foo", "haiku");
    const second = await store.getOrCreate("/foo", "haiku");
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.isNew).toBe(false);
  });

  test("modelTier missing in stored record → treated as 'legacy' tier, not reused across tiers", async () => {
    const path = join(dir, "s.json");
    // Simulate a pre-migration record without modelTier
    await writeFile(
      path,
      JSON.stringify([
        {
          sessionId: "old-uuid",
          cwd: "/foo",
          createdAt: new Date().toISOString(),
          lastUsedAt: new Date().toISOString(),
        },
      ]),
    );
    const store = createSessionStore({ path });
    const result = await store.getOrCreate("/foo", "haiku");
    // Old record has no modelTier — treated as different tier, gets new session
    expect(result.sessionId).not.toBe("old-uuid");
    expect(result.isNew).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm test src/wrapper/session.test.ts 2>&1 | grep -E "FAIL|✗|Error"
```
Expected: 3 new tests fail with type errors or wrong behavior.

- [ ] **Step 3: Update SessionRecord and getOrCreate signature in session.ts**

In `src/wrapper/session.ts`, replace the `SessionRecord` type and `getOrCreate` signature:

```typescript
export type SessionRecord = {
  sessionId: string;
  cwd: string;
  /** Model alias: "haiku" | "sonnet" | "opus". Legacy records missing this field
   *  are never reused (treated as unknown tier). */
  modelTier?: string;
  createdAt: string;
  lastUsedAt: string;
};
```

In `createSessionStore`, update `getOrCreate` signature:

```typescript
async getOrCreate(cwd: string, modelTier: string, options?: GetOrCreateOptions): Promise<GetOrCreateResult> {
```

Update the filter inside `getOrCreate` to require matching `modelTier`:

```typescript
const recent = records
  .filter(
    (r) =>
      r.cwd === cwd &&
      r.modelTier === modelTier &&        // ← new condition
      Date.parse(r.lastUsedAt) >= cutoff,
  )
  .sort((a, b) => Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt));
```

Update the `created` record to include `modelTier`:

```typescript
const created: SessionRecord = {
  sessionId,
  cwd,
  modelTier,                              // ← add this
  createdAt: nowIso,
  lastUsedAt: nowIso,
};
```

Also update `isValidSession` to not require `modelTier` (backward compat — it's optional):

```typescript
function isValidSession(value: unknown): value is SessionRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.sessionId === "string" &&
    typeof r.cwd === "string" &&
    typeof r.createdAt === "string" &&
    typeof r.lastUsedAt === "string"
    // modelTier is optional — old records survive migration
  );
}
```

Also update `SessionStore` type:

```typescript
export type SessionStore = {
  getOrCreate(cwd: string, modelTier: string, opts?: GetOrCreateOptions): Promise<GetOrCreateResult>;
  touch(sessionId: string): Promise<void>;
  list(): Promise<SessionRecord[]>;
};
```

- [ ] **Step 4: Update the call site in run-cmd.ts**

In `src/cli/run-cmd.ts`, find:

```typescript
const session = await sessions.getOrCreate(process.cwd(), {
  ...(cmdOpts.newSession ? { newSession: true } : {}),
});
```

Replace with:

```typescript
const session = await sessions.getOrCreate(process.cwd(), decision.spec.model, {
  ...(cmdOpts.newSession ? { newSession: true } : {}),
});
```

- [ ] **Step 5: Update existing session tests that call getOrCreate without modelTier**

In `src/wrapper/session.test.ts`, find all existing calls like `store.getOrCreate("/foo")` and add `"haiku"` as the second argument. There are approximately 10 such calls in the existing tests. Example:

```typescript
// before:
const result = await store.getOrCreate("/foo");
// after:
const result = await store.getOrCreate("/foo", "haiku");
```

- [ ] **Step 6: Run tests**

```bash
pnpm typecheck && pnpm test src/wrapper/session.test.ts
```
Expected: all pass.

- [ ] **Step 7: Full test suite**

```bash
pnpm test
```
Expected: 1515+ tests pass, 0 failures.

- [ ] **Step 8: Commit**

```bash
git add src/wrapper/session.ts src/wrapper/session.test.ts src/cli/run-cmd.ts
git commit -m "feat(session): model-affinity store — one session per (cwd, model-tier)"
```

---

## Task 2: `--max-output-tokens` per class

**Impact:** Prevents Haiku from generating 800-token essays for trivial rename prompts. Reduces output token cost and speeds up responses.

**Files:**
- Modify: `src/core/types.ts` — add `maxOutputTokens?: number` to `ClassSpec`
- Modify: `src/core/profile.ts` — set per-class defaults
- Modify: `src/wrapper/spawn.ts` — emit flag in `buildClaudeArgs`
- Modify: `src/wrapper/spawn.test.ts` — test new flag

- [ ] **Step 1: Write failing tests**

In `src/wrapper/spawn.test.ts`, add:

```typescript
describe("maxOutputTokens", () => {
  test("emits --max-output-tokens when spec sets it", () => {
    const args = buildClaudeArgs({
      decision: mockDecision({ maxOutputTokens: 200 }),
      userConfig: {},
      sessionId: "abc",
      isResume: false,
    });
    expect(args).toContain("--max-output-tokens");
    const idx = args.indexOf("--max-output-tokens");
    expect(args[idx + 1]).toBe("200");
  });

  test("omits --max-output-tokens when spec does not set it", () => {
    const args = buildClaudeArgs({
      decision: mockDecision({}),
      userConfig: {},
      sessionId: "abc",
      isResume: false,
    });
    expect(args).not.toContain("--max-output-tokens");
  });
});
```

Where `mockDecision` is a test helper you'll find already in spawn.test.ts — look for the existing helper and add `maxOutputTokens` to `ClassSpec` fields it builds from.

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm test src/wrapper/spawn.test.ts 2>&1 | grep -E "FAIL|✗"
```
Expected: new tests fail (type error + missing flag).

- [ ] **Step 3: Add field to ClassSpec in types.ts**

In `src/core/types.ts`, in the `ClassSpec` type, add:

```typescript
/** Hard ceiling on output tokens. Omitted = unlimited. Use for trivial/simple
 *  to prevent over-explanation. */
maxOutputTokens?: number;
```

- [ ] **Step 4: Set per-class defaults in profile.ts**

In `src/core/profile.ts`, update `balancedProfile.classes`:

```typescript
trivial: {
  model: "haiku",
  effort: "low",
  tools: "Read,Edit",
  bare: true,
  mcpConfig: '{"mcpServers":{}}',
  maxBudgetUsd: 0.05,
  maxOutputTokens: 200,       // ← add
},
simple: {
  model: "sonnet",
  effort: "low",
  tools: "Read,Edit",
  mcpConfig: '{"mcpServers":{}}',
  maxBudgetUsd: 0.3,
  maxOutputTokens: 500,       // ← add
},
standard: { model: "sonnet", effort: "medium", tools: "default", maxBudgetUsd: 1.0, maxOutputTokens: 2000 },
// hard/reasoning/max: leave uncapped (no maxOutputTokens)
```

Apply the same additions to `cheapProfile` and `qualityProfile` with the same token values (token ceilings are task-class properties, not cost-profile properties).

- [ ] **Step 5: Emit flag in spawn.ts**

In `src/wrapper/spawn.ts`, in `buildClaudeArgs`, add after the `appendSystemPrompt` block:

```typescript
// Output ceiling — prevents over-explanation on trivial/simple prompts
if (spec.maxOutputTokens !== undefined) {
  args.push("--max-output-tokens", String(spec.maxOutputTokens));
}
```

- [ ] **Step 6: Run tests**

```bash
pnpm typecheck && pnpm test src/wrapper/spawn.test.ts
```
Expected: all pass including new tests.

- [ ] **Step 7: Run full suite**

```bash
pnpm test
```
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/core/types.ts src/core/profile.ts src/wrapper/spawn.ts src/wrapper/spawn.test.ts
git commit -m "feat(spawn): --max-output-tokens per class — cap trivial:200 simple:500 standard:2000"
```

---

## Task 3: Fallback rate + output token p90 in `maestro stats`

**Impact:** Makes the accuracy blind spot visible. "N% of prompts had no classifier match" is the single most actionable routing metric. Output token p90 by class is the quality proxy.

**Files:**
- Modify: `src/cli/stats.ts`
- Modify: `src/cli/stats.test.ts`

- [ ] **Step 1: Write failing tests for new metrics**

In `src/cli/stats.test.ts`, add:

```typescript
describe("fallback rate", () => {
  test("fallbackRate counts decisions where classifier === 'default'", () => {
    const events: TelemetryEvent[] = [
      makeFallbackDecision("2026-05-24T10:00:00.000Z"),
      makeDecision("heuristic", "trivial", "2026-05-24T10:01:00.000Z"),
      makeFallbackDecision("2026-05-24T10:02:00.000Z"),
    ];
    const summary = computeSummary(events, 1);
    expect(summary.fallbackRate).toBeCloseTo(2 / 3);
  });

  test("fallbackRate is 0 when all decisions have a real classifier", () => {
    const events: TelemetryEvent[] = [
      makeDecision("heuristic", "trivial", "2026-05-24T10:00:00.000Z"),
    ];
    const summary = computeSummary(events, 1);
    expect(summary.fallbackRate).toBe(0);
  });
});

describe("outputTokensP90ByClass", () => {
  test("p90 of output tokens per class", () => {
    const events: TelemetryEvent[] = Array.from({ length: 10 }, (_, i) =>
      makeDecisionWithOutputTokens("heuristic", "standard", `2026-05-24T10:${String(i).padStart(2, "0")}:00.000Z`, (i + 1) * 100),
    );
    const summary = computeSummary(events, 1);
    // p90 of [100,200,...,1000] = 900 (index 8 of sorted 0-indexed array)
    expect(summary.outputTokensP90ByClass.standard).toBe(900);
  });
});

// Helper to build a fallback decision event
function makeFallbackDecision(ts: string): TelemetryEvent {
  return {
    type: "decision",
    ts,
    decision: {
      class: "standard",
      classifier: "default",   // ← "default" = fallback
      confidence: 0,
      spec: { model: "sonnet", effort: "medium", maxBudgetUsd: 1.0 },
      latencyMs: 0,
      diagnostics: [],
    },
  };
}

function makeDecisionWithOutputTokens(
  classifier: string,
  cls: Class,
  ts: string,
  outputTokens: number,
): TelemetryEvent {
  return {
    type: "decision",
    ts,
    decision: {
      class: cls,
      classifier,
      confidence: 0.9,
      spec: { model: "sonnet", effort: "medium", maxBudgetUsd: 1.0 },
      latencyMs: 0,
      diagnostics: [],
    },
    cost: {
      totalCostUsd: 0.001,
      inputTokens: 10,
      outputTokens,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
  };
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm test src/cli/stats.test.ts 2>&1 | grep -E "FAIL|✗|does not exist"
```
Expected: new tests fail (fields missing from Summary type).

- [ ] **Step 3: Extend Summary type in stats.ts**

In `src/cli/stats.ts`, add to the `Summary` type:

```typescript
/** Fraction of decisions where no classifier matched (classifier === "default"). */
fallbackRate: number;
/** p90 output token count per class — quality proxy. High = over-explanation. */
outputTokensP90ByClass: Record<Class, number>;
```

- [ ] **Step 4: Compute new metrics in computeSummary**

In `computeSummary`, add trackers before the event loop:

```typescript
let fallbackCount = 0;
const outputTokensByClass: Record<Class, number[]> = makeOutputTokensMap();
```

Add a helper at the bottom of the file:

```typescript
function makeOutputTokensMap(): Record<Class, number[]> {
  return Object.fromEntries(ALL_CLASSES.map((c) => [c, []])) as Record<Class, number[]>;
}

function p90(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.floor(sorted.length * 0.9);
  return sorted[Math.min(idx, sorted.length - 1)] ?? 0;
}
```

Inside the `if (e.type === "decision")` block, add:

```typescript
if (e.decision.classifier === "default") fallbackCount++;
if (e.cost?.outputTokens) {
  outputTokensByClass[e.decision.class].push(e.cost.outputTokens);
}
```

In the return value of `computeSummary`, add:

```typescript
fallbackRate: totalRequests > 0 ? fallbackCount / totalRequests : 0,
outputTokensP90ByClass: Object.fromEntries(
  ALL_CLASSES.map((c) => [c, p90(outputTokensByClass[c])]),
) as Record<Class, number>,
```

- [ ] **Step 5: Render new metrics in renderHuman**

In `src/cli/stats.ts`, in `renderHuman`, add a new section after the per-class table:

```typescript
lines.push("");
lines.push(header("classifier health"));
const fallbackPct = (summary.fallbackRate * 100).toFixed(1);
const fallbackColor = summary.fallbackRate > 0.1 ? yellow : green;
lines.push(`  fallback rate     ${fallbackColor(fallbackPct + "%")}  ${gray("(target < 5% — prompts with no classifier match)")}`);
lines.push("");
lines.push(header("output tokens p90 by class"));
for (const cls of ALL_CLASSES) {
  const p90val = summary.outputTokensP90ByClass[cls];
  if (p90val === 0) continue;
  lines.push(`  ${cls.padEnd(12)}  ${String(p90val).padStart(6)} tok`);
}
```

- [ ] **Step 6: Run tests**

```bash
pnpm typecheck && pnpm test src/cli/stats.test.ts
```
Expected: all pass.

- [ ] **Step 7: Smoke test the stats output**

```bash
pnpm maestro stats 2>&1 | grep -E "fallback|p90|classifier health"
```
Expected: new sections appear with real values from your `~/.maestro/decisions.jsonl`.

- [ ] **Step 8: Commit**

```bash
git add src/cli/stats.ts src/cli/stats.test.ts
git commit -m "feat(stats): fallback rate + output token p90 per class"
```

---

## Task 4: Disagreement entropy escalation in vote

**Impact:** The current vote sums weighted confidence scores — a winner with 51% of the vote looks identical to one with 100%. Adding entropy detection escalates tied/spread votes by one tier, preventing the pipeline from confidently routing to the wrong class when classifiers disagree.

**Files:**
- Modify: `src/core/pipeline.ts`
- Modify: `src/core/pipeline.test.ts`

- [ ] **Step 1: Write failing tests**

In `src/core/pipeline.test.ts`, add a new describe block:

```typescript
describe("voteDecision entropy escalation", () => {
  const mkClassification = (cls: Class, conf: number) => ({
    class: cls,
    confidence: conf,
    diagnostics: [],
  });

  test("high entropy vote (equal split) escalates class by one tier", async () => {
    // heuristic says trivial(0.4), embedding says standard(0.4) — high disagreement
    const pipeline = createTestPipeline([
      { name: "heuristic", weight: 1, classify: () => mkClassification("trivial", 0.4) },
      { name: "embedding", weight: 1, classify: () => mkClassification("standard", 0.4) },
    ]);
    const d = await pipeline.route({ prompt: "ambiguous prompt" });
    // vote winner by weighted score: trivial=0.4, standard=0.4 → tie → first wins (trivial)
    // BUT entropy is high → escalate trivial → simple
    expect(d.class).toBe("simple");
    expect(d.diagnostics.some((x) => x.code === "pipeline.entropy_escalation")).toBe(true);
  });

  test("low entropy vote (consensus) does NOT escalate", async () => {
    // both classifiers agree on standard
    const pipeline = createTestPipeline([
      { name: "heuristic", weight: 1, classify: () => mkClassification("standard", 0.4) },
      { name: "embedding", weight: 1, classify: () => mkClassification("standard", 0.45) },
    ]);
    const d = await pipeline.route({ prompt: "consistent prompt" });
    expect(d.class).toBe("standard"); // no escalation
    expect(d.diagnostics.every((x) => x.code !== "pipeline.entropy_escalation")).toBe(true);
  });
});
```

You'll need to find the `createTestPipeline` helper in the existing pipeline.test.ts and confirm it accepts the classifier shape. If the helper doesn't exist, create one:

```typescript
function createTestPipeline(stubs: Array<{ name: string; weight: number; classify: () => Classification | null }>) {
  const classifiers: Classifier[] = stubs.map((s) => ({
    name: s.name,
    weight: s.weight,
    classify: (_req: Request) => Promise.resolve(s.classify()),
  }));
  return createPipeline({ classifiers, profile: balancedProfile });
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm test src/core/pipeline.test.ts 2>&1 | grep -E "FAIL|✗"
```
Expected: entropy escalation tests fail.

- [ ] **Step 3: Add entropy computation and escalation to voteDecision**

In `src/core/pipeline.ts`, update the `voteDecision` function:

```typescript
function voteDecision(args: {
  collected: ReadonlyArray<{ name: string; weight: number; result: Classification }>;
  profile: Profile;
  latencyMs: number;
  diagnostics: ReadonlyArray<Diagnostic>;
}): Decision {
  const votes = new Map<Class, number>();
  let totalWeight = 0;
  for (const { weight, result } of args.collected) {
    const score = weight * result.confidence;
    votes.set(result.class, (votes.get(result.class) ?? 0) + score);
    totalWeight += score;
  }

  // Shannon entropy of the normalized vote distribution
  // H = 0 → unanimous; H ≈ log2(N) → max disagreement
  const entropy = totalWeight > 0
    ? -Array.from(votes.values()).reduce((sum, score) => {
        const p = score / totalWeight;
        return p > 0 ? sum + p * Math.log2(p) : sum;
      }, 0)
    : 0;

  let winningClass: Class = DEFAULT_CLASS;
  let winningScore = 0;
  for (const [cls, score] of votes) {
    if (score > winningScore) {
      winningClass = cls;
      winningScore = score;
    }
  }

  const topContributor = args.collected
    .filter((r) => r.result.class === winningClass)
    .sort((a, b) => b.weight * b.result.confidence - a.weight * a.result.confidence)[0];

  // Entropy > 0.7 bit indicates meaningful classifier disagreement → escalate one tier.
  // 0.7 bit corresponds to roughly 40/60 vote split between two classes.
  const ENTROPY_ESCALATION_THRESHOLD = 0.7;
  const escalate = entropy > ENTROPY_ESCALATION_THRESHOLD;
  const finalClass = escalate ? UPGRADE[winningClass] : winningClass;
  const finalDiagnostics: Diagnostic[] = escalate
    ? [
        ...args.diagnostics,
        {
          severity: "info",
          code: "pipeline.entropy_escalation",
          message: `${winningClass} → ${finalClass} (vote entropy ${entropy.toFixed(2)} > ${ENTROPY_ESCALATION_THRESHOLD})`,
        },
      ]
    : [...args.diagnostics];

  return buildDecision({
    cls: finalClass,
    classifier: topContributor ? `vote:${topContributor.name}` : "vote",
    confidence: winningScore,
    profile: args.profile,
    latencyMs: args.latencyMs,
    diagnostics: finalDiagnostics,
  });
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm typecheck && pnpm test src/core/pipeline.test.ts
```
Expected: all pass including new entropy tests.

- [ ] **Step 5: Run eval to verify no regression**

```bash
pnpm eval 2>&1 | tail -10
```
Expected: accuracy ≥ 0.98 (this change only affects sub-threshold votes, which was already defaulting to `standard` — entropy escalation makes it `hard`, which is the safer direction).

- [ ] **Step 6: Commit**

```bash
git add src/core/pipeline.ts src/core/pipeline.test.ts
git commit -m "feat(pipeline): entropy escalation in vote — classifier disagreement routes up not down"
```

---

## Task 5: Temporal Markov prior for `fallback.default` tiebreaking

**Impact:** The `fallback.default` decisions (confidence 0, no classifier matched) currently route to `standard`. A Markov prior on the session's last 3 routing decisions gives a better default: if you've been doing trivial fixes, the next unclassified prompt is more likely trivial than standard.

**Files:**
- Modify: `src/wrapper/session.ts` — add `recentClasses` to SessionRecord + `appendClass()` method
- Modify: `src/wrapper/session.test.ts` — add tests for appendClass
- Modify: `src/core/types.ts` — add `sessionContext` to `ClassifyOptions`
- Modify: `src/core/pipeline.ts` — use sessionContext as tiebreaker when no classifier fires
- Modify: `src/cli/run-cmd.ts` — thread recentClasses through and call appendClass after routing

- [ ] **Step 1: Write failing tests for appendClass**

In `src/wrapper/session.test.ts`, add:

```typescript
describe("appendClass", () => {
  test("appends class to recentClasses, capped at 5", async () => {
    const store = createSessionStore({ path: join(dir, "s.json") });
    const { sessionId } = await store.getOrCreate("/foo", "sonnet");
    for (const cls of ["trivial", "simple", "standard", "hard", "reasoning", "max"] as const) {
      await store.appendClass(sessionId, cls);
    }
    const records = await store.list();
    const rec = records.find((r) => r.sessionId === sessionId);
    // cap at 5 most-recent
    expect(rec?.recentClasses).toHaveLength(5);
    expect(rec?.recentClasses?.at(-1)).toBe("max");
    expect(rec?.recentClasses?.[0]).toBe("simple"); // "trivial" dropped off the front
  });

  test("returns empty recentClasses for a new session", async () => {
    const store = createSessionStore({ path: join(dir, "s.json") });
    const { sessionId } = await store.getOrCreate("/foo", "sonnet");
    const records = await store.list();
    const rec = records.find((r) => r.sessionId === sessionId);
    expect(rec?.recentClasses ?? []).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm test src/wrapper/session.test.ts 2>&1 | grep -E "FAIL|✗"
```
Expected: new tests fail (appendClass not found).

- [ ] **Step 3: Add recentClasses to SessionRecord and appendClass to session.ts**

In `src/wrapper/session.ts`, update `SessionRecord`:

```typescript
export type SessionRecord = {
  sessionId: string;
  cwd: string;
  modelTier?: string;
  /** Last ≤5 routing classes in this session, oldest first. */
  recentClasses?: string[];
  createdAt: string;
  lastUsedAt: string;
};
```

Update `SessionStore` type:

```typescript
export type SessionStore = {
  getOrCreate(cwd: string, modelTier: string, opts?: GetOrCreateOptions): Promise<GetOrCreateResult>;
  touch(sessionId: string): Promise<void>;
  appendClass(sessionId: string, cls: string): Promise<void>;
  list(): Promise<SessionRecord[]>;
};
```

Add `appendClass` implementation inside `createSessionStore`:

```typescript
async appendClass(sessionId: string, cls: string): Promise<void> {
  const records = await read();
  const updated = records.map((r) => {
    if (r.sessionId !== sessionId) return r;
    const prev = r.recentClasses ?? [];
    const next = [...prev, cls].slice(-5); // keep last 5
    return { ...r, recentClasses: next };
  });
  await write(updated);
},
```

- [ ] **Step 4: Add sessionContext to ClassifyOptions in types.ts**

In `src/core/types.ts`, find the `ClassifyOptions` type and add:

```typescript
export type ClassifyOptions = {
  /** Optional. Passed to classifiers that accept extra context. */
  signal?: AbortSignal;
  /** Markov prior from session history — used as tiebreaker when no classifier fires. */
  sessionContext?: {
    /** Last ≤5 routing classes in this session, oldest first. */
    recentClasses: ReadonlyArray<string>;
  };
};
```

If `ClassifyOptions` doesn't exist in types.ts (it may be inline), check `src/core/pipeline.ts` for where it's defined and add `sessionContext` there instead.

- [ ] **Step 5: Use sessionContext as fallback tiebreaker in pipeline.ts**

In `src/core/pipeline.ts`, in the `route` function, find the fallback block at the end (where `collected.length === 0`) and update it:

```typescript
if (collected.length > 0) {
  const decision = voteDecision({ collected, profile, latencyMs: Date.now() - start, diagnostics });
  if (cache) cache.set(key, decision);
  return decision;
}

// No signal from any classifier. Apply Markov prior from session history.
const recentClasses = classifyOpts?.sessionContext?.recentClasses ?? [];
const markovClass = markovPrior(recentClasses);
const cls = markovClass ?? DEFAULT_CLASS;
const markovDiag: Diagnostic = markovClass
  ? { severity: "info", code: "pipeline.markov_prior", message: `no classifier matched; prior → ${markovClass} from last ${recentClasses.length} turns` }
  : { severity: "info", code: "fallback.default", message: "no classifier returned a signal" };

const decision = buildDecision({
  cls,
  classifier: markovClass ? "markov" : "default",
  confidence: markovClass ? 0.35 : 0,
  profile,
  latencyMs: Date.now() - start,
  diagnostics: [...diagnostics, markovDiag],
});
if (cache) cache.set(key, decision);
return decision;
```

Add `markovPrior` function at the bottom of pipeline.ts:

```typescript
/**
 * Markov prior: if the last 3+ routing classes are consistent (same class),
 * return that class as the prior. Otherwise return null (no strong signal).
 * Uses only the last 3 decisions to stay responsive to mode switches.
 */
function markovPrior(recentClasses: ReadonlyArray<string>): Class | null {
  if (recentClasses.length < 2) return null;
  const last3 = recentClasses.slice(-3);
  const unique = new Set(last3);
  if (unique.size === 1) {
    const cls = last3[0] as Class;
    const VALID: ReadonlySet<Class> = new Set(["trivial", "simple", "standard", "hard", "reasoning", "max"]);
    return VALID.has(cls) ? cls : null;
  }
  return null;
}
```

- [ ] **Step 6: Thread recentClasses in run-cmd.ts**

In `src/cli/run-cmd.ts`, after getting the session:

```typescript
const session = await sessions.getOrCreate(process.cwd(), decision.spec.model, { ... });
```

Change the pipeline.route call to pass session context. Since `decision` is computed before the session is fetched, we need to re-read the session record after routing. Simplest approach — read records from the store before routing:

Restructure run-cmd.ts to read the recent classes from disk before routing. Find the session matching `(cwd, model)` — but we don't know the model before routing. So the Markov prior uses the LAST session's classes regardless of model tier:

```typescript
// Read Markov prior from any recent session for this cwd
const allSessions = await sessions.list();
const cwd = process.cwd();
const sessionForPrior = allSessions
  .filter((s) => s.cwd === cwd)
  .sort((a, b) => Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt))[0];
const recentClasses = sessionForPrior?.recentClasses ?? [];

const decision = await pipeline.route(
  { prompt },
  { sessionContext: { recentClasses } },
);
```

Then after telemetry is logged, call:

```typescript
await sessions.appendClass(session.sessionId, decision.class);
```

- [ ] **Step 7: Add Markov prior tests to pipeline.test.ts**

```typescript
describe("markov prior fallback", () => {
  test("consistent last-3 trivial → prior routes to trivial", async () => {
    const pipeline = createTestPipeline([]); // no classifiers → guaranteed fallback
    const d = await pipeline.route(
      { prompt: "do something" },
      { sessionContext: { recentClasses: ["trivial", "trivial", "trivial"] } },
    );
    expect(d.class).toBe("trivial");
    expect(d.classifier).toBe("markov");
  });

  test("inconsistent last-3 → standard default", async () => {
    const pipeline = createTestPipeline([]);
    const d = await pipeline.route(
      { prompt: "do something" },
      { sessionContext: { recentClasses: ["trivial", "hard", "standard"] } },
    );
    expect(d.class).toBe("standard");
    expect(d.classifier).toBe("default");
  });

  test("empty session history → standard default", async () => {
    const pipeline = createTestPipeline([]);
    const d = await pipeline.route({ prompt: "do something" });
    expect(d.class).toBe("standard");
  });
});
```

- [ ] **Step 8: Run tests**

```bash
pnpm typecheck && pnpm test
```
Expected: all pass.

- [ ] **Step 9: Run eval**

```bash
pnpm eval 2>&1 | tail -5
```
Expected: accuracy ≥ 0.98 (Markov only activates on fallback.default; the 327-prompt set has labeled examples so the heuristic fires on all of them).

- [ ] **Step 10: Commit**

```bash
git add src/wrapper/session.ts src/wrapper/session.test.ts src/core/types.ts src/core/pipeline.ts src/cli/run-cmd.ts
git commit -m "feat(pipeline): Markov prior replaces fallback.default with session-history tiebreaker"
```

---

## Task 6: Adversarial eval set (50 out-of-distribution prompts)

**Impact:** The current 327-prompt eval is self-referential (heuristic was tuned on it → 100%). These 50 prompts are designed to fool the heuristic so future regressions are caught before they ship.

**Files:**
- Modify: `evals/labeled.jsonl` — append 50 adversarial prompts
- Run: `pnpm eval` to measure real accuracy on adversarial set

- [ ] **Step 1: Append 50 adversarial prompts to evals/labeled.jsonl**

Each line is a JSON object `{"prompt":"...","expectedClass":"...","source":"adversarial"}`. Append all of these:

```jsonl
{"prompt":"just fix it","expectedClass":"hard","source":"adversarial"}
{"prompt":"make it work","expectedClass":"hard","source":"adversarial"}
{"prompt":"do a thorough refactor of this 3-line function","expectedClass":"simple","source":"adversarial"}
{"prompt":"quickly design the authentication architecture","expectedClass":"reasoning","source":"adversarial"}
{"prompt":"finish implementing it","expectedClass":"standard","source":"adversarial"}
{"prompt":"clean up everything","expectedClass":"hard","source":"adversarial"}
{"prompt":"add the missing piece","expectedClass":"standard","source":"adversarial"}
{"prompt":"update it to match the new spec","expectedClass":"hard","source":"adversarial"}
{"prompt":"rename all methods in the entire codebase to follow our convention","expectedClass":"hard","source":"adversarial"}
{"prompt":"just rename the variable","expectedClass":"trivial","source":"adversarial"}
{"prompt":"the build is broken in CI but passes locally","expectedClass":"hard","source":"adversarial"}
{"prompt":"users are getting logged out randomly and we cannot reproduce it","expectedClass":"max","source":"adversarial"}
{"prompt":"this sometimes throws but not always","expectedClass":"hard","source":"adversarial"}
{"prompt":"add a simple caching layer across the entire API","expectedClass":"hard","source":"adversarial"}
{"prompt":"implement full-text search for 10 million records","expectedClass":"hard","source":"adversarial"}
{"prompt":"design a simple button component","expectedClass":"simple","source":"adversarial"}
{"prompt":"design the entire data model for the new billing system","expectedClass":"reasoning","source":"adversarial"}
{"prompt":"should we use Postgres or MongoDB for this?","expectedClass":"reasoning","source":"adversarial"}
{"prompt":"is TypeScript worth the overhead for this project?","expectedClass":"reasoning","source":"adversarial"}
{"prompt":"add and also update and then refactor the handler and write tests for it","expectedClass":"hard","source":"adversarial"}
{"prompt":"fix the typo in the README and also fix the race condition in the auth module","expectedClass":"hard","source":"adversarial"}
{"prompt":"what does this function do","expectedClass":"simple","source":"adversarial"}
{"prompt":"explain the entire architecture of this codebase","expectedClass":"hard","source":"adversarial"}
{"prompt":"what's wrong with this?","expectedClass":"hard","source":"adversarial"}
{"prompt":"is this correct?","expectedClass":"standard","source":"adversarial"}
{"prompt":"add it","expectedClass":"standard","source":"adversarial"}
{"prompt":"delete it","expectedClass":"standard","source":"adversarial"}
{"prompt":"move the logic to the service layer everywhere","expectedClass":"hard","source":"adversarial"}
{"prompt":"make all API responses consistent with our new error schema","expectedClass":"hard","source":"adversarial"}
{"prompt":"extract the duplicated code into a shared util","expectedClass":"standard","source":"adversarial"}
{"prompt":"production memory usage spiked 3x overnight with no deploy — here are the heap snapshots","expectedClass":"max","source":"adversarial"}
{"prompt":"our largest customer's import is silently failing and their data isn't showing up","expectedClass":"max","source":"adversarial"}
{"prompt":"intermittent 503s on the payment endpoint, 0.3% error rate, no pattern yet","expectedClass":"max","source":"adversarial"}
{"prompt":"add an index","expectedClass":"simple","source":"adversarial"}
{"prompt":"add a composite index on user_id and created_at for the orders table, measure query plan before and after","expectedClass":"hard","source":"adversarial"}
{"prompt":"update the env variable","expectedClass":"trivial","source":"adversarial"}
{"prompt":"migrate all environment variables from .env to Vault across 12 services","expectedClass":"hard","source":"adversarial"}
{"prompt":"write a test","expectedClass":"standard","source":"adversarial"}
{"prompt":"write tests that cover all the edge cases and make sure nothing regresses","expectedClass":"hard","source":"adversarial"}
{"prompt":"add error handling","expectedClass":"simple","source":"adversarial"}
{"prompt":"add robust error handling with retry, circuit breaker, and dead-letter queue","expectedClass":"hard","source":"adversarial"}
{"prompt":"format the file","expectedClass":"trivial","source":"adversarial"}
{"prompt":"format all files in the monorepo and fix any lint errors","expectedClass":"hard","source":"adversarial"}
{"prompt":"change the color","expectedClass":"trivial","source":"adversarial"}
{"prompt":"redesign the color system to support dark mode across the entire component library","expectedClass":"hard","source":"adversarial"}
{"prompt":"the webhook is not firing","expectedClass":"hard","source":"adversarial"}
{"prompt":"add a comment","expectedClass":"trivial","source":"adversarial"}
{"prompt":"document the entire public API with examples","expectedClass":"hard","source":"adversarial"}
{"prompt":"which approach should we take for state management?","expectedClass":"reasoning","source":"adversarial"}
```

- [ ] **Step 2: Run eval to see current accuracy on adversarial set**

```bash
pnpm eval 2>&1 | tail -20
```

Note the accuracy. The adversarial set is intentionally hard — expect 70-85% initially. The goal is not 100%; it's to have a non-self-referential baseline you can track regressions against.

- [ ] **Step 3: Update the baseline if the eval infrastructure allows per-source filtering**

Check if `evals/run.ts` supports a `--source` flag. If not, check whether it separates "seed" from "adversarial" in its output. If not, the total accuracy drop is expected (from 100% → ~85%) and is meaningful.

Run:
```bash
pnpm eval -- --source adversarial 2>&1 || pnpm eval 2>&1
```

- [ ] **Step 4: Commit the adversarial set and new baseline**

```bash
git add evals/labeled.jsonl evals/baseline.json
git commit -m "eval: add 50 adversarial prompts — out-of-distribution benchmark (expect ~80% initial accuracy)"
```

---

## Summary of expected impact

| Task | Metric | Before | Expected After |
|------|--------|--------|----------------|
| 1. Model-affinity sessions | cache hit rate | 2% | 60-80% |
| 1. Model-affinity sessions | session boot cost / week | $0.27 | $0.05-0.08 |
| 2. max-output-tokens | trivial/simple output tokens | uncapped | ≤200/500 |
| 3. Fallback rate in stats | visibility | none | visible in `maestro stats` |
| 4. Entropy escalation | misroute-down on split votes | silent | escalated |
| 5. Markov prior | fallback.default class | always `standard` | session-history prior |
| 6. Adversarial eval | real accuracy signal | 100% (overfit) | ~80% (honest) |
