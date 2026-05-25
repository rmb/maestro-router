<!-- Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0 -->
# Maestro Oracle — Evaluation Agent Plan

Deep evaluator that audits four dimensions: tool correctness, telemetry correctness,
tokens saved, and output quality. Runs offline against real telemetry + a labelled
replay set. Produces a structured report with pass/fail per dimension and actionable
regressions.

---

## What the oracle evaluates

### 1. Tool correctness

Does each routing decision result in a valid `claude` invocation with the correct flags?

- **Fingerprint stability**: for each `decision` event, reconstruct `computeFingerprint(spec)` from the logged spec and verify it matches the `sessionId` prefix stored in `~/.maestro/sessions.json`. Drift = fingerprint changed but session not rotated.
- **Flag coverage**: parse the `modelUsed`, `effort`, and `tools` from the telemetry `cost` field; verify they match `decision.spec`. Mismatches surface `spawn.ts` bugs.
- **E1.escalate correctness**: for `decision` events where `decidedClass=standard` and the preceding turn has `stopReason=max_tokens`, verify the following turn's effort is `medium` not `low`.
- **K1 cache correctness**: for pairs of identical prompts within 24h, verify both produced the same `class`. If the second was a cache hit (`classifier: "k1-cache"`), verify the spec matches the first decision's spec. Invalidation test: if the first pair's outcome was `max_tokens`, verify the second re-classified (no cache hit).
- **M1 two-signal correctness**: extract all turns where `appendSystemPrompt` contains `CONTINUATION_HINT`. Verify: (a) the prior turn had `stopReason=max_tokens`, (b) the prompt matched a linguistic continuation pattern. Flag any CONTINUATION_HINT injected without both signals.

### 2. Telemetry correctness

Is what Maestro logs actually what happened?

- **Cost reconciliation**: sum `cost.totalCostUsd` across all `decision` events in a window. Compare to `maestro stats` output. Tolerance: ±1%. Divergence = aggregation bug in `stats.ts`.
- **Fallback rate accuracy**: count events where `decision.classifier === "forced.standard"` and where `decision.classifier === "default"` (legacy). Verify `maestro stats --json` `fallbackRate` matches. The old "default" classifier name should now be zero in production.
- **Cache hit rate accuracy**: count events where `decision.cacheHit === true`. Verify matches `maestro stats --json` `cacheHitRate`. Cross-check: `cacheReadInputTokens > 0` in the same event implies cache hit; flag discrepancies.
- **Session boot ratio**: sum `cost.cacheCreationInputTokens * inputCostPerToken` per event; express as fraction of total cost. Verify matches health snapshot `cacheCreationRatio`. Flag if session boot ratio drops but fingerprintSessionCount did not increase (Track Z not firing).
- **Outcome linkage**: every `outcome` event has a `sessionId`. Verify ≥90% link to a `decision` event within ±60s and same `sessionId`. Unlinked outcomes = Stop-hook firing without a corresponding decision (wrapper bypass).

### 3. Tokens saved

Real before/after comparison, not estimates.

- **Baseline construction**: for each `decision` event in the evaluation window, compute the counterfactual: "what would this call have cost at Opus max effort?" using published Anthropic pricing and the event's actual `inputTokens + outputTokens + cacheReadInputTokens`. Sum across all events → `hypotheticalOpusCost`.
- **Actual cost**: sum `cost.totalCostUsd` → `actualCost`.
- **Savings pct**: `(hypotheticalOpusCost - actualCost) / hypotheticalOpusCost`. Gate: ≥60%. Below gate = regression, report which class migration changed.
- **E1 savings isolation**: filter to `decidedClass=standard, effort=low` events. Compare their avg cost to historical `effort=medium` events from before E1 (use baseline timestamp). Expected: 60–80% reduction on thinking tokens.
- **Track Z savings isolation**: compute session boots before/after. Count distinct `sessionId` rotations per unique `cwd` per day. Before Track Z: rotations ≈ class_transitions. After: rotations ≈ fingerprint_transitions (should be lower). Compute avoided `cache_creation` cost.
- **X savings isolation**: filter to `decidedClass=standard`. Compute output token distribution before/after X (split by date). Gate: p90 ≤ 8000 after X, was >10000 before.

### 4. Output quality

Do cheaper models / lower effort produce acceptable answers?

- **Replay correctness on eval set** (`src/eval/`): run `maestro bench` against the locked eval set using the current routing. Compare accuracy to the `bench --propose` baseline locked at commit `f302f74`. Gate: ≤2% regression.
- **E1 quality probe**: run a tournament sample (n=50) of `standard`-class prompts at `effort=low` vs `effort=medium`. Judge with Sonnet. Expected: B-win (low effort) ≥60% of ties/A-wins. Below 60% = E1 is hurting quality, recommend reverting standard to medium for hard sub-types.
- **X output truncation probe**: scan `decision` events where `cost.outputTokens >= spec.maxOutputTokens * 0.98` (within 2% of cap). These are likely truncated. Compute truncation rate. Gate: <5% of standard turns hit the cap. Above 5% = cap too tight.
- **M1 continuation quality probe**: sample 20 CONTINUATION_HINT-injected turns. Manually or judge-LLM-score whether the response correctly resumed vs restarted. Gate: ≥80% correct resumes.

---

## Implementation plan

### Phase 1 — Data collection layer (src/eval/oracle/)

**`oracle/reader.ts`** — telemetry reader
- `loadWindow(path, sinceMs): TelemetryEvent[]` — reads decisions.jsonl, filters by window
- `groupBySession(events): Map<sessionId, TelemetryEvent[]>` — groups for linkage checks
- `pairDecisionsWithOutcomes(events): Array<{decision, outcome}>` — ±60s join

**`oracle/tool-correctness.ts`**
- `checkFingerprintStability(events, sessionsPath): ToolCorrectnessResult`
- `checkFlagCoverage(events): ToolCorrectnessResult`
- `checkE1Escalation(events): ToolCorrectnessResult`
- `checkK1Invalidation(events): ToolCorrectnessResult`
- `checkM1TwoSignal(events): ToolCorrectnessResult`

**`oracle/telemetry-correctness.ts`**
- `checkCostReconciliation(events, statsPath): TelemetryCorrectnessResult`
- `checkFallbackRateAccuracy(events, statsPath): TelemetryCorrectnessResult`
- `checkCacheHitRateAccuracy(events, statsPath): TelemetryCorrectnessResult`
- `checkOutcomeLinkage(events): TelemetryCorrectnessResult`

**`oracle/tokens-saved.ts`**
- `computeSavings(events, pricing): TokenSavingsResult`
- `isolateE1Savings(events, baselineDate): TokenSavingsResult`
- `isolateTrackZSavings(events, baselineDate): TokenSavingsResult`
- `isolateXSavings(events, baselineDate): TokenSavingsResult`

**`oracle/output-quality.ts`**
- `runBenchAccuracy(evalPath, spawn): QualityResult` — wraps `bench` programmatically
- `runE1TournamentProbe(events, n, spawn): QualityResult` — samples + tournament
- `checkTruncationRate(events): QualityResult`

**`oracle/report.ts`**
- `buildReport(results): OracleReport` — assembles all four dimensions
- `printReport(report, opts): void` — human-readable tabular output
- Exits with code 1 if any gate fails

### Phase 2 — CLI command

**`src/cli/oracle.ts`** — `maestro oracle`

```
maestro oracle                          # full evaluation, last 7 days
maestro oracle --since 30               # extend window
maestro oracle --dimension tool         # single-dimension run
maestro oracle --dimension telemetry
maestro oracle --dimension tokens
maestro oracle --dimension quality
maestro oracle --quality-sample 50      # E1 tournament probe size (costs money)
maestro oracle --confirm-cost           # required for quality probes that spawn models
maestro oracle --json                   # machine-readable output
maestro oracle --baseline <path>        # compare against a specific health baseline
```

### Phase 3 — CI integration

GitHub Actions workflow `oracle.yml`:
1. `maestro oracle --dimension tool --dimension telemetry --json` (zero cost, runs on every push)
2. `maestro oracle --dimension tokens` (reads telemetry only, zero cost)
3. Weekly: `maestro oracle --dimension quality --quality-sample 20 --confirm-cost` (costs ~$2)

Exit code 1 blocks merge if any gate fails.

---

## Data types

```typescript
type DimensionResult = {
  dimension: "tool" | "telemetry" | "tokens" | "quality";
  pass: boolean;
  checks: CheckResult[];
};

type CheckResult = {
  name: string;
  pass: boolean;
  value: number | string;
  gate?: string;         // e.g. "≥60%", "<5%"
  detail?: string;       // actionable: what to fix and where
};

type OracleReport = {
  generatedAt: string;
  windowDays: number;
  totalEvents: number;
  dimensions: DimensionResult[];
  overallPass: boolean;
};
```

---

## Implementation order

1. `oracle/reader.ts` + tests (pure, no deps)
2. `oracle/telemetry-correctness.ts` + tests (reads only existing data)
3. `oracle/tool-correctness.ts` + tests (reads sessions.json + decisions.jsonl)
4. `oracle/tokens-saved.ts` + tests (computation only)
5. `oracle/report.ts` + tests
6. `src/cli/oracle.ts` (wires all four + --json + exit codes)
7. `oracle/output-quality.ts` (needs spawn injection — implement last, most expensive)

Total: ~7 modules, ~600 lines of new code, zero new runtime deps.
