# Maestro Architecture

Maestro is a CLI wrapper around the Claude Code CLI. Every user prompt is
classified into one of six complexity classes, mapped to a model + thinking
budget + cost cap via a configurable profile, and forwarded to
`claude --print` as a subprocess. Output is streamed back live; the JSON
result envelope provides exact token + cost telemetry.

## Why a wrapper (not a proxy)

Three constraints pushed the design here:

1. **Subscription auth.** Pro/Team users authenticate Claude Code via
   OAuth at `claude.ai`, not via `ANTHROPIC_API_KEY`. A localhost HTTP
   proxy (like Claude Code Router) can't intercept those requests — the
   OAuth token is scoped to Anthropic's first-party endpoints. Wrapping
   the CLI side-steps auth entirely: Claude handles its own login.

2. **Spike-verified mechanics.** The Claude CLI exposes every primitive
   Maestro needs as a flag: `--model`, `--effort`, `--max-budget-usd`,
   `--session-id`, `--resume`, `--output-format json`,
   `--exclude-dynamic-system-prompt-sections`, `--tools`,
   `--strict-mcp-config`, `--mcp-config`, `--bare`. Session continuity
   survives model swap (verified Haiku→Sonnet kept context). Cost telemetry
   is exact, not estimated.

3. **VSCode panel coverage.** The official `anthropic.claude-code`
   extension exposes a `claudeCode.claudeProcessWrapper` setting. Pointing
   it at `maestro` routes every panel-UI invocation through us without
   touching the extension code.

Details and trade-offs in [adr/0003-wrapper-architecture-over-proxy.md](adr/0003-wrapper-architecture-over-proxy.md).

## Per-prompt data flow

```
       ┌──────────────────────────────────────────────────────────────┐
       │                       User prompt                            │
       │  (VSCode terminal, panel UI via claudeProcessWrapper, or     │
       │   piped to `maestro run` directly)                           │
       └─────────────────────────────┬────────────────────────────────┘
                                     ▼
       ┌──────────────────────────────────────────────────────────────┐
       │ classifiers/passthrough.ts                                   │
       │   isSlashPrefix("/clear" etc.) → bypass, forward unmodified  │
       └─────────────────────────────┬────────────────────────────────┘
                                     ▼
       ┌──────────────────────────────────────────────────────────────┐
       │ core/pipeline.ts — cheap-first, short-circuit at confidence  │
       │  >= 0.6                                                      │
       │                                                              │
       │ ┌────────────────────────┐  ┌────────────────────────────┐   │
       │ │ override.ts            │  │ turn-type.ts               │   │
       │ │  @fast / @deep / etc.  │  │ user_prompt / tool_result  │   │
       │ │  conf 1.0 if hint      │  │ / error_recovery / cont.   │   │
       │ └────────────────────────┘  └────────────────────────────┘   │
       │             │                          │                     │
       │             └──────────┬───────────────┘                     │
       │                        ▼                                     │
       │                ┌────────────────────────────────┐            │
       │                │ heuristic.ts                   │            │
       │                │  built-in regex + user rules   │            │
       │                │  + size policy + bare_safe     │            │
       │                └────────────────────────────────┘            │
       │                              │                               │
       │                              ▼                               │
       │                ┌────────────────────────────────┐            │
       │                │ llm.ts (S12, opt-out)          │            │
       │                │  claude --print --json-schema  │            │
       │                │  haiku, $0.01 cap, 2s timeout  │            │
       │                │  <PROMPT_TO_CLASSIFY> anti-    │            │
       │                │  injection wrap                │            │
       │                └────────────────────────────────┘            │
       │                                                              │
       │  Sub-threshold results vote (weighted). No match → standard. │
       └─────────────────────────────┬────────────────────────────────┘
                                     ▼
       ┌──────────────────────────────────────────────────────────────┐
       │ core/cache.ts — sha256(prompt+scenario), LRU 1000, 24h TTL   │
       │  cache hit → return cached Decision + cache.hit diagnostic   │
       └─────────────────────────────┬────────────────────────────────┘
                                     ▼
       ┌──────────────────────────────────────────────────────────────┐
       │ core/profile.ts — Decision.spec from class lookup            │
       │  layered: built-in → user overrides → S7 global defaults     │
       └─────────────────────────────┬────────────────────────────────┘
                                     ▼
       ┌──────────────────────────────────────────────────────────────┐
       │ wrapper/session.ts — getOrCreate(cwd) → {sessionId, isNew}   │
       │  aggressive reuse (F9) within 24h window for same cwd        │
       └─────────────────────────────┬────────────────────────────────┘
                                     ▼
       ┌──────────────────────────────────────────────────────────────┐
       │ wrapper/spawn.ts → buildClaudeArgs(decision, config, sid, …) │
       │   --print --output-format json --session-id|--resume <uuid>  │
       │   --model X --effort Y --max-budget-usd Z                    │
       │   [--bare]  (S6: heuristic.bare_safe ∧ profile.bare ∧ ¬@fast+context)
       │   [--exclude-dynamic-system-prompt-sections] (S7)            │
       │   [--tools <list>]   (S8 trivial/simple → "Read,Edit")       │
       │   [--strict-mcp-config --mcp-config '{"mcpServers":{}}'] (S9)│
       └─────────────────────────────┬────────────────────────────────┘
                                     ▼
       ┌──────────────────────────────────────────────────────────────┐
       │ wrapper/stream.ts — spawn `claude`, pipe stdout/stderr live, │
       │   capture stdout for trailing JSON envelope                  │
       │   SIGINT forwarded; AbortSignal → SIGTERM                    │
       └─────────────────────────────┬────────────────────────────────┘
                                     ▼
       ┌──────────────────────────────────────────────────────────────┐
       │ wrapper/output.ts — parseOutput(capturedStdout)              │
       │  → CostBreakdown (totalCostUsd, all token counts, duration)  │
       │  → Diagnostics: claude.budget_exceeded (R8),                 │
       │     info.compact_recommended (S10)                           │
       └─────────────────────────────┬────────────────────────────────┘
                                     ▼
       ┌──────────────────────────────────────────────────────────────┐
       │ core/telemetry.ts — append decision event to                 │
       │  ~/.maestro/decisions.jsonl                                  │
       │  update counters in ~/.maestro/config.json                   │
       └──────────────────────────────────────────────────────────────┘
```

## Tournament

`maestro bench --tournament` empirically validates which classification
downgrades are safe. For each sampled prompt the tournament:

1. **A spawn** — runs the prompt at the class the pipeline currently
   assigns, capturing the response and `total_cost_usd` from
   `--output-format json`.
2. **B spawn** — runs the same prompt one tier cheaper (using the
   `DOWNGRADE` map: simple → trivial, standard → simple, hard → standard,
   …). Trivial has no cheaper tier and is skipped.
3. **Judge spawn** — Sonnet (default) with `--json-schema` returns
   `{ winner: "A" | "B" | "tie", reason: … }` after seeing both responses
   wrapped in `<RESPONSE_A>` / `<RESPONSE_B>` tags.

Calls are sequential (controllable budget, clean ctrl-C). When total cost
exceeds `--tournament-budget` the engine aborts and marks the remaining
rows `budget_cap_reached`. Pattern mining over winning rows surfaces
heuristic candidates (≥3 occurrences of a ≥4-char token in the same
`from → to` group → `\\btoken\\b` rule at confidence 0.85).

The default behavior requires `--confirm-cost` to actually spend money;
without it the command only prints a cost estimate. Output can be written
as JSON (`--tournament-output`) and validated against the eval baseline
with `bench --propose` before applying.

See `src/eval/tournament.ts` for the engine; `src/cli/bench.ts` for the
CLI wiring.

## Module organization

```
src/
  core/             Zero internal deps. Pure logic.
    types.ts        Domain types: Class, Profile, Decision, …
    cache.ts        LRU + TTL + sha256 keying
    telemetry.ts    JSONL writer with rotation + counters
    classifier.ts   createClassifier factory
    profile.ts      createProfile + layered loader + built-in profiles
    pipeline.ts     0.6 short-circuit + weighted vote + cache integration
    extract.ts      JSON extraction (fenced + brace-balanced fallback)

  classifiers/      Pipeline stages. Depend only on core.
    override.ts     @fast / @deep / @think / @fast+context (S6 escape)
    turn-type.ts    user_prompt / tool_result / error_recovery / continuation
    heuristic.ts    Built-in regex + user-defined rules + size policy
    llm.ts          claude --print --json-schema (S12) — opt-out
    internal-index.ts  Namespace target for `export * as classifiers`

  wrapper/          Subprocess concerns. Depend on core + node:child_process.
    preflight.ts    Verify Claude CLI version + required flags (R6)
    session.ts      UUID store with aggressive cwd reuse (F9)
    spawn.ts        buildClaudeArgs (pure) + spawnClaude (batch)
    stream.ts       streamClaude (live pipe + capture + signal forwarding)
    passthrough.ts  Slash-command detection (skip classification)
    output.ts       Parse --output-format json → CostBreakdown + diagnostics

  cli/              Commander shell. Depends on core + classifiers + wrapper.
    index.ts        Entrypoint + version + global options
    utils.ts        loadCliConfig (F2 layered) + format() + wrap()
    run-cmd.ts      `maestro run <prompt>` — the user-facing route command
    telemetry-cmd.ts  status / show / feedback
    stats.ts        Cost vs Opus-everywhere baseline (C7)
    tune.ts         Telemetry analysis + auto-learning (F3, F5)
    replay.ts       JSONL log replay against current pipeline
    bench.ts        Eval suite + --propose validation + tournament

  profiles/         Re-export shim (G5).
    internal-index.ts

  index.ts          Public API surface (named exports + namespaces)
```

## Configuration layers

Loaded by `cli/utils.ts → loadCliConfig` and `core/profile.ts → loadProfile`:

1. **Per-project** (`<cwd>/.maestro/config.json`) — hook present, discovery
   gated until v0.3.
2. **User config** (`~/.maestro/config.json`) — global preferences:
   profile name, aggressiveness, daily cost cap, autoLearn,
   excludeDynamicSections, etc.
3. **Profile overrides** (`~/.maestro/profile-overrides.json`) — per-class
   `{model, effort, maxBudgetUsd, …}` tweaks merged on top of the chosen
   built-in profile.
4. **User heuristics** (`~/.maestro/heuristics.json`) — regex patterns →
   class with confidence, appended to built-in rules. **User-defined
   rules never get `bare_safe` implicitly** — `--bare` requires explicit
   `bareSafe: true` in the user's own rule (S6 safety).
5. **Built-in profile** (`balanced` / `cheap` / `quality`).

S7 default: `excludeDynamicSections: true` everywhere unless explicitly
disabled.

## Fine-tuning loop

The intended user feedback loop:

1. Use Maestro daily. Decisions → `~/.maestro/decisions.jsonl`. Manual
   `@deep` etc. overrides → override events in the same log.
2. `maestro stats` shows realized cost, cache hit rate, per-class override
   rate, and the top override patterns.
3. `maestro tune` (dry-run) analyses recent telemetry and proposes new
   heuristic rules from override patterns (≥5 occurrences of the same
   word/phrase in a 30-day window).
4. `maestro tune --apply` writes the suggested rules to
   `~/.maestro/heuristics.json`. (F5: `bench --propose <file>` validates
   before apply; gate at >2% eval regression.)
5. Next session uses the tuned rules; cycle continues.

Manual `maestro telemetry feedback <session-id> --rating 1-5` records
explicit quality ratings that future `tune` versions will weight.

## Decision register

Maestro's plan tracks cross-cutting decisions by tag. Three families:

- **G1–G9** — Gap resolutions (e.g., G2: extractJSON with fenced +
  brace-balanced fallback; G5: internal-index files; G9: router-observations
  format).
- **C1–C12** — Cost optimizations (e.g., C2: cheap-first ordering invariant;
  C3: definite-trivial fast-path; C10: turn-type classifier; C11: per-class
  `maxBudgetUsd`).
- **F1–F9** — Fine-tuning loop (F1: three user-editable files; F3: tune
  `--learn`; F5: `bench --propose`; F9: aggressive session reuse).
- **S1–S11** — Simplifications and Claude-specific savings (S1: defer
  remote telemetry; S2: defer embedding; S6: `--bare` for definite-trivial;
  S7: `--exclude-dynamic-system-prompt-sections` default; S8/S9: tool +
  MCP isolation per class; S10: compaction hint; S11: cache-cost
  separation in reports).

The full register lives in [`tasks/todo.md`](../tasks/todo.md).

## Risk register

- **R6** Claude CLI flag stability. Mitigated by
  `wrapper/preflight.ts` which fails fast with upgrade instructions when
  flags are missing.
- **R7** Session resumption across multi-swap. Spike verified single swap;
  module 12 includes a 5-turn 4-model regression test.
- **R8** `--max-budget-usd` is a **soft cap** — verified during spike:
  with `$0.01` cap on a long-essay prompt, realized cost was `$0.063`
  (6.3× overrun). Output parser detects `subtype: error_max_budget_usd`
  and emits `claude.budget_exceeded` diagnostic. Profile defaults sized
  with margin.

Details in [`router-observations.md`](router-observations.md).

## Extension points (consumers as a library)

Maestro is primarily a CLI binary. The library surface at `maestro-router`
exists for programmatic use cases (custom CLIs, integration tests, plugins):

```ts
import {
  createPipeline,
  createClassifier,
  loadProfile,
  classifiers,
  profiles,
} from "maestro-router";

const pipeline = createPipeline({
  classifiers: [
    classifiers.override,
    classifiers.turnType,
    classifiers.heuristic,
  ],
  profile: loadProfile().profile,
});

const decision = await pipeline.route({ prompt: "rename foo to bar" });
// → { class: "trivial", classifier: "heuristic", spec: { model: "haiku", ... } }
```

The wrapper modules (spawn, stream, output, session) are internal and not
exported as a public subpath — Maestro is intended to be invoked as a CLI.

## What's intentionally out

For the wrapper-architecture v0.2 release:

- No HTTP proxy / CCR adapter
- No SDK middleware
- No Bedrock / OpenAI / Codex compatibility
- No remote telemetry (PostHog) — local JSONL only
- No embedding-based classifier

LLM-based classifier via `claude --print --json-schema` (S12) shipped in
v0.2.1; opt out via `userConfig.useLlmClassifier = false`.

These are deferred and documented in
[`tasks/todo.md → Backlog`](../tasks/todo.md) and
[`future-ideas.md`](future-ideas.md).
