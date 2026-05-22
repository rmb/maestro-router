# Fast-mode Cost Spike — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Determine if `--fast-mode` has a cost dimension Maestro can exploit. No production code ships until the spike result is confirmed.

**Architecture:** Extend `PreflightResult` to detect `fast_mode_state` from Claude CLI output. Run a controlled comparison script. Document findings. Gate: only proceed to production implementation if cost benefit is confirmed.

**Tech Stack:** TypeScript strict, ESM, Node 20+

---

## Background

Anthropic's Claude CLI exposes a `--fast-mode` flag (and/or `fast_mode_state` in JSON output) whose cost and latency characteristics are undocumented from Maestro's perspective. If `--fast-mode` produces the same output at lower cost or latency for low-complexity prompts, Maestro could selectively apply it on `haiku`-class turns to multiply its existing savings.

This is a spike, not a feature:

- If the spike confirms cost reduction with no quality regression, open a follow-up implementation plan for production integration.
- If the spike shows cost parity, no latency benefit, or quality degradation, add a note to `docs/router-observations.md` and close.
- The spike script itself (`scripts/fast-mode-spike.ts`) is never imported by the production pipeline.

**Gate condition:** Proceed to production integration only if both of the following hold:
1. `total_cost_usd` for the `--fast-mode` run is strictly less than the baseline on at least 3 of 5 prompt pairs.
2. Response quality is subjectively acceptable (no truncation, no refusal, no hallucinated content) on all 5 prompt pairs.

---

## Task 1: Extend `PreflightResult` and preflight parsing

**Files:**
- Modify: `src/wrapper/preflight.ts`
- Modify: `src/wrapper/preflight.test.ts` (assumed to exist; create if not present)

### Step 1.1 — Write failing tests first

- [ ] Add the following tests to `src/wrapper/preflight.test.ts` (or create the file if it does not exist):

```typescript
// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0
// Append to the existing preflight test file, or create it if missing.

import { describe, expect, test } from "vitest";
import { preflight } from "./preflight.js";
import type { SpawnLike } from "./preflight.js";

// ---------------------------------------------------------------------------
// Helpers for fast-mode detection
// ---------------------------------------------------------------------------

function makeSpawn(overrides: {
  version?: string;
  helpText?: string;
  authStatus?: string;
}): SpawnLike {
  return (cmd, args) => {
    if (args.includes("--version")) {
      return { status: 0, stdout: overrides.version ?? "claude 2.1.112\n" };
    }
    if (args.includes("--help")) {
      return {
        status: 0,
        stdout: overrides.helpText ?? [
          "--print",
          "--model",
          "--effort",
          "--max-budget-usd",
          "--session-id",
          "--resume",
          "--output-format",
          "--bare",
          "--exclude-dynamic-system-prompt-sections",
          "--tools",
          "--strict-mcp-config",
          "--mcp-config",
        ].join("\n"),
      };
    }
    if (args.includes("status")) {
      return {
        status: 0,
        stdout: overrides.authStatus ?? JSON.stringify({ authMethod: "claude.ai" }),
      };
    }
    return { status: 0, stdout: "" };
  };
}

describe("preflight — fastModeAvailable detection", () => {
  test("fastModeAvailable is true when --fast-mode appears in --help output", () => {
    const result = preflight({
      spawn: makeSpawn({
        helpText: [
          "--print",
          "--model",
          "--effort",
          "--max-budget-usd",
          "--session-id",
          "--resume",
          "--output-format",
          "--bare",
          "--exclude-dynamic-system-prompt-sections",
          "--tools",
          "--strict-mcp-config",
          "--mcp-config",
          "--fast-mode",
        ].join("\n"),
      }),
    });
    expect(result.fastModeAvailable).toBe(true);
  });

  test("fastModeAvailable is false when --fast-mode is absent from --help output", () => {
    const result = preflight({ spawn: makeSpawn({}) });
    expect(result.fastModeAvailable).toBe(false);
  });

  test("fastModeAvailable is false when preflight fails (binary missing)", () => {
    const result = preflight({
      spawn: (_cmd, _args) => ({ status: 1, stdout: "", error: new Error("not found") }),
    });
    expect(result.fastModeAvailable).toBe(false);
  });

  test("fastModeAvailable is false when help output is empty", () => {
    const result = preflight({
      spawn: makeSpawn({ helpText: "" }),
    });
    // Will fail required-flag check, but fastModeAvailable must not throw or be true.
    expect(result.fastModeAvailable).toBe(false);
  });

  test("ok result still includes fastModeAvailable field", () => {
    const result = preflight({ spawn: makeSpawn({}) });
    expect(result).toHaveProperty("fastModeAvailable");
  });
});
```

### Step 1.2 — Extend `PreflightResult` and preflight logic in `src/wrapper/preflight.ts`

- [ ] Add `fastModeAvailable?: boolean` to the `PreflightResult` type:

```typescript
// In the PreflightResult type, add after the bareSupported field:

/**
 * Whether the Claude CLI `--help` output advertises `--fast-mode`.
 * Populated during flag-verification; false on any early-return path.
 * Used by the fast-mode spike (scripts/fast-mode-spike.ts) and, if the
 * spike confirms cost savings, by a future production integration.
 */
fastModeAvailable?: boolean;
```

- [ ] Update every early-return object literal in `preflight()` to include `fastModeAvailable: false`:

```typescript
// Each early-return block (binary missing, version parse failure, version below min,
// help output failure) must include:
fastModeAvailable: false,
```

- [ ] In the successful help-output parse block, detect `--fast-mode` and populate the field:

```typescript
// After computing `missing` from REQUIRED_FLAGS.filter(...), add:
const fastModeAvailable = helpRes.stdout.includes("--fast-mode");

// Then include it in the ok return:
return {
  ok: true,
  binary,
  version,
  missingFlags: [],
  authMethod: auth.method,
  bareSupported: auth.bareSupported,
  fastModeAvailable,
};
```

- [ ] Also include `fastModeAvailable: false` in the missing-flags early-return:

```typescript
// The missing.length > 0 early return:
return {
  ok: false,
  binary,
  version,
  missingFlags: missing,
  authMethod: "",
  bareSupported: false,
  fastModeAvailable: false,
  reason: `...`,
};
```

### Step 1.3 — Verify

- [ ] `pnpm typecheck` — clean
- [ ] `pnpm lint` — clean
- [ ] `pnpm test src/wrapper/preflight.test.ts` — all tests green including the 5 new ones

### Step 1.4 — Commit

```
preflight: detect --fast-mode availability in PreflightResult
```

---

## Task 2: `scripts/fast-mode-spike.ts` — comparison script

**Files:**
- Create: `scripts/fast-mode-spike.ts`

The script is standalone (not imported by the pipeline). Run it manually:

```
npx tsx scripts/fast-mode-spike.ts
```

### Step 2.1 — Implement `scripts/fast-mode-spike.ts`

- [ ] Create `scripts/fast-mode-spike.ts` with the following content:

```typescript
// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0
//
// Fast-mode cost spike.
// Runs 5 prompt pairs (baseline vs --fast-mode) and compares cost/latency.
//
// Usage:
//   npx tsx scripts/fast-mode-spike.ts [--model <model>] [--confirm-cost]
//
// Requirements:
//   - claude CLI on PATH, authenticated
//   - ANTHROPIC_API_KEY or claude.ai OAuth (--fast-mode may require API key)
//
// Output: structured table to stdout + raw JSON to fast-mode-spike-results.json

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TurnResult = {
  prompt: string;
  mode: "baseline" | "fast-mode";
  model: string;
  totalCostUsd: number | null;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationTokens: number | null;
  cacheReadTokens: number | null;
  response: string;
  error: string | null;
};

type PairResult = {
  promptLabel: string;
  baseline: TurnResult;
  fastMode: TurnResult;
  costDeltaUsd: number | null;
  durationDeltaMs: number | null;
  fastModeIsCheaper: boolean | null;
};

type SpikeOutput = {
  runAt: string;
  model: string;
  fastModeFlag: string;
  fastModeAvailable: boolean;
  pairs: PairResult[];
  summary: {
    totalPairs: number;
    fastModeCheaperCount: number;
    avgCostDeltaUsd: number | null;
    avgDurationDeltaMs: number | null;
    recommendation: string;
  };
};

// ---------------------------------------------------------------------------
// Spike prompts (representative of real Maestro routing targets)
// ---------------------------------------------------------------------------

const SPIKE_PROMPTS: Array<{ label: string; prompt: string }> = [
  {
    label: "short-format",
    prompt: "Format this JSON on one line: { \"a\": 1, \"b\": 2 }",
  },
  {
    label: "rename-symbol",
    prompt: "Rename the variable `foo` to `bar` in this snippet: const foo = 42; console.log(foo);",
  },
  {
    label: "explain-error",
    prompt: "Explain this TypeScript error in one sentence: TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
  },
  {
    label: "list-items",
    prompt: "List the first 5 prime numbers.",
  },
  {
    label: "continuation",
    prompt: "Complete this sentence in 10 words or fewer: The quickest way to reduce token costs is",
  },
];

// ---------------------------------------------------------------------------
// Claude invocation
// ---------------------------------------------------------------------------

function runClaude(
  prompt: string,
  model: string,
  extraArgs: string[],
): { json: Record<string, unknown> | null; durationMs: number; raw: string; error: string | null } {
  const start = Date.now();
  const args = [
    "--print",
    "--model", model,
    "--output-format", "json",
    "--max-budget-usd", "0.50",
    ...extraArgs,
  ];
  const res = spawnSync("claude", args, {
    input: prompt,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 120_000,
  });
  const durationMs = Date.now() - start;
  const raw = typeof res.stdout === "string" ? res.stdout : "";
  if (res.error || res.status !== 0) {
    return {
      json: null,
      durationMs,
      raw,
      error: res.error?.message ?? `exit code ${res.status ?? "?"}`,
    };
  }
  try {
    // Claude --output-format json may emit a stream; find the last JSON object.
    const lastBrace = raw.lastIndexOf("{");
    const slice = raw.slice(lastBrace);
    const json = JSON.parse(slice) as Record<string, unknown>;
    return { json, durationMs, raw, error: null };
  } catch {
    return { json: null, durationMs, raw, error: "could not parse JSON output" };
  }
}

function extractMetrics(
  json: Record<string, unknown> | null,
  durationMs: number,
  error: string | null,
  model: string,
  prompt: string,
  mode: "baseline" | "fast-mode",
): TurnResult {
  if (!json || error) {
    return {
      prompt,
      mode,
      model,
      totalCostUsd: null,
      durationMs,
      inputTokens: null,
      outputTokens: null,
      cacheCreationTokens: null,
      cacheReadTokens: null,
      response: "",
      error: error ?? "no output",
    };
  }

  const usage = json["usage"] as Record<string, unknown> | undefined;
  const modelUsage = json["modelUsage"] as Record<string, Record<string, unknown>> | undefined;

  // Prefer top-level usage; fall back to modelUsage on budget-error.
  let outputTokens = (usage?.["output_tokens"] as number) ?? 0;
  if (!outputTokens && modelUsage) {
    for (const mu of Object.values(modelUsage)) {
      outputTokens += (mu["outputTokens"] as number) ?? 0;
    }
  }

  return {
    prompt,
    mode,
    model,
    totalCostUsd: (json["total_cost_usd"] as number) ?? null,
    durationMs,
    inputTokens: (usage?.["input_tokens"] as number) ?? null,
    outputTokens: outputTokens || null,
    cacheCreationTokens: (usage?.["cache_creation_input_tokens"] as number) ?? null,
    cacheReadTokens: (usage?.["cache_read_input_tokens"] as number) ?? null,
    response: (json["result"] as string) ?? "",
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function detectFastModeFlag(): string | null {
  const help = spawnSync("claude", ["--help"], { encoding: "utf8" });
  if (help.status !== 0) return null;
  if ((help.stdout ?? "").includes("--fast-mode")) return "--fast-mode";
  return null;
}

function estimateCost(pairs: number, model: string): number {
  // Rough estimate: 2 calls per pair, ~$0.05 each on haiku, more on sonnet.
  const perCall = model.includes("haiku") ? 0.05 : model.includes("sonnet") ? 0.08 : 0.12;
  return pairs * 2 * perCall;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const modelArg = args.indexOf("--model");
  const model = modelArg !== -1 ? (args[modelArg + 1] ?? "claude-haiku-4-5") : "claude-haiku-4-5";
  const confirmCost = args.includes("--confirm-cost");

  const fastModeFlag = detectFastModeFlag();
  const fastModeAvailable = fastModeFlag !== null;

  const estimatedCostUsd = estimateCost(SPIKE_PROMPTS.length, model);
  if (estimatedCostUsd > 0.50 && !confirmCost) {
    process.stderr.write(
      `Estimated spike cost: $${estimatedCostUsd.toFixed(3)}. Re-run with --confirm-cost to proceed.\n`,
    );
    process.exit(1);
  }

  if (!fastModeAvailable) {
    process.stdout.write(
      "⚠  --fast-mode not found in `claude --help`. Spike will run both turns without --fast-mode.\n" +
      "   The 'fast-mode' column will reflect identical baseline flags.\n\n",
    );
  }

  process.stdout.write(`Model: ${model}\n`);
  process.stdout.write(`Fast-mode flag: ${fastModeFlag ?? "(not available)"}\n`);
  process.stdout.write(`Prompts: ${SPIKE_PROMPTS.length}\n`);
  process.stdout.write(`Estimated cost: $${estimatedCostUsd.toFixed(3)}\n\n`);

  const pairs: PairResult[] = [];

  for (const { label, prompt } of SPIKE_PROMPTS) {
    process.stdout.write(`  Running pair: ${label}...\n`);

    const baseRun = runClaude(prompt, model, []);
    const baseline = extractMetrics(baseRun.json, baseRun.durationMs, baseRun.error, model, prompt, "baseline");

    const fastArgs = fastModeFlag ? [fastModeFlag] : [];
    const fastRun = runClaude(prompt, model, fastArgs);
    const fastMode = extractMetrics(fastRun.json, fastRun.durationMs, fastRun.error, model, prompt, "fast-mode");

    const costDeltaUsd =
      baseline.totalCostUsd !== null && fastMode.totalCostUsd !== null
        ? fastMode.totalCostUsd - baseline.totalCostUsd
        : null;
    const durationDeltaMs =
      baseline.durationMs !== null && fastMode.durationMs !== null
        ? fastMode.durationMs - baseline.durationMs
        : null;
    const fastModeIsCheaper = costDeltaUsd !== null ? costDeltaUsd < 0 : null;

    pairs.push({ promptLabel: label, baseline, fastMode, costDeltaUsd, durationDeltaMs, fastModeIsCheaper });
  }

  // Summary
  const comparablePairs = pairs.filter((p) => p.fastModeIsCheaper !== null);
  const cheaperCount = pairs.filter((p) => p.fastModeIsCheaper === true).length;
  const avgCostDelta = comparablePairs.length
    ? comparablePairs.reduce((s, p) => s + (p.costDeltaUsd ?? 0), 0) / comparablePairs.length
    : null;
  const avgDurationDelta = comparablePairs.length
    ? comparablePairs.reduce((s, p) => s + (p.durationDeltaMs ?? 0), 0) / comparablePairs.length
    : null;

  let recommendation: string;
  if (!fastModeAvailable) {
    recommendation = "INCONCLUSIVE: --fast-mode not available on this Claude CLI version. Upgrade and re-run.";
  } else if (cheaperCount >= 3) {
    recommendation = `PROCEED: fast-mode was cheaper on ${cheaperCount}/${SPIKE_PROMPTS.length} prompts. Open production integration plan.`;
  } else {
    recommendation = `SKIP: fast-mode was cheaper on only ${cheaperCount}/${SPIKE_PROMPTS.length} prompts. No integration warranted.`;
  }

  const output: SpikeOutput = {
    runAt: new Date().toISOString(),
    model,
    fastModeFlag: fastModeFlag ?? "(not available)",
    fastModeAvailable,
    pairs,
    summary: {
      totalPairs: SPIKE_PROMPTS.length,
      fastModeCheaperCount: cheaperCount,
      avgCostDeltaUsd: avgCostDelta,
      avgDurationDeltaMs: avgDurationDelta,
      recommendation,
    },
  };

  // Print table
  process.stdout.write("\n");
  process.stdout.write("Results:\n");
  process.stdout.write(
    ["Label", "Baseline $", "FastMode $", "Δ cost", "Δ ms", "Cheaper?"]
      .map((h) => h.padEnd(14))
      .join("  ") + "\n",
  );
  process.stdout.write("-".repeat(90) + "\n");
  for (const p of pairs) {
    const row = [
      p.promptLabel.padEnd(14),
      (p.baseline.totalCostUsd?.toFixed(6) ?? "ERR").padEnd(14),
      (p.fastMode.totalCostUsd?.toFixed(6) ?? "ERR").padEnd(14),
      (p.costDeltaUsd != null ? (p.costDeltaUsd >= 0 ? "+" : "") + p.costDeltaUsd.toFixed(6) : "N/A").padEnd(14),
      (p.durationDeltaMs != null ? (p.durationDeltaMs >= 0 ? "+" : "") + p.durationDeltaMs.toFixed(0) + "ms" : "N/A").padEnd(14),
      p.fastModeIsCheaper === true ? "YES" : p.fastModeIsCheaper === false ? "no" : "N/A",
    ];
    process.stdout.write(row.join("  ") + "\n");
  }
  process.stdout.write("\n");
  process.stdout.write(`Recommendation: ${recommendation}\n`);

  // Write raw JSON
  const outPath = join(process.cwd(), "fast-mode-spike-results.json");
  writeFileSync(outPath, JSON.stringify(output, null, 2) + "\n", "utf8");
  process.stdout.write(`\nRaw results written to: ${outPath}\n`);
  process.stdout.write("Copy the relevant findings into docs/router-observations.md.\n");
}

main().catch((err: unknown) => {
  process.stderr.write(`spike: ${(err as Error).message ?? String(err)}\n`);
  process.exit(1);
});
```

### Step 2.2 — Verify the script compiles (no runtime execution needed for this step)

- [ ] `pnpm typecheck` — clean (tsx/ts-node will type-check scripts/ if included in tsconfig)
- [ ] `pnpm lint` — clean

If `scripts/` is not in `tsconfig.json` include paths, either add it or verify manually with:

```bash
npx tsc --noEmit --esModuleInterop --module esnext --moduleResolution bundler --target es2022 --strict scripts/fast-mode-spike.ts
```

### Step 2.3 — Commit

```
add fast-mode-spike: comparison script for --fast-mode cost investigation
```

---

## Task 3: Document spike results template in `docs/router-observations.md`

**Files:**
- Modify: `docs/router-observations.md`

### Step 3.1 — Append the results template

- [ ] Append the following section to the end of `docs/router-observations.md`:

```markdown
## 2026-05-22 · Spike — `--fast-mode` cost investigation

**Status:** PENDING — run `npx tsx scripts/fast-mode-spike.ts --confirm-cost` to fill in results.

**Hypothesis:** `--fast-mode` (if available) reduces `total_cost_usd` for low-complexity
prompts by changing Anthropic's internal serving strategy, without degrading output quality.
Maestro could apply it selectively on `haiku`-class turns to multiply existing savings.

**Method:** `scripts/fast-mode-spike.ts` — 5 representative prompts (format, rename,
explain-error, list, completion) run twice each (baseline vs `--fast-mode`) on a single
model. Metrics captured: `total_cost_usd`, `duration_ms`, token breakdown from
`--output-format json`.

**Gate:** Proceed to production integration only if:
1. `total_cost_usd` is strictly lower for fast-mode on ≥ 3 of 5 prompts.
2. Response quality is acceptable on all 5 (no truncation, no refusal).

**Results:** *(fill in after running the spike)*

| Prompt | Baseline $ | Fast-mode $ | Δ cost | Cheaper? |
|---|---|---|---|---|
| short-format | | | | |
| rename-symbol | | | | |
| explain-error | | | | |
| list-items | | | | |
| continuation | | | | |

**Recommendation:** *(fill in)*

**Action:**
- If PROCEED: open `docs/superpowers/plans/YYYY-MM-DD-fast-mode-production.md` covering
  integration into `src/core/profile.ts` (add `fastMode?: boolean` to `ClassSpec`) and
  `src/wrapper/spawn.ts` (emit `--fast-mode` when flag is set and `PreflightResult.fastModeAvailable` is true).
- If SKIP or INCONCLUSIVE: add one line to `docs/future-ideas.md` and close.
```

### Step 3.2 — Verify

- [ ] `pnpm typecheck` — clean
- [ ] `pnpm lint` — clean
- [ ] `pnpm test` — full suite green (no regressions from Task 1)

### Step 3.3 — Commit

```
docs: add fast-mode spike results template to router-observations
```

---

## Verification gate

- [ ] `pnpm typecheck` clean
- [ ] `pnpm lint` clean
- [ ] `pnpm test` green
- [ ] `PreflightResult.fastModeAvailable` is `false` on current Claude CLI (no `--fast-mode` in help) — confirmed by running the preflight tests
- [ ] `npx tsx scripts/fast-mode-spike.ts` prints the cost estimate and exits with a prompt to pass `--confirm-cost` (safety gate works)
- [ ] `docs/router-observations.md` contains the results template section

## Post-spike decision tree

```
Run: npx tsx scripts/fast-mode-spike.ts --confirm-cost
                  │
     ┌────────────┴──────────────┐
     │                           │
  fast-mode cheaper           fast-mode parity
  on ≥ 3/5 prompts            or more expensive
  AND quality OK                     │
     │                         No integration.
     │                         Add note to
     │                         future-ideas.md.
     ▼
Open production plan:
  - ClassSpec.fastMode?: boolean
  - spawn.ts emits --fast-mode
  - profile.ts sets fastMode on haiku-class
  - bench --propose to verify no regression
```
