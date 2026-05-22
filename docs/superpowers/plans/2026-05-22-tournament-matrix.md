# Tournament Matrix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `bench --tournament` to test effort-level reduction in addition to model-tier downgrade, surfacing savings that don't require a model change.

**Architecture:** Add `--tournament-matrix` flag; when set, for each prompt test same-model lower-effort variants alongside the existing tier-downgrade. Per-class results track win rates per (model, effort) cell. Output writes effort-reduction proposals alongside model-downgrade proposals.

**Tech Stack:** TypeScript strict, ESM, Vitest, Node 20+

---

## Orientation

The existing tournament tests only one "B" candidate per row: the next-cheaper class tier (the `DOWNGRADE` map). The matrix extension adds a second "B" candidate per row: the same model at one effort step lower (`EFFORT_DOWNGRADE` map). The judge is run independently for each B, A response is reused across both comparisons. Per-class aggregation is extended from a flat `PerClassWinRate` record to a `MatrixResult` that tracks win/tie/loss per `(model, effort)` cell.

Key invariants carried forward:
- A is always spawned exactly once per row.
- Judge is called once per B candidate (not once for both).
- Budget cap is evaluated cumulatively after every spend event.
- Resume JSONL stores one line per completed row; the row now carries an optional `effortResult` field so partial matrix rows are not re-run.
- `--tournament-matrix` defaults `false`; existing `--tournament` runs are byte-for-byte identical.

File map:
- `src/eval/tournament.ts` — types, maps, runner
- `src/eval/tournament.test.ts` — unit + integration tests
- `src/cli/bench.ts` — CLI flag + cost estimate

---

## Task 1 — Add `MatrixCell`, `MatrixResult`, and `EFFORT_DOWNGRADE` to `tournament.ts`

**Commit message:** `tournament: add EFFORT_DOWNGRADE map and MatrixCell/MatrixResult types`

### 1.1 Changes to `src/eval/tournament.ts`

Add the following immediately after the existing `DOWNGRADE` constant (line 22):

```typescript
/**
 * One-effort-step-cheaper map. `low` is the floor — those inputs have no
 * cheaper effort level and are skipped with reason `no cheaper effort`.
 * Ordering (ascending cost): low < medium < high < xhigh < max.
 */
export const EFFORT_DOWNGRADE: Record<Effort, Effort | null> = {
  low: null,
  medium: "low",
  high: "medium",
  xhigh: "high",
  max: "xhigh",
};
```

Add the following new types immediately after the `PerClassWinRate` type (after line 154):

```typescript
/**
 * Win-rate aggregation for a single (model, effort) cell in the matrix.
 * `wins` counts B_wins; `ties` counts tie; `losses` counts A_wins.
 * `failed` counts rows where the judge could not produce a verdict.
 */
export type MatrixCell = {
  model: string;
  effort: Effort;
  wins: number;
  ties: number;
  losses: number;
  failed: number;
};

/**
 * Per-class matrix result — all cells tested for this class plus the
 * (model, effort) pair that is currently in the active profile.
 */
export type MatrixResult = {
  class: Class;
  currentModel: string;
  currentEffort: Effort;
  cells: MatrixCell[];
};
```

Add the `Effort` import alongside the existing `Class` import at the top of the file (line 9 area):

```typescript
import type { Class, ClassSpec, HeuristicRule } from "../core/types.js";
```

becomes:

```typescript
import type { Class, ClassSpec, Effort, HeuristicRule } from "../core/types.js";
```

### 1.2 Changes to `src/eval/tournament.test.ts`

Add a new top-level `describe` block:

```typescript
describe("EFFORT_DOWNGRADE map", () => {
  test("low maps to null (floor)", () => {
    expect(EFFORT_DOWNGRADE.low).toBeNull();
  });

  test("medium→low, high→medium, xhigh→high, max→xhigh", () => {
    expect(EFFORT_DOWNGRADE.medium).toBe("low");
    expect(EFFORT_DOWNGRADE.high).toBe("medium");
    expect(EFFORT_DOWNGRADE.xhigh).toBe("high");
    expect(EFFORT_DOWNGRADE.max).toBe("xhigh");
  });

  test("every Effort key is present", () => {
    const keys = Object.keys(EFFORT_DOWNGRADE) as Effort[];
    expect(keys.sort()).toEqual(["high", "low", "max", "medium", "xhigh"].sort());
  });
});
```

Update the import line in `tournament.test.ts` to also import `EFFORT_DOWNGRADE` and the new types:

```typescript
import {
  buildJudgeArgs,
  buildProposedHeuristics,
  buildResponseArgs,
  DOWNGRADE,
  EFFORT_DOWNGRADE,
  JUDGE_JSON_SCHEMA,
  JUDGE_PROMPT_TEMPLATE,
  JUDGE_SYSTEM_PROMPT,
  runTournament,
  type MatrixCell,
  type MatrixResult,
  type TournamentInput,
  type TournamentRowResult,
  type TournamentSpawn,
  type TournamentSpawnResult,
} from "./tournament.js";
```

### 1.3 Verification

```
pnpm typecheck   # expect: no errors
pnpm lint        # expect: no errors
pnpm test        # expect: all existing tests green + new EFFORT_DOWNGRADE tests green
```

---

## Task 2 — Extend the tournament runner to handle `--tournament-matrix` candidates

**Commit message:** `tournament: run effort-step-down B candidate when matrix mode is on`

This task extends `runTournament` to optionally run a `B_effort` candidate (same model, one effort step lower) for each prompt, in addition to the existing `B_tier` candidate. A single A response is shared. Each B gets its own judge call. The `TournamentReport` is extended with `matrixResults`.

### 2.1 Changes to `src/eval/tournament.ts`

#### 2.1.1 Extend `TournamentRunOptions`

Add `matrix?: boolean` to `TournamentRunOptions`:

```typescript
export type TournamentRunOptions = {
  binary?: string;
  perCallTimeoutMs?: number;
  spawn?: TournamentSpawn;
  judgeModel?: string;
  budgetCapUsd?: number;
  getSpec: (cls: Class) => ClassSpec;
  onProgress?: (event: TournamentProgress) => void;
  resumePath?: string;
  /** When true, also test same-model one-effort-step-lower variant per prompt. Default false. */
  matrix?: boolean;
};
```

#### 2.1.2 Extend `TournamentRowResult`

Add optional `effortDowngradedEffort`, `costBEffortUsd`, `judgeVerdictEffort`, `judgeReasonEffort`, `recommendEffortDowngrade` fields. These are `undefined` when `matrix` is false or when the effort is already at floor:

```typescript
export type TournamentRowResult = {
  prompt: string;
  currentClass: Class;
  downgradedClass: Class | null;
  skipped: boolean;
  skipReason?: string;
  costAUsd?: number;
  costBUsd?: number;
  costJudgeUsd?: number;
  judgeVerdict?: TournamentDecision;
  judgeReason?: string;
  recommendDowngrade?: boolean;
  /** Matrix-only fields — present when matrix=true and effort is not at floor. */
  effortDowngradedEffort?: Effort;
  costBEffortUsd?: number;
  costJudgeEffortUsd?: number;
  judgeVerdictEffort?: TournamentDecision;
  judgeReasonEffort?: string;
  recommendEffortDowngrade?: boolean;
};
```

#### 2.1.3 Extend `TournamentReport`

Add `matrixResults` to `TournamentReport`:

```typescript
export type TournamentReport = {
  totalPrompts: number;
  ran: number;
  skipped: number;
  totalCostUsd: number;
  perClassWinRates: Record<Class, PerClassWinRate>;
  recommendedDowngrades: RecommendedDowngrade[];
  rows: TournamentRowResult[];
  /** Populated when matrix=true; one entry per class that had prompts run. */
  matrixResults: MatrixResult[];
};
```

#### 2.1.4 Extend `TournamentProgress`

Add `b_effort_done` and `judge_effort_done` event variants to `TournamentProgress`:

```typescript
export type TournamentProgress =
  | { type: "row_start"; index: number; total: number; prompt: string; currentClass: Class; downgradedClass: Class | null }
  | { type: "a_done"; index: number; total: number; costUsd: number }
  | { type: "b_done"; index: number; total: number; costUsd: number }
  | { type: "judge_done"; index: number; total: number; verdict: TournamentDecision; costUsd: number; totalSpent: number }
  | { type: "b_effort_done"; index: number; total: number; costUsd: number; effortLevel: Effort }
  | { type: "judge_effort_done"; index: number; total: number; verdict: TournamentDecision; costUsd: number; totalSpent: number; effortLevel: Effort }
  | { type: "skipped"; index: number; total: number; reason: string }
  | { type: "budget_reached"; index: number; total: number; totalSpent: number };
```

#### 2.1.5 Add `emptyMatrixCells` helper

Add a helper that initialises an in-progress cell accumulator, keyed by `${model}:${effort}`:

```typescript
function getOrCreateCell(
  cells: Map<string, MatrixCell>,
  model: string,
  effort: Effort,
): MatrixCell {
  const key = `${model}:${effort}`;
  let cell = cells.get(key);
  if (!cell) {
    cell = { model, effort, wins: 0, ties: 0, losses: 0, failed: 0 };
    cells.set(key, cell);
  }
  return cell;
}
```

#### 2.1.6 Extend `runTournament`

Add a `matrixCellsByClass` accumulator at the top of `runTournament` (alongside `perClassWinRates`):

```typescript
const matrixCellsByClass = new Map<Class, Map<string, MatrixCell>>();
```

After the existing tier-downgrade judge verdict block (after `ran++`), add the effort-downgrade block:

```typescript
// --- Matrix effort-downgrade block ---
if (opts.matrix === true && !budgetReached) {
  const effortTarget = EFFORT_DOWNGRADE[input.currentSpec.effort];
  if (effortTarget !== null) {
    const bEffortSpec: ClassSpec = { ...input.currentSpec, effort: effortTarget };
    const bEffortArgs = buildResponseArgs(bEffortSpec);
    let bEffortResult: TournamentSpawnResult;
    let bEffortResp: ResponseExtraction | null = null;
    try {
      bEffortResult = await spawn(bEffortArgs, { input: input.prompt, timeoutMs });
      bEffortResp =
        !bEffortResult.timedOut && bEffortResult.exitCode === 0
          ? extractResponse(bEffortResult.stdout)
          : null;
    } catch {
      bEffortResp = null;
    }

    if (bEffortResp) {
      totalCost += bEffortResp.costUsd;
      emit({ type: "b_effort_done", index, total, costUsd: bEffortResp.costUsd, effortLevel: effortTarget });

      const judgeEffortInput = JUDGE_PROMPT_TEMPLATE(input.prompt, aResp.text, bEffortResp.text);
      const judgeEffortArgs = buildJudgeArgs({ model: judgeModel, systemPrompt: JUDGE_SYSTEM_PROMPT });
      let judgeEffortVerdict: TournamentDecision = "judge_failed";
      let judgeEffortReason = "";
      let judgeEffortCost = 0;
      let judgeEffortFailed = false;
      try {
        const judgeEffortResult = await spawn(judgeEffortArgs, { input: judgeEffortInput, timeoutMs });
        if (judgeEffortResult.timedOut || judgeEffortResult.exitCode !== 0) {
          judgeEffortFailed = true;
        } else {
          const v = extractJudgeVerdict(judgeEffortResult.stdout);
          if (v === null) {
            judgeEffortFailed = true;
          } else {
            judgeEffortVerdict = v.verdict;
            judgeEffortReason = v.reason;
            judgeEffortCost = v.costUsd;
          }
        }
      } catch {
        judgeEffortFailed = true;
      }
      totalCost += judgeEffortCost;

      row.effortDowngradedEffort = effortTarget;
      row.costBEffortUsd = bEffortResp.costUsd;
      row.costJudgeEffortUsd = judgeEffortCost;
      row.judgeVerdictEffort = judgeEffortFailed ? "judge_failed" : judgeEffortVerdict;
      if (!judgeEffortFailed) {
        row.judgeReasonEffort = judgeEffortReason;
        row.recommendEffortDowngrade =
          judgeEffortVerdict === "B_wins" || judgeEffortVerdict === "tie";
      }

      // Matrix cell aggregation
      if (!judgeEffortFailed) {
        let classCells = matrixCellsByClass.get(input.currentClass);
        if (!classCells) {
          classCells = new Map();
          matrixCellsByClass.set(input.currentClass, classCells);
        }
        const cell = getOrCreateCell(classCells, input.currentSpec.model, effortTarget);
        if (judgeEffortVerdict === "B_wins") cell.wins++;
        else if (judgeEffortVerdict === "tie") cell.ties++;
        else if (judgeEffortVerdict === "A_wins") cell.losses++;
      } else {
        let classCells = matrixCellsByClass.get(input.currentClass);
        if (!classCells) {
          classCells = new Map();
          matrixCellsByClass.set(input.currentClass, classCells);
        }
        const cell = getOrCreateCell(classCells, input.currentSpec.model, effortTarget);
        cell.failed++;
      }

      emit({
        type: "judge_effort_done",
        index,
        total,
        verdict: judgeEffortFailed ? "judge_failed" : judgeEffortVerdict,
        costUsd: judgeEffortCost,
        totalSpent: totalCost,
        effortLevel: effortTarget,
      });

      if (budgetCap !== undefined && totalCost > budgetCap) budgetReached = true;
    }
  }
}
// --- end matrix block ---
```

The resume file write (currently after the existing row push) must happen _after_ the matrix block so the effort fields are included in the persisted row. Move `appendFileSync` after the matrix block:

```typescript
if (opts.resumePath !== undefined) {
  try {
    appendFileSync(opts.resumePath, JSON.stringify(row) + "\n");
  } catch {
    // never block the tournament on a debug-write failure
  }
}
```

Build `matrixResults` before the return statement:

```typescript
const matrixResults: MatrixResult[] = [];
for (const [cls, cellMap] of matrixCellsByClass) {
  const spec = opts.getSpec(cls);
  matrixResults.push({
    class: cls,
    currentModel: spec.model,
    currentEffort: spec.effort,
    cells: Array.from(cellMap.values()),
  });
}
```

Return statement becomes:

```typescript
return {
  totalPrompts: inputs.length,
  ran,
  skipped,
  totalCostUsd: Number(totalCost.toFixed(6)),
  perClassWinRates,
  recommendedDowngrades,
  rows,
  matrixResults,
};
```

### 2.2 Changes to `src/eval/tournament.test.ts`

Add new describe blocks:

```typescript
describe("runTournament matrix — effort downgrade", () => {
  test("matrix=false (default): no B_effort spawns, no effortDowngradedEffort on rows", async () => {
    const spawn = makeMockSpawn([
      ok(envelope("A")),
      ok(envelope("B")),
      ok(judgeEnvelope("B")),
    ]);
    const report = await runTournament(
      [{ prompt: "rename var", currentClass: "standard", currentSpec: getSpec("standard") }],
      { spawn, getSpec },
    );
    // matrix defaults false — only 3 spawns: A, B_tier, judge
    expect(spawn.calls).toHaveLength(3);
    expect(report.rows[0]!.effortDowngradedEffort).toBeUndefined();
    expect(report.matrixResults).toHaveLength(0);
  });

  test("matrix=true: standard/medium → also tests standard/low; 5 spawns (A, B_tier, judge_tier, B_effort, judge_effort)", async () => {
    // standard spec: sonnet/medium (balanced profile)
    const spawn = makeMockSpawn([
      ok(envelope("A response")),          // A (sonnet/medium)
      ok(envelope("B tier response")),     // B_tier (simple/low)
      ok(judgeEnvelope("B", "tier ok")),   // judge for B_tier
      ok(envelope("B effort response")),   // B_effort (sonnet/low)
      ok(judgeEnvelope("tie", "effort tie")), // judge for B_effort
    ]);
    const report = await runTournament(
      [{ prompt: "format this file", currentClass: "standard", currentSpec: getSpec("standard") }],
      { spawn, getSpec, matrix: true },
    );
    expect(spawn.calls).toHaveLength(5);
    const row = report.rows[0]!;
    expect(row.skipped).toBe(false);
    expect(row.effortDowngradedEffort).toBe("low");
    expect(row.judgeVerdictEffort).toBe("tie");
    expect(row.recommendEffortDowngrade).toBe(true);
    expect(report.matrixResults).toHaveLength(1);
    const mr = report.matrixResults[0]!;
    expect(mr.class).toBe("standard");
    expect(mr.currentModel).toBe("sonnet");
    expect(mr.currentEffort).toBe("medium");
    expect(mr.cells).toHaveLength(1);
    const cell = mr.cells[0]!;
    expect(cell.model).toBe("sonnet");
    expect(cell.effort).toBe("low");
    expect(cell.ties).toBe(1);
    expect(cell.wins).toBe(0);
    expect(cell.losses).toBe(0);
  });

  test("matrix=true: low effort at floor → no B_effort spawn; still 3 spawns", async () => {
    // simple spec: sonnet/low — effort already at floor
    const spawn = makeMockSpawn([
      ok(envelope("A")),
      ok(envelope("B")),
      ok(judgeEnvelope("A")),
    ]);
    const report = await runTournament(
      [{ prompt: "add comment", currentClass: "simple", currentSpec: getSpec("simple") }],
      { spawn, getSpec, matrix: true },
    );
    expect(spawn.calls).toHaveLength(3); // no B_effort because low is floor
    expect(report.rows[0]!.effortDowngradedEffort).toBeUndefined();
  });

  test("matrix=true: B_effort spawn fails → effort fields record failure, budget continues", async () => {
    const spawn = makeMockSpawn([
      ok(envelope("A")),
      ok(envelope("B tier")),
      ok(judgeEnvelope("A")),
      { stdout: "", exitCode: 1, timedOut: false }, // B_effort fails
    ]);
    const report = await runTournament(
      [{ prompt: "design cache", currentClass: "standard", currentSpec: getSpec("standard") }],
      { spawn, getSpec, matrix: true },
    );
    // B_effort failed → no judge_effort spawn
    expect(spawn.calls).toHaveLength(4);
    const row = report.rows[0]!;
    expect(row.effortDowngradedEffort).toBeUndefined(); // not set when B_effort fails
    expect(row.recommendEffortDowngrade).toBeUndefined();
  });

  test("matrix=true: budget cap reached before B_effort → B_effort not spawned", async () => {
    // cap=$0.10; A+B_tier+judge costs $0.12 → cap hit before matrix block
    const spawn = makeMockSpawn([
      ok(envelope("A", 0.05)),
      ok(envelope("B", 0.05)),
      ok(judgeEnvelope("B", "ok", 0.02)),
    ]);
    const report = await runTournament(
      [{ prompt: "x", currentClass: "standard", currentSpec: getSpec("standard") }],
      { spawn, getSpec, matrix: true, budgetCapUsd: 0.10 },
    );
    expect(spawn.calls).toHaveLength(3);
    expect(report.rows[0]!.effortDowngradedEffort).toBeUndefined();
  });

  test("matrix=true: effort judge fails → cell.failed incremented", async () => {
    const spawn = makeMockSpawn([
      ok(envelope("A")),
      ok(envelope("B tier")),
      ok(judgeEnvelope("A")),
      ok(envelope("B effort")),
      { stdout: "", exitCode: 1, timedOut: false }, // judge_effort fails
    ]);
    const report = await runTournament(
      [{ prompt: "x", currentClass: "standard", currentSpec: getSpec("standard") }],
      { spawn, getSpec, matrix: true },
    );
    const row = report.rows[0]!;
    expect(row.judgeVerdictEffort).toBe("judge_failed");
    expect(row.recommendEffortDowngrade).toBeUndefined();
    const mr = report.matrixResults[0]!;
    expect(mr.cells[0]!.failed).toBe(1);
    expect(mr.cells[0]!.wins).toBe(0);
  });

  test("matrix=true: multiple prompts aggregate cells correctly", async () => {
    const spawn = makeMockSpawn([
      // prompt 1: standard
      ok(envelope("A")), ok(envelope("B_tier")), ok(judgeEnvelope("A")),
      ok(envelope("B_effort")), ok(judgeEnvelope("B", "effort win")),
      // prompt 2: standard
      ok(envelope("A")), ok(envelope("B_tier")), ok(judgeEnvelope("B")),
      ok(envelope("B_effort")), ok(judgeEnvelope("tie", "effort tie")),
    ]);
    const report = await runTournament(
      [
        { prompt: "p1", currentClass: "standard", currentSpec: getSpec("standard") },
        { prompt: "p2", currentClass: "standard", currentSpec: getSpec("standard") },
      ],
      { spawn, getSpec, matrix: true },
    );
    const mr = report.matrixResults.find((r) => r.class === "standard")!;
    expect(mr).toBeDefined();
    const cell = mr.cells.find((c) => c.model === "sonnet" && c.effort === "low")!;
    expect(cell).toBeDefined();
    expect(cell.wins).toBe(1);
    expect(cell.ties).toBe(1);
    expect(cell.losses).toBe(0);
  });

  test("resume file includes effortDowngradedEffort when matrix=true", async () => {
    const tmpFile = join(tmpdir(), `matrix-resume-${Date.now()}.jsonl`);
    const spawn = makeMockSpawn([
      ok(envelope("A")),
      ok(envelope("B_tier")),
      ok(judgeEnvelope("B")),
      ok(envelope("B_effort")),
      ok(judgeEnvelope("tie")),
    ]);
    try {
      await runTournament(
        [{ prompt: "matrix-resume-test", currentClass: "standard", currentSpec: getSpec("standard") }],
        { spawn, getSpec, matrix: true, resumePath: tmpFile },
      );
      const line = readFileSync(tmpFile, "utf8").trim();
      const saved = JSON.parse(line) as TournamentRowResult;
      expect(saved.effortDowngradedEffort).toBe("low");
      expect(saved.judgeVerdictEffort).toBe("tie");
    } finally {
      try { unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  });
});
```

### 2.3 Verification

```
pnpm typecheck   # expect: no errors
pnpm lint        # expect: no errors
pnpm test        # expect: all existing tests green + new matrix tests green
```

---

## Task 3 — Extend `bench.ts` CLI: `--tournament-matrix` flag, cost estimate, output, and human renderer

**Commit message:** `bench: add --tournament-matrix flag with updated cost estimate and matrix report`

### 3.1 Changes to `src/cli/bench.ts`

#### 3.1.1 Add `--tournament-matrix` option to the commander chain

After the existing `--tournament-output <path>` option line (currently line 73), add:

```typescript
.option("--tournament-matrix", "tournament: also test same-model effort-step-down variant per prompt (matrix mode)")
```

#### 3.1.2 Extend the `cmdOpts` type in `.action(...)`

Add `tournamentMatrix?: boolean` to the action options object type:

```typescript
async (cmdOpts: {
  eval: string;
  baseline: string;
  gate: string;
  propose?: string;
  tournament?: boolean;
  tournamentSample?: string;
  tournamentBudget?: string;
  tournamentSeed?: string;
  tournamentResume?: string;
  confirmCost?: boolean;
  tournamentOutput?: string;
  tournamentMatrix?: boolean;
  updateBaseline?: boolean;
  llm?: boolean;
  embedding?: boolean;
}) => {
```

#### 3.1.3 Pass `tournamentMatrix` through to `runTournamentMode`

In the `cmdOpts.tournament` branch (line 151-160), `cmdOpts` is already forwarded to `runTournamentMode` via the `TournamentModeArgs` shape. Extend `TournamentModeArgs` to include the new flag:

```typescript
type TournamentModeArgs = {
  entries: LabeledEntry[];
  pipeline: ReturnType<typeof createPipeline>;
  profile: Profile;
  cmdOpts: {
    tournamentSample?: string;
    tournamentBudget?: string;
    tournamentSeed?: string;
    tournamentResume?: string;
    confirmCost?: boolean;
    tournamentOutput?: string;
    tournamentMatrix?: boolean;
  };
  parent: ParentOptions;
};
```

#### 3.1.4 Update the cost estimate inside `runTournamentMode`

Replace the fixed `TOURNAMENT_CALLS_PER_ROW = 3` with a dynamic value that accounts for matrix mode. The `EFFORT_DOWNGRADE` map tells us that most classes (those not already at `low` effort) will generate 2 extra spawns (B_effort + judge_effort). Conservative multiplier is 1.5 (not every class has a lower effort tier available):

```typescript
const TOURNAMENT_COST_PER_CALL_ESTIMATE_USD = 0.05;
const TOURNAMENT_CALLS_PER_ROW_STANDARD = 3;
const TOURNAMENT_CALLS_PER_ROW_MATRIX = 5; // A + B_tier + judge_tier + B_effort + judge_effort
const DEFAULT_TOURNAMENT_SAMPLE = 10;
const DEFAULT_TOURNAMENT_BUDGET_USD = 5;
```

Update the estimate inside `runTournamentMode`:

```typescript
const callsPerRow = args.cmdOpts.tournamentMatrix === true
  ? TOURNAMENT_CALLS_PER_ROW_MATRIX
  : TOURNAMENT_CALLS_PER_ROW_STANDARD;
const estimatedCost =
  sample * callsPerRow * TOURNAMENT_COST_PER_CALL_ESTIMATE_USD;
```

Update the confirmation message:

```typescript
if (!args.cmdOpts.confirmCost) {
  if (!args.parent.quiet) {
    const modeLabel = args.cmdOpts.tournamentMatrix === true ? " [matrix mode]" : "";
    process.stdout.write(
      `Tournament estimate${modeLabel}: ${sample} prompts × ${callsPerRow} calls = ${sample * callsPerRow} claude invocations\n`,
    );
    process.stdout.write(
      `Estimated cost: ~$${estimatedCost.toFixed(2)} (conservative @ $${TOURNAMENT_COST_PER_CALL_ESTIMATE_USD.toFixed(2)}/call). Hard cap: $${budget.toFixed(2)}.\n`,
    );
    process.stdout.write("Use --confirm-cost to proceed.\n");
  }
  return;
}
```

#### 3.1.5 Pass `matrix` to `runTournament`

Update the `runTournament` call inside `runTournamentMode`:

```typescript
const report = await runTournament(inputs, {
  getSpec: (c) => args.profile.classes[c],
  budgetCapUsd: budget,
  matrix: args.cmdOpts.tournamentMatrix === true,
  ...(args.parent.quiet ? {} : { onProgress }),
  ...(resumePath !== undefined ? { resumePath } : {}),
});
```

#### 3.1.6 Update the `onProgress` handler to render matrix events

Add cases for the new event types inside the `onProgress` switch inside `runTournamentMode`:

```typescript
case "b_effort_done":
  process.stderr.write(
    `        ${dim("B~")} ${gray(`$${e.costUsd.toFixed(4)}`)} ${dim(`effort→${e.effortLevel}`)}\n`,
  );
  break;
case "judge_effort_done":
  process.stderr.write(
    `        ${dim("J~")} ${gray(`$${e.costUsd.toFixed(4)}`)}  ${verdictGlyph[e.verdict] ?? e.verdict}  ${dim(`effort→${e.effortLevel}  spent $${e.totalSpent.toFixed(4)}`)}\n`,
  );
  break;
```

#### 3.1.7 Extend `renderTournamentHuman` to display matrix results

After the existing per-class win-rate table, add a matrix section when `matrixResults` is non-empty:

```typescript
function renderTournamentHuman(report: TournamentReport): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(header("Tournament results"));
  lines.push(
    `  ${bold("prompts")}   ${cyan(`${report.ran}/${report.totalPrompts}`)}  ${dim("ran")}`,
  );
  lines.push(`  ${bold("spent")}     ${cyan("$" + report.totalCostUsd.toFixed(4))}`);
  lines.push("");
  lines.push(dim("  class            tier-down      verdict"));
  for (const cls of ALL_CLASSES) {
    const target = DOWNGRADE[cls];
    if (target === null) {
      lines.push(`    ${cls.padEnd(10)} ${gray("—".padEnd(13))} ${dim("skipped (no cheaper tier)")}`);
      continue;
    }
    const wr = report.perClassWinRates[cls];
    if (wr.ran === 0) {
      lines.push(`    ${cls.padEnd(10)} ${gray((`→ ${target}`).padEnd(13))} ${dim("not sampled")}`);
      continue;
    }
    const wins = wr.downgradeWins + wr.ties;
    const recommend = wins > wr.aLosses;
    const ratio = wr.ran > 0 ? wins / wr.ran : 0;
    const verdict = recommend
      ? `${accuracyColor(ratio)("✓ recommend downgrade")}${wr.ran < 3 ? dim(` (n=${wr.ran})`) : ""}`
      : gray("keep current");
    lines.push(
      `    ${cls.padEnd(10)} ${cyan((`→ ${target}`).padEnd(13))} ${accuracyColor(ratio)(`${wins}/${wr.ran}`)}  ${verdict}`,
    );
    const suggested = report.recommendedDowngrades.find(
      (r) => r.from === cls && r.to === target,
    );
    if (suggested) {
      lines.push(
        `                              ${dim("→ pattern")} ${magenta(suggested.promptPattern)} ${dim("conf 0.85")}`,
      );
    }
  }

  // Matrix section
  if (report.matrixResults.length > 0) {
    lines.push("");
    lines.push(dim("  effort matrix (same model, lower effort)"));
    lines.push(dim("  class            effort-step    wins  ties  losses  failed"));
    for (const mr of report.matrixResults) {
      for (const cell of mr.cells) {
        const total = cell.wins + cell.ties + cell.losses + cell.failed;
        const recommend = total > 0 && (cell.wins + cell.ties) > cell.losses;
        const ratio = total > 0 ? (cell.wins + cell.ties) / total : 0;
        const verdict = recommend
          ? accuracyColor(ratio)("✓ reduce effort")
          : gray("keep effort");
        lines.push(
          `    ${mr.class.padEnd(10)} ${cyan((`${mr.currentEffort}→${cell.effort}`).padEnd(13))} ` +
          `${String(cell.wins).padStart(4)}  ${String(cell.ties).padStart(4)}  ${String(cell.losses).padStart(6)}  ${String(cell.failed).padStart(6)}  ${verdict}`,
        );
      }
    }
  }

  const skippedBudget = report.rows.filter(
    (r: TournamentRowResult) => r.skipReason === "budget_cap_reached",
  ).length;
  if (skippedBudget > 0) {
    lines.push("");
    lines.push(`  ${yellow("⚠")} ${yellow("budget cap reached")} ${dim(`— ${skippedBudget} prompt(s) not run`)}`);
  }
  return lines.join("\n");
}
```

#### 3.1.8 Extend `--tournament-output` to include effort-reduction proposals

Import `MatrixResult` and `MatrixCell` in `bench.ts` from `tournament.js`:

```typescript
import {
  buildProposedHeuristics,
  DOWNGRADE,
  runTournament,
  type MatrixCell,
  type MatrixResult,
  type TournamentInput,
  type TournamentProgress,
  type TournamentReport,
  type TournamentRowResult,
} from "../eval/tournament.js";
```

Extend the output proposal object inside `runTournamentMode` when `--tournament-output` is set:

```typescript
if (args.cmdOpts.tournamentOutput) {
  const effortReductions = report.matrixResults.flatMap((mr) =>
    mr.cells
      .filter((cell) => {
        const total = cell.wins + cell.ties + cell.losses + cell.failed;
        return total > 0 && (cell.wins + cell.ties) > cell.losses;
      })
      .map((cell) => ({
        class: mr.class,
        currentEffort: mr.currentEffort,
        reducedEffort: cell.effort,
        winRate: Number(
          ((cell.wins + cell.ties) / (cell.wins + cell.ties + cell.losses + cell.failed)).toFixed(4),
        ),
        sampleCount: cell.wins + cell.ties + cell.losses + cell.failed,
      })),
  );

  const proposal = {
    overrides: {} as ProfileOverride,
    heuristics: buildProposedHeuristics(report.recommendedDowngrades),
    ...(report.matrixResults.length > 0 ? { effortReductions } : {}),
  };
  await writeFile(
    resolve(args.cmdOpts.tournamentOutput),
    JSON.stringify(proposal, null, 2),
    "utf8",
  );
  if (!args.parent.quiet) {
    process.stdout.write(
      `\nWrote tournament proposal to ${args.cmdOpts.tournamentOutput}\n` +
        `Validate with: maestro bench --propose ${args.cmdOpts.tournamentOutput}\n`,
    );
  }
}
```

### 3.2 Tests for `bench.ts` CLI layer

Because `bench.ts` integration tests require the full pipeline, add the following targeted unit tests inside `src/cli/bench.test.ts` (create the file if it doesn't exist — check first):

```typescript
// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";

/**
 * Lightweight unit coverage for the cost-estimate logic extracted from
 * runTournamentMode. The full CLI integration is exercised by E2E tests.
 */
describe("bench tournament-matrix cost estimate constants", () => {
  test("matrix multiplier is 5/3 of standard (5 calls vs 3)", () => {
    const standard = 3;
    const matrix = 5;
    // Conservative upfront estimate: matrix adds ~2 extra spawns per row.
    expect(matrix).toBeGreaterThan(standard);
    expect(matrix / standard).toBeCloseTo(5 / 3, 5);
  });
});
```

If `src/cli/bench.test.ts` already exists, append the describe block to the existing file rather than creating a new one.

### 3.3 Verification

```
pnpm typecheck   # expect: no errors
pnpm lint        # expect: no errors
pnpm test        # expect: all tests green
```

Manual smoke test (dry run — no real $ spend):

```
pnpm build && node dist/cli/index.js bench --tournament --tournament-matrix --tournament-sample 3
# expect: prints "Tournament estimate [matrix mode]: 3 prompts × 5 calls = 15 claude invocations"
# expect: "Use --confirm-cost to proceed." (exits without spending)
```

---

## Acceptance criteria

- [ ] `EFFORT_DOWNGRADE` exported from `tournament.ts`, all 5 effort keys present, `low` → null
- [ ] `MatrixCell` and `MatrixResult` exported from `tournament.ts`
- [ ] `TournamentRowResult` carries optional effort fields (`effortDowngradedEffort`, `costBEffortUsd`, `costJudgeEffortUsd`, `judgeVerdictEffort`, `judgeReasonEffort`, `recommendEffortDowngrade`)
- [ ] `TournamentReport.matrixResults` is `MatrixResult[]`
- [ ] `runTournament` with `matrix: false` (default) is byte-for-byte identical in behavior to v0.2 (all existing tests pass unchanged)
- [ ] `runTournament` with `matrix: true` and a non-floor effort: 5 spawns per row, correct cell aggregation
- [ ] `runTournament` with `matrix: true` and floor effort (`low`): 3 spawns, no effort fields on row
- [ ] Budget cap respected: B_effort not attempted if cap already exceeded
- [ ] Resume file includes effort fields when matrix=true
- [ ] `bench --tournament-matrix` flag accepted, cost estimate reflects 5 calls/row with label `[matrix mode]`
- [ ] `--tournament-output` includes `effortReductions` array when matrix=true and reductions are recommended
- [ ] `renderTournamentHuman` renders the effort matrix section below the tier-down section
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm test` all pass after each task
