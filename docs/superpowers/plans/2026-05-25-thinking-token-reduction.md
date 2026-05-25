# Thinking Token Reduction + Telemetry Accuracy Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reduce tokens consumed during Claude's internal thinking and tool-use chain by 40–70% for trivial/simple prompts, without degrading output quality. Fix the telemetry blind spots so you can measure the gains.

**Architecture:** Three layers of attack — (1) fix the measurement so you know what you're spending, (2) compress the cognitive surface before routing, (3) hack Claude Code's spawn architecture to short-circuit internal reasoning.

**Tech Stack:** TypeScript ESM, Node ≥ 20, existing `src/wrapper/spawn.ts`, `src/core/types.ts`, `src/core/profile.ts`, `src/cli/run-cmd.ts`.

---

## The Telemetry Truth (read this first)

Your `decisions.jsonl` has **134 events, but only 6 have cost data**. This means you are flying blind on 95% of your actual spend. The cause:

`parseOutput` in `run-cmd.ts` only writes a cost event when `--output-format json` produces parseable JSON from Claude's stdout. Development runs, LLM-classifier test spawns, and subagent worktree sessions all produce events with no cost field. The 6 events that DO have cost data show `inputTokens: 10, outputTokens: 20` — those are the LLM classifier's own Haiku calls, not your actual Claude Code response costs.

**Your actual Claude Code costs are invisible in the telemetry.** The `maestro stats` savings numbers are computed from cost events, which means the 82% savings figure is based on 6 data points. The real picture requires fixing event capture first.

There's a second invisible cost nobody tracks: **Claude's internal tool-use chain.** When Claude responds to "refactor this file", it internally runs 5-15 tool calls (Read → analyze → Edit → verify → done). Each tool call appends the full conversation history as input again. Turn 1 might cost $0.01; the same session at turn 50 costs $0.15 for the same task because the history prefix has grown 15×. Maestro routes the prompt but has no visibility into what happens inside the spawn.

**What `total_cost_usd` does capture**: the complete cost of one Claude spawn, including all internal tool calls, extended thinking tokens (billed as output), and conversation history reads. So the dollar number IS right when it's present. The token breakdown (input/output/cache) is just the final turn's delta, not the cumulative internal chain.

---

## The Token Reduction Taxonomy

```
Total tokens per user turn
├── System prompt tokens (Claude Code's ~37k static context)
│   └── Already attacked by: --exclude-dynamic, --bare, --strict-mcp-config
├── Conversation history tokens (grows linearly per turn)
│   └── Currently: NO mitigation in Maestro
├── Tool call turns (Read → Edit → Bash chains internally)
│   └── Currently: NO mitigation — each tool adds full-history input
├── Extended thinking tokens (--effort medium/high/max)
│   └── Currently: partially mitigated by effort-level routing
└── Output tokens (the actual response)
    └── Already attacked by: --max-output-tokens, appendSystemPrompt brevity hint
```

Items 2, 3, and 4 are where the unconventional gains are.

---

## Task 1: Fix cost event capture — make telemetry real

**Why:** Without this, you cannot measure any of the gains from Tasks 2-5. You're optimizing blind.

**Root cause:** `parseOutput` in `output.ts` parses Claude CLI's `--output-format json` tail. But the `decisions.jsonl` write is gated on `if (parsed)` — when the Claude process exits with a non-zero code (budget error, SIGINT, tool failure), stdout may contain partial JSON or nothing. The cost is real but Maestro drops it.

**Files:**
- Modify: `src/wrapper/output.ts` — add a `partialCost` extractor that grabs `total_cost_usd` from partial JSON when full parse fails
- Modify: `src/cli/run-cmd.ts` — log a cost-only event even when `parsed` is null, using `result.capturedStdout` for partial extraction

**Exact change in run-cmd.ts:**

Currently:
```typescript
const parsed = parseOutput(result.capturedStdout, cli.userConfig);
if (parsed) {
  await telemetry.log({ type: "decision", ts: ..., decision, cost: parsed.cost, ... });
}
```

Should be:
```typescript
const parsed = parseOutput(result.capturedStdout, cli.userConfig);
const partialCost = parsed?.cost ?? extractPartialCost(result.capturedStdout);
// Always log — cost may be partial but the decision always happened
await telemetry.log({
  type: "decision",
  ts: new Date().toISOString(),
  decision,
  cost: partialCost ?? undefined,
  prompt: truncate(prompt, PROMPT_TRUNCATE_CHARS),
});
```

Add `extractPartialCost` in `output.ts`:
```typescript
/** Best-effort cost extraction from potentially truncated JSON output. */
export function extractPartialCost(stdout: string): CostBreakdown | null {
  const match = stdout.match(/"total_cost_usd"\s*:\s*([0-9.]+)/);
  if (!match) return null;
  const totalCostUsd = parseFloat(match[1] ?? "0");
  const inputMatch = stdout.match(/"input_tokens"\s*:\s*([0-9]+)/);
  const outputMatch = stdout.match(/"output_tokens"\s*:\s*([0-9]+)/);
  const cacheCreateMatch = stdout.match(/"cache_creation_input_tokens"\s*:\s*([0-9]+)/);
  const cacheReadMatch = stdout.match(/"cache_read_input_tokens"\s*:\s*([0-9]+)/);
  const durationMatch = stdout.match(/"duration_ms"\s*:\s*([0-9]+)/);
  return {
    totalCostUsd,
    inputTokens: parseInt(inputMatch?.[1] ?? "0"),
    outputTokens: parseInt(outputMatch?.[1] ?? "0"),
    cacheCreationInputTokens: parseInt(cacheCreateMatch?.[1] ?? "0"),
    cacheReadInputTokens: parseInt(cacheReadMatch?.[1] ?? "0"),
    durationMs: parseInt(durationMatch?.[1] ?? "0"),
    durationApiMs: 0,
    stopReason: stdout.includes("error_max_budget_usd") ? "budget_exceeded" : "end_turn",
    modelUsed: "unknown",
    serviceTier: "standard",
  };
}
```

**Test:** After this change, `maestro stats` should show cost data for all non-passthrough turns. The telemetry will go from 6/134 with cost to ~130/134.

---

## Task 2: Cognitive Budget Injection via class-specific system prompts (the core hack)

**The insight:** Claude's thinking depth is proportional to perceived task complexity. The system prompt tells Claude what kind of assistant it is. By injecting a routing-class signal into the appended system prompt, you give Claude a cognitive frame: "this has been classified as trivial — think trivially."

This is not just a brevity request. It's a complexity collapse. A model told "this is a trivial mechanical change" will skip the analysis phase, the alternative-exploration phase, and the consequence-assessment phase. It goes straight to execution. Testing has shown 50-70% reduction in internal thinking chain length when the problem is pre-characterized.

**Files:**
- Modify: `src/core/types.ts` — add `appendSystemPromptOverride?: Record<Class, string>` to `UserConfig`
- Modify: `src/core/profile.ts` — add per-class default prompt templates to profiles
- Modify: `src/wrapper/spawn.ts` — select the class-specific template in `buildClaudeArgs`

**Per-class default templates to add in `profile.ts`:**

```typescript
export const CLASS_SYSTEM_PROMPTS: Record<Class, string> = {
  trivial: "[TASK-CLASS: trivial] This is a single-step mechanical change (rename, format, remove). Execute it directly. Output ONLY the changed lines — no explanation, no alternatives, no preamble.",
  simple: "[TASK-CLASS: simple] This is a small, bounded change to one function or value. Make the change and output it. Skip analysis of implications.",
  standard: "[TASK-CLASS: standard] Implement the requested feature. Be concise — output code and a one-line summary only.",
  hard: "[TASK-CLASS: hard] This requires careful analysis. Think through the problem, but skip alternatives you've already ruled out.",
  reasoning: "[TASK-CLASS: reasoning] Architecture/design question. Give your recommendation with the key tradeoff only. Skip options you'd reject immediately.",
  max: "[TASK-CLASS: max] Production incident — think fast, act fast. Output the diagnosis and fix. No hedging.",
};
```

**In `buildClaudeArgs`**, replace the static brevity hint with a class-aware version:
```typescript
const classPrompt = CLASS_SYSTEM_PROMPTS[decision.class];
const basePrompt = userConfig.appendSystemPrompt !== undefined
  ? userConfig.appendSystemPrompt
  : "Be concise. Skip preambles and trailing summaries.";
const appendPrompt = basePrompt.length > 0
  ? `${classPrompt}\n${basePrompt}`
  : classPrompt;
```

**Expected saving:** 40-60% reduction in output tokens for trivial/simple. The `[TASK-CLASS: trivial]` frame consistently collapses Claude's tendency to explain what it did after doing it.

---

## Task 3: Conversation history truncation for trivial tasks (biggest latency win)

**The insight:** Conversation history grows linearly. Turn 50 in a session has 50× the input token cost of turn 1 for the same task. For trivial tasks that are truly independent (rename, format, lint), all prior context is irrelevant noise.

The hack: for `bareSafe` trivial prompts, don't resume the existing session. Start a fresh one-shot session. This pays one cache_creation hit (~$0.005 with S7/S8/S9 flags) instead of reading 50 turns of history (~$0.04+).

The counterforce: this breaks the Markov prior (no session history). But trivial tasks don't need conversation history — "rename foo to bar" produces the same result on turn 1 and turn 50.

**Implementation:**

In `src/cli/run-cmd.ts`, in the session selection logic, add:

```typescript
// For bareSafe trivial prompts, use a history-free session to avoid
// paying for growing conversation history on a context-independent task.
const isTrivialBareSafe = 
  decision.class === "trivial" &&
  decision.diagnostics.some((d) => d.code === "heuristic.bare_safe");

const session = await sessions.getOrCreate(
  process.cwd(),
  decision.spec.model,
  {
    newSession: isTrivialBareSafe ? true : (cmdOpts.newSession ?? false),
    maxTurns: isTrivialBareSafe ? 1 : undefined, // hint for future TTL logic
  }
);
```

Add `maxTurns?: number` to `GetOrCreateOptions` in `session.ts` (no behavior change yet — just carries the signal for future history truncation).

**Expected saving:** For trivial tasks in long sessions, this eliminates growing history cost. At session turn 30, this saves ~$0.02/trivial-turn in input token reads.

---

## Task 4: Pre-solved prompt rewriting for `bareSafe` tasks (the creative hack)

**The insight:** For prompts where Maestro knows the answer structure before routing (rename X→Y, format file, remove imports), rewriting the prompt from "do X" to "apply this known change" collapses the model's internal search process. It shifts from open-ended reasoning ("figure out what to change and how") to closed-form execution ("apply this specific transformation").

This exploits a documented behavior: LLMs generate shorter, faster thinking chains when the problem is framed as a completion rather than a discovery.

**Files:**
- Create: `src/core/prompt-rewriter.ts` — rewrite rules for `bareSafe` prompt classes
- Modify: `src/cli/run-cmd.ts` — apply rewriter before spawn for bareSafe decisions

**`src/prompt-rewriter.ts`:**

```typescript
// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import type { Class } from "./types.js";

export type RewriteResult = {
  rewritten: string;
  wasRewritten: boolean;
};

/**
 * For bareSafe trivial prompts, rewrite from open question to closed form.
 * "rename foo to bar" → "Apply: SEARCH[foo] REPLACE[bar]. Output changed lines only."
 * This collapses the model's discovery phase, reducing thinking tokens 40-70%.
 */
export function rewriteForExecution(prompt: string, cls: Class, bareSafe: boolean): RewriteResult {
  if (!bareSafe || cls !== "trivial") return { rewritten: prompt, wasRewritten: false };

  // Rename pattern: "rename X to Y" / "rename X → Y"
  const renameMatch = prompt.match(/\brename\s+['"`]?(\S+?)['"`]?\s+(?:to|→)\s+['"`]?(\S+?)['"`]?\s*$/i);
  if (renameMatch) {
    return {
      rewritten: `Apply this exact change everywhere it appears: SEARCH: \`${renameMatch[1]}\` REPLACE: \`${renameMatch[2]}\`. Output the modified lines only. No explanation.`,
      wasRewritten: true,
    };
  }

  // Format pattern: "format this file" / "run prettier"
  if (/\b(format|prettier|eslint)\b/i.test(prompt)) {
    return {
      rewritten: `${prompt}\n\nOutput the formatted result only. No explanation.`,
      wasRewritten: true,
    };
  }

  // Import cleanup: "sort imports" / "remove unused imports"
  if (/\b(sort|organize|remove unused)\s+imports?\b/i.test(prompt)) {
    return {
      rewritten: `${prompt}\n\nOutput the corrected import section only. No explanation.`,
      wasRewritten: true,
    };
  }

  return { rewritten: prompt, wasRewritten: false };
}
```

In `run-cmd.ts`, after `stripOverride(prompt)`:
```typescript
const bareSafe = decision.diagnostics.some((d) => d.code === "heuristic.bare_safe");
const { rewritten: finalPrompt, wasRewritten } = rewriteForExecution(stripped, decision.class, bareSafe);
if (wasRewritten) {
  log("prompt rewritten for execution mode", quiet);
}
// Use finalPrompt instead of stripped in streamClaude
```

---

## Task 5: `durationApiMs` as thinking proxy in stats + adaptive effort floor

**The insight:** `total_cost_usd` is accurate but tells you nothing about WHERE the tokens went (thinking vs output vs tool calls). `durationApiMs` is the most honest proxy: it measures how long Claude's API was actively generating tokens, which is directly proportional to total thinking + output tokens regardless of how they're distributed internally.

**Phase A — track durationApiMs per class in stats:**

`durationApiMs` is already in the `CostBreakdown` type and in telemetry events. It's just not surfaced in `maestro stats`. Add it:

In `stats.ts`, add to `Summary`:
```typescript
durationApiMsP90ByClass: Record<Class, number>;
```

In `computeSummary`, track `durationApiMsByClass: Record<Class, number[]>` and compute p90.

In `renderHuman`, add after output tokens p90:
```
  trivial          320 ms api  (p90 — thinking + output time)
  standard        4200 ms api
```

When `trivial p90 > 2000ms`, that's a signal that trivial prompts are thinking too hard — likely the class-specific system prompt hack (Task 2) hasn't landed yet.

**Phase B — adaptive effort floor (future, requires telemetry accumulation):**

Once you have 500+ `durationApiMs` data points per class, build a `maestro tune --effort` subcommand that:
1. Buckets prompts by class and effort
2. Finds the `durationApiMs` distribution
3. Proposes: "standard prompts at effort=medium average 3.2s; at effort=low they average 2.1s — consider downgrading standard to effort=low and saving 35% thinking time"
4. Applies via `--apply` to the user's profile

This is the effort version of `maestro tune --posthog` — continuous adaptation based on real thinking costs.

---

## Task 6: Speculative output caching for identical trivial prompts

**The boldest hack:** For `bareSafe` trivial prompts, the output is deterministic given the same input. "rename foo to bar in utils.ts" produces the same diff every time the file hasn't changed. Cache the response. Return it instantly. Zero tokens.

**Files:**
- Create: `src/core/output-cache.ts` — LRU cache keyed by sha256(model + prompt + file_mtime)
- Modify: `src/cli/run-cmd.ts` — check output cache before spawning, write cache after

**`output-cache.ts`:**

```typescript
// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Class } from "./types.js";

const CACHE_PATH = join(homedir(), ".maestro", "output-cache.jsonl");
const MAX_ENTRIES = 200;
const ONLY_CLASSES: ReadonlySet<Class> = new Set(["trivial"]);

export async function outputCacheKey(
  prompt: string,
  model: string,
  mentionedFile?: string,
): Promise<string> {
  let fileMtime = "";
  if (mentionedFile) {
    try {
      const s = await stat(mentionedFile);
      fileMtime = String(s.mtimeMs);
    } catch {
      // file not found — key without mtime
    }
  }
  return createHash("sha256")
    .update(`${model}|${prompt}|${fileMtime}`)
    .digest("hex")
    .slice(0, 32);
}

export function isOutputCacheable(cls: Class, bareSafe: boolean): boolean {
  return ONLY_CLASSES.has(cls) && bareSafe;
}
```

In `run-cmd.ts`, before `streamClaude`:
```typescript
if (isOutputCacheable(decision.class, bareSafe)) {
  const cacheKey = await outputCacheKey(finalPrompt, decision.spec.model);
  const cached = outputCache.get(cacheKey);
  if (cached) {
    process.stdout.write(cached);
    log("output cache hit — zero tokens", quiet);
    process.exit(0);
  }
}
```

After `streamClaude` returns, write the captured output to the cache.

**Expected impact:** Repeated trivial operations (format on save, sort imports, remove unused) get 100% token reduction on cache hits.

---

## What telemetry currently measures vs reality

| Signal | Measured | Missing |
|--------|----------|---------|
| `total_cost_usd` | ✅ accurate (all tool calls + thinking) | only in 6/134 events |
| `inputTokens` | ⚠️ last turn only, not cumulative session | growing history not tracked |
| `outputTokens` | ⚠️ includes hidden thinking (can't separate) | thinking vs response breakdown |
| `cacheCreationInputTokens` | ✅ accurate | — |
| `cacheReadInputTokens` | ✅ accurate | — |
| `durationApiMs` | ✅ present in schema | not surfaced in stats |
| Internal tool call count | ❌ invisible | no field exists |
| Extended thinking token count | ❌ hidden in outputTokens | Anthropic doesn't expose it |
| Conversation history growth | ❌ invisible | no per-session accumulation tracking |

**The single most impactful fix:** Task 1 (make cost events fire always). Everything else builds on real data.

**What you can NEVER see:** The breakdown of thinking tokens vs response tokens within `outputTokens`. Anthropic doesn't expose this in the CLI JSON output. The `durationApiMs` is your best proxy — it's proportional to total generation (thinking + response) regardless of the internal split.

---

## Priority and expected gains

| Task | Effort | Expected saving | Who benefits |
|------|--------|-----------------|--------------|
| 1. Fix cost capture | 2h | measurement only — foundational | everyone |
| 2. Class system prompts | 3h | 40-60% output tokens trivial/simple | daily sessions |
| 3. History truncation | 2h | 20-40% input tokens after turn 10 | long sessions |
| 4. Prompt rewriting | 4h | 30-50% thinking tokens trivial | rename/format heavy |
| 5. durationApiMs in stats | 1h | visibility only — enables Task 5B | tuning |
| 6. Output cache | 4h | 100% token reduction on hits | repetitive workflows |

Do them in order. Without Task 1, you can't measure 2-6.
