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

The single largest cost driver is `cache_creation_input_tokens` — Claude Code's system prompt is ~37k tokens and gets cached on the first turn of every new session. Maestro reuses the same `--session-id` for all prompts in the same `cwd` within a 24-hour window, regardless of which model handles each turn. This amortizes the cache creation cost across the session rather than paying it per turn.

Model swaps within a session are safe — verified by spike: Haiku → Sonnet preserves conversation context via `--session-id` + `--resume`.

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
    types.ts        Domain types: Class, Profile, Decision, …
    cache.ts        LRU + TTL + sha256 keying
    telemetry.ts    JSONL writer
    posthog.ts      Fire-and-forget capture + HogQL query client
    pipeline.ts     Short-circuit + weighted vote + cache integration
    profile.ts      Built-in profiles + layered loader
    extract.ts      JSON extraction (fenced + brace-balanced fallback)

  classifiers/      Pipeline stages. Depend only on core/.
    override.ts     @fast / @deep / @think
    turn-type.ts    user_prompt / tool_result / error_recovery / continuation
    heuristic.ts    Built-in regex + user rules
    embedding.ts    ONNX cosine similarity (optional peer)
    llm.ts          Haiku --json-schema fallback

  wrapper/          Subprocess concerns.
    preflight.ts        Verify Claude CLI version + required flags
    session.ts          UUID store with aggressive cwd reuse
    spawn.ts            buildClaudeArgs (pure) + spawnClaude
    stream.ts           Live pipe + capture + signal forwarding
    stream-json-proxy.ts  Per-turn VSCode panel proxy
    passthrough.ts      Slash-command bypass
    output.ts           Parse --output-format json → CostBreakdown

  cli/              Commander shell.
    run-cmd.ts      maestro run — classify and forward a prompt
    tune.ts         Telemetry analysis, community fetch, auto-tune
    stats.ts        Cost vs Opus-everywhere baseline
    bench.ts        Eval + tournament
    replay.ts       JSONL replay against current pipeline
```

## Configuration layers

Loaded in priority order (later layers override earlier):

1. **Built-in profile** (`balanced` / `cheap` / `quality`)
2. **User config** (`~/.maestro/config.json`) — profile, aggressiveness, cost caps, classifier flags
3. **Profile overrides** (`~/.maestro/profile-overrides.json`) — per-class model/effort/budget tweaks
4. **User heuristics** (`~/.maestro/heuristics.json`) — regex patterns → class
5. **Per-project config** (`<repo>/.maestro/`) — allowed fields only (`profile`, `excludeDynamicSections`, `useEmbeddingClassifier`)

Fields that affect telemetry paths, billing caps, and hot-path latency are global-only. A committed `.maestro/config.json` in a shared repo cannot silently affect teammates on those dimensions.

## Known behavioral notes

**`--max-budget-usd` is a soft cap.** Verified during a spike: a `$0.01` cap on a long-essay prompt resulted in `$0.063` actual cost (6.3× overrun). The output parser detects `subtype: error_max_budget_usd` and emits a `claude.budget_exceeded` diagnostic. Profile defaults are sized with this margin in mind.

**`--bare` requires four conditions.** The profile must enable it, the heuristic must tag the prompt `bare_safe`, no `@fast+context` override must be present, and the auth method must be API key (not OAuth). All four are checked in `wrapper/spawn.ts`.

Details and spike results in [router-observations.md](router-observations.md).
