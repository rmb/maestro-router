# Maestro Architecture

## What this is and why it exists

Claude Code uses the same model for every prompt regardless of complexity. A simple rename and a system design question both hit Opus, even though Haiku handles the first just as well at 50× lower cost. Over a month of daily use, this wastes a significant fraction of your subscription budget.

Maestro solves this by classifying each prompt and forwarding it to the cheapest model that will produce the right answer. It wraps the Claude CLI — every prompt gets routed, priced, and logged before Claude sees it. The user interface is unchanged.

## Why a wrapper, not a proxy

Three constraints ruled out an HTTP proxy approach:

**Subscription auth.** Pro/Team users authenticate via OAuth at `claude.ai`, not via `ANTHROPIC_API_KEY`. An HTTP proxy can't intercept those requests — the OAuth token is scoped to Anthropic's first-party endpoints. Wrapping the CLI sidesteps auth entirely.

**Native flag support.** The Claude CLI exposes every primitive Maestro needs: `--model`, `--effort`, `--max-budget-usd`, `--session-id`, `--resume`, `--output-format json`, `--exclude-dynamic-system-prompt-sections`, `--tools`, `--bare`. Session continuity survives model swaps (verified: Haiku → Sonnet preserved context). Cost telemetry is exact, not estimated.

**VSCode panel coverage.** The official `anthropic.claude-code` extension exposes `claudeCode.claudeProcessWrapper`. Pointing it at `maestro` routes every panel invocation through Maestro without touching the extension. The `--input-format stream-json` channel is owned by Maestro as a per-turn proxy — each user message is classified and forwarded as `claude --print --resume`, so routing can change mid-session as complexity changes.

## Per-prompt data flow

```
       ┌──────────────────────────────────────────────────────────────┐
       │                       User prompt                            │
       │  (VSCode panel via claudeProcessWrapper, or maestro run)     │
       └─────────────────────────────┬────────────────────────────────┘
                                     ▼
       ┌──────────────────────────────────────────────────────────────┐
       │ classifiers/passthrough.ts                                   │
       │   /clear, /model, /help, /cost → bypass classification       │
       └─────────────────────────────┬────────────────────────────────┘
                                     ▼
       ┌──────────────────────────────────────────────────────────────┐
       │ core/pipeline.ts — cheap-first, short-circuit at conf ≥ 0.55 │
       │                                                              │
       │  1. override.ts      @fast / @deep / @think — conf 1.0       │
       │  2. turn-type.ts     tool_result / error_recovery / cont.    │
       │  3. heuristic.ts     built-in regex + user rules             │
       │  4. embedding.ts     ONNX cosine sim (optional peer)         │
       │  5. llm.ts           Haiku --json-schema (opt-in)            │
       │                                                              │
       │  Sub-threshold results → weighted vote. No match → standard. │
       └─────────────────────────────┬────────────────────────────────┘
                                     ▼
       ┌──────────────────────────────────────────────────────────────┐
       │ core/cache.ts — sha256(prompt+scenario), LRU 1000, 24h TTL   │
       └─────────────────────────────┬────────────────────────────────┘
                                     ▼
       ┌──────────────────────────────────────────────────────────────┐
       │ core/profile.ts — class → { model, effort, maxBudgetUsd, … } │
       └─────────────────────────────┬────────────────────────────────┘
                                     ▼
       ┌──────────────────────────────────────────────────────────────┐
       │ wrapper/session.ts — reuse session by cwd, 24h window        │
       └─────────────────────────────┬────────────────────────────────┘
                                     ▼
       ┌──────────────────────────────────────────────────────────────┐
       │ wrapper/spawn.ts → claude --print --output-format json       │
       │   --session-id|--resume <uuid>                               │
       │   --model X --effort Y --max-budget-usd Z                    │
       │   --append-system-prompt "Be concise…"                       │
       │   [--bare]  (trivial + heuristic.bare_safe + API key auth)   │
       │   [--exclude-dynamic-system-prompt-sections]                 │
       │   [--tools <list>]                                           │
       │   [--strict-mcp-config --mcp-config '…']                     │
       └─────────────────────────────┬────────────────────────────────┘
                                     ▼
       ┌──────────────────────────────────────────────────────────────┐
       │ wrapper/stream.ts — pipe stdout/stderr live, capture JSON    │
       │   SIGINT forwarded; AbortSignal → SIGTERM                    │
       └─────────────────────────────┬────────────────────────────────┘
                                     ▼
       ┌──────────────────────────────────────────────────────────────┐
       │ wrapper/output.ts — parse CostBreakdown from JSON envelope   │
       └─────────────────────────────┬────────────────────────────────┘
                                     ▼
       ┌──────────────────────────────────────────────────────────────┐
       │ core/telemetry.ts — append to ~/.maestro/decisions.jsonl     │
       │ core/posthog.ts   — fire-and-forget event to PostHog (opt-in)│
       └──────────────────────────────────────────────────────────────┘
```

## Classifier pipeline in detail

**Override** reads the first word of the prompt. `@fast`/`@haiku` → trivial, `@think` → reasoning, `@deep`/`@opus` → max. Confidence 1.0. The hint is stripped before the prompt reaches Claude.

**Turn-type** detects structural prompt patterns rather than content. Tool results route to simple or trivial depending on the tool name and output. Error recovery routes to hard. Continuation turns ("ok continue", "go on") stay at simple. This stage fires before the heuristic so tool scaffolding overhead doesn't leak into routing decisions.

**Heuristic** applies 45+ compiled regexes in priority order. The highest-confidence match wins. Built-in rules cover git operations, version bumps, docstring edits, rename/format tasks, debug and production-incident language, architecture and design vocabulary, and more. User-defined rules from `~/.maestro/heuristics.json` are appended after built-in rules and can override via higher confidence.

**Embedding** (optional peer `@xenova/transformers`) computes cosine similarity between the prompt embedding and ~60 frozen labeled exemplars. Returns null if the peer isn't installed, which is fine — the LLM stage is the final fallback.

**LLM** calls Haiku via `--json-schema` with a structured prompt. Returns a class + confidence. Off by default in the wrapper hot path (adds 2-20s latency); opt in via `useLlmClassifierInWrapper: true`. Used by default in offline eval and tuning workflows.

## Session reuse and cost amortization

The single largest cost driver is `cache_creation_input_tokens` — Claude Code's system prompt is ~37k tokens and gets cached on the first turn of every new session. A naive implementation pays this cost on every class transition because different classes use different flags (`--bare`, `--tools`, `--append-system-prompt`), which changes the system-prompt prefix and busts Anthropic's cache.

**Track Z — system-prompt fingerprinting.** `wrapper/session.ts` keys sessions by `sha256([model, tools, mcpConfig, bare, excludeDynamic, appendSystemPrompt]).slice(0,16)` — a hash of every flag that affects the system-prompt prefix. `getByFingerprint(cwd, fingerprint)` reuses the same session ID whenever the fingerprint matches, regardless of which class produced each turn. Sessions with different fingerprints (e.g. trivial's `--bare` vs standard's full tool set) get separate IDs so they never cross-contaminate. Adjacent-tier fingerprints are prewarmed in the background after each turn via `wrapper/prewarm.ts`, so the next model tier's cache entry is warm before it's needed.

Model swaps within a fingerprint group are safe — verified by spike: Haiku → Sonnet preserves conversation context via `--session-id` + `--resume`.

**E1.escalate.** When a `max_tokens` stop reason is recorded on a `standard` turn, the session is flagged as escalated. On the next turn, `effort: low` is promoted to `effort: medium` for that session, capping the regression at one turn's extra cost. The classifier cache entry for that prompt is also invalidated so the pipeline re-classifies upward.

## Community tuning loop

1. Users with `posthogApiKey` set emit `maestro_override` events when they use `@deep`/`@fast` to correct a routing decision.
2. A weekly GitHub Actions workflow queries PostHog via HogQL, mines override patterns, and commits updated heuristics to `community/heuristics.json`.
3. On every spawn, Maestro checks if 7 days have passed since the last auto-tune. If so, a detached background process fetches `community/heuristics.json`, merges new rules into `~/.maestro/heuristics.json`, and records the timestamp in `~/.maestro/state.json`. Zero user interaction required.

Local tuning (without PostHog) works the same way but draws only from the user's own `~/.maestro/decisions.jsonl`.

## Tournament evaluator

`maestro bench --tournament` validates which downgrades are safe without guessing. For each sampled prompt:

1. **A spawn** — runs at the current assigned class, captures the response
2. **B spawn** — runs one tier cheaper (e.g. standard → simple)
3. **Judge spawn** — Sonnet with `--json-schema` compares both responses and returns `{ winner: "A" | "B" | "tie" }`

Pattern mining over tied/B-win rows surfaces heuristic candidates. Requires `--confirm-cost` to actually spend money — without it, prints a cost estimate only.

## Module layout

```
src/
  core/             Pure logic, zero internal deps.
    types.ts            Domain types: Class, Profile, Decision, SessionContext, …
    cache.ts            LRU + TTL + sha256 keying (pipeline decision cache)
    classifier-cache.ts In-process LRU prompt→class cache; K1 self-invalidation on max_tokens
    telemetry.ts        JSONL writer
    posthog.ts          Fire-and-forget capture + HogQL query client
    pipeline.ts         Short-circuit + weighted vote; Y.guarantee; K2 markov escape; E3 escalation
    profile.ts          Built-in profiles + layered loader (E1: standard effort=low, X: output caps)
    extract.ts          JSON extraction (fenced + brace-balanced fallback)

  classifiers/      Pipeline stages. Depend only on core/.
    override.ts     @fast / @deep / @think
    turn-type.ts    user_prompt / tool_result / error_recovery / continuation
    heuristic.ts    Built-in regex + user rules
    embedding.ts    ONNX cosine similarity (optional peer)
    llm.ts          Haiku --json-schema fallback

  wrapper/          Subprocess concerns.
    preflight.ts        Verify Claude CLI version + required flags
    session.ts          Fingerprint-keyed session store (Track Z); getByFingerprint; updateStopReason
    prewarm.ts          Background prewarm of adjacent fingerprint tiers (Z.bootstrap)
    continuation.ts     Two-signal continuation detection (M1); CONTINUATION_HINT injection
    spawn.ts            buildClaudeArgs (pure) + spawnClaude; X.soft class-specific brevity hints
    stream.ts           Live pipe + capture + signal forwarding
    stream-json-proxy.ts  Per-turn VSCode panel proxy
    passthrough.ts      Slash-command bypass
    output.ts           Parse --output-format json → CostBreakdown

  cli/              Commander shell.
    run-cmd.ts      maestro run — K1 cache; M1 continuation; Track Z fingerprint; E1.escalate post-turn
    tune.ts         Telemetry analysis, community fetch, auto-tune
    stats.ts        Cost vs Opus-everywhere baseline; session boot dominance warning
    health.ts       Baseline snapshot comparison; regression detection >10%
    oracle.ts       maestro oracle — wires all four oracle dimensions; --confirm-cost for quality
    bench.ts        Eval + tournament
    replay.ts       JSONL replay against current pipeline

  eval/oracle/      Oracle evaluation layer — pure computation, no subprocess spawning.
    reader.ts               loadWindow, groupBySession, pairDecisionsWithOutcomes
    telemetry-correctness.ts 4 checks: cost reconciliation, fallback rate, cache hit rate, outcome linkage
    tool-correctness.ts     5 checks: fingerprint stability, flag coverage, E1 escalation, K1 invalidation, M1 two-signal
    tokens-saved.ts         savings vs Opus-everywhere baseline; E1/Track Z/X isolation by date
    output-quality.ts       truncation rate check; bench-accuracy + E1 tournament stubs (--confirm-cost)
    report.ts               OracleReport type; buildReport; printReport (human + JSON)
```

## Configuration layers

Loaded in priority order (later layers override earlier):

1. **Built-in profile** (`balanced` / `cheap` / `quality`)
2. **User config** (`~/.maestro/config.json`) — profile, aggressiveness, cost caps, classifier flags
3. **Profile overrides** (`~/.maestro/profile-overrides.json`) — per-class model/effort/budget tweaks
4. **User heuristics** (`~/.maestro/heuristics.json`) — regex patterns → class
5. **Per-project config** (`<repo>/.maestro/`) — allowed fields only (`profile`, `excludeDynamicSections`, `useEmbeddingClassifier`)

Fields that affect telemetry paths, billing caps, and hot-path latency are global-only. A committed `.maestro/config.json` in a shared repo cannot silently affect teammates on those dimensions.

## Pipeline hardening (Sprint 0/1)

**Y.guarantee.** When no classifier fires above threshold and the weighted vote produces no clear winner, the pipeline previously fell back to `class: "standard", classifier: "default", confidence: 0`. This was indistinguishable from a genuine standard classification in telemetry, hiding the true fallback rate (measured at 67.9% in production). Y.guarantee renames the fallback to `classifier: "forced.standard"`, sets `confidence: 0.1`, and attaches a `fallback.forced_standard` diagnostic. `maestro stats` now tracks this separately, giving a debuggable signal for classifier coverage gaps.

**K2 — Markov lock-in escape.** Repeated turns in the same session can lock the route into a low class even as the problem scope grows. `pipeline.ts` breaks the markov chain when the current prompt is >2.5× the rolling session average length, contains escalation keywords (`architect`, `design`, `production`, `incident`, etc.), includes an `@override` directive, or the prior turn stopped at `max_tokens`. When any escape condition fires, the cached classification is discarded and the full pipeline runs.

**E3 — Reasoning effort escalation.** When a turn is classified as `reasoning` or `max`, E3 checks three signals: an `entropy_escalation` diagnostic from any classifier, 3+ consecutive reasoning/max turns in the last 5, and a prior `max_tokens` stop reason. When 2 of 3 signals fire, the effort is promoted to `high` and a `reasoning.effort_escalated` diagnostic is emitted.

**X — Output token discipline.** Hard caps per class: `standard → 8000`, `hard → 4000`, `reasoning → 6000`, `max` uncapped. Class-specific brevity hints appended to the system prompt: trivial gets "Output only the answer. No explanation.", simple gets "Be concise. Skip preamble.", hard/reasoning/max get no hint (suppress constraint on complex tasks). Caps are passed via `--append-system-prompt` — they do not affect the system-prompt cache fingerprint because they are applied at generation time.

**K1 — Classifier result cache.** An in-process LRU cache (`src/core/classifier-cache.ts`) stores `sha256(prompt) → Classification` with a 24-hour TTL and 1000-entry limit. Cache hits skip the full pipeline on repeated or near-identical prompts. When a turn completes with `stopReason: "max_tokens"` on a `standard` class, the cache entry for that prompt is invalidated so the next identical prompt re-classifies upward.

**M1 — Two-signal continuation.** Prior implementation routed any short prompt matching `/^(continue|keep going|…)/` to simple class. This conflated genuine brevity (a user continuing work) with prompt padding. M1 requires two simultaneous signals: the linguistic pattern match AND `priorStopReason === "max_tokens"`. Single-signal matches now proceed to the normal pipeline. When both signals fire, `wrapper/continuation.ts` injects `CONTINUATION_HINT` ("Resume from where you stopped. No recap. Continue directly.") as the `appendSystemPrompt`, overriding the standard brevity hint.

## Oracle evaluation

`maestro oracle` is an offline correctness and savings auditor. It reads from `~/.maestro/decisions.jsonl` and `~/.maestro/sessions.json` — no live Claude spawns unless `--dimension quality --confirm-cost` is passed.

Four dimensions, each returning a `DimensionResult` with pass/fail per check:

**tool** — verifies routing decisions produced correct invocations: fingerprint stability (Track Z firing), flag coverage (spec.model matches cost.modelUsed), E1.escalate correctness, K1 cache invalidation after max_tokens, M1 two-signal guard.

**telemetry** — verifies the logs are accurate: cost reconciliation vs stats.ts (±1%), fallback rate accuracy, cache hit rate accuracy (cross-checked against cacheReadInputTokens), outcome linkage (≥90% of outcome events must pair with a decision within ±60s).

**tokens** — verifies savings targets are met: overall savings ≥60% vs Opus-everywhere hypothetical, E1 standard avg cost reduction ≥50%, Track Z session boot frequency reduction ≥30%, output p90 ≤8500 after X cap.

**quality** (--confirm-cost required) — truncation rate check (standard turns near cap <5%); bench-accuracy and E1-tournament probes are stubs until the full quality-probe workflow is implemented.

```bash
maestro oracle                          # tool + telemetry + tokens (offline, free)
maestro oracle --dimension tokens --since 30
maestro oracle --json                   # machine-readable; exit 1 if any gate fails
maestro oracle --dimension quality --confirm-cost   # live probes (~$2)
```

## Health monitoring

`maestro health` snapshots six metrics: total requests, cache hit rate, fallback rate, session boot ratio (cache_creation cost / total cost), per-class average cost, and output tokens p90 by class. `maestro health --set-baseline` saves the current snapshot to `~/.maestro/health-baseline.json`. On subsequent runs, `maestro health` computes regressions (>10% change) and improvements against the baseline. CI pipelines can use `--json` + a non-zero exit check to gate on regressions.

## Known behavioral notes

**`--max-budget-usd` is a soft cap.** Verified during a spike: a `$0.01` cap on a long-essay prompt resulted in `$0.063` actual cost (6.3× overrun). The output parser detects `subtype: error_max_budget_usd` and emits a `claude.budget_exceeded` diagnostic. Profile defaults are sized with this margin in mind.

**`--bare` requires four conditions.** The profile must enable it, the heuristic must tag the prompt `bare_safe`, no `@fast+context` override must be present, and the auth method must be API key (not OAuth). All four are checked in `wrapper/spawn.ts`.

Details and spike results in [router-observations.md](router-observations.md).
