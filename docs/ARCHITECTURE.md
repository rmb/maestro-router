# Maestro Architecture

## What this is and why it exists

Claude Code uses the same model for every prompt regardless of complexity. A simple rename and a system design question both hit Opus, even though Haiku handles the first just as well at 50× lower cost. Over a month of daily use, this wastes a significant fraction of your subscription budget.

Maestro fixes this by classifying each prompt and forwarding it to the cheapest model that will produce the right answer. It wraps the Claude CLI — every prompt is routed, priced, and logged before Claude sees it. Your VSCode panel, `maestro run`, and `maestro shell` work the same.

## Why a wrapper, not a proxy

Three constraints ruled out an HTTP proxy:

**Subscription auth.** Pro/Team users authenticate via OAuth at `claude.ai`, not via `ANTHROPIC_API_KEY`. An HTTP proxy can't intercept those requests — the OAuth token is scoped to Anthropic's first-party endpoints. Wrapping the CLI sidesteps auth entirely.

**Native flag support.** The Claude CLI exposes every primitive Maestro needs: `--model`, `--effort`, `--max-budget-usd`, `--session-id`, `--resume`, `--output-format json`, `--exclude-dynamic-system-prompt-sections`, `--tools`, `--bare`. Session continuity survives model swaps (verified: Haiku → Sonnet preserves context). Cost telemetry is exact, not estimated.

**VSCode panel coverage.** The official `anthropic.claude-code` extension exposes `claudeCode.claudeProcessWrapper`. Pointing it at `maestro` routes every panel invocation through Maestro without touching the extension. The `--input-format stream-json` channel is owned by Maestro as a per-turn proxy — each user message is classified and forwarded as `claude --print --resume`, so routing can change mid-session as complexity changes.

## End-to-end walkthrough — a concrete example

This traces a single prompt from keypress to response.

**Scenario:** You type `"add error handling to the fetch call in src/api.ts"` in the VSCode Claude panel.

---

**1. Interception (`wrapper/sdk-proxy.ts`)**

The VSCode extension sends the message to Maestro's `--input-format stream-json` stdin channel instead of directly to Claude. (`maestro shell` feeds the same channel over a PassThrough stream pair via `wrapper/sdk-host.ts`.) Maestro receives the raw JSON turn object and extracts the user text.

**2. Passthrough check (`wrapper/passthrough.ts`)**

The text doesn't start with `/`, so it's not a slash command. Passthrough returns null. The turn proceeds to preprocessing.

**3. Prompt preprocessing**

Before classification, Maestro applies several pure-function transforms to the extracted text:

- `wrapper/line-stripper.ts` strips POSIX line-number prefixes (`1\t`, `2\t`) from tool results to remove location metadata that inflates tokens without helping routing. Skipped when RTK is detected on PATH (RTK handles this itself).
- `wrapper/tool-envelope.ts` collapses Claude Code-specific tool_result boilerplate: Write/Edit acknowledgements, TodoWrite confirmations, trailing "file state is current" footers, and interrupted-spawn noise. Produces ~5% fewer bytes on top of RTK's stripping.
- `wrapper/paste.ts` detects paste-heavy prompts (analytics dumps, log tables). When triggered, it condenses the prompt by trimming the middle and keeping the first 350 and last 150 characters so the classifier doesn't overweight structured data.

**4. Override check (`classifiers/override.ts`)**

No `@fast`, `@deep`, or `@think` prefix. Returns `{ class: null }`. Pipeline continues.

**5. Turn-type check (`classifiers/turn-type.ts`)**

Prior turn was a user message (not a tool result). Turn text doesn't match error-recovery patterns. Returns `{ class: null }`. Pipeline continues.

**6. Heuristic classification (`classifiers/heuristic.ts`)**

The text matches the `add_feature_simple` rule (`/\b(add|implement|write)\b.*\b(error handling|validation|logging)\b/i`) at confidence 0.62. This clears the 0.55 threshold. Pipeline short-circuits — stages 4 and 5 never run.

**Classification result:** `{ class: "standard", confidence: 0.62, classifier: "heuristic" }`

**7. First-turn guard (`wrapper/first-turn-guard.ts`)**

This is not the first turn of the session. Guard returns the decision unchanged. (On a fresh session start with an Opus-class prompt, this guard would downgrade the model to Sonnet to avoid a $3–12 cold-boot cost; subsequent turns route freely.)

**8. Tool-volume check (`wrapper/tool-volume.ts`)**

The current turn has accumulated 1 tool call so far — below the 4-call threshold. No upgrade applied.

**9. Classifier cache write (`core/classifier-cache.ts`)**

`sha256("add error handling to the fetch call in src/api.ts")` is written to the in-process LRU with a 24-hour TTL. Next identical prompt skips the pipeline entirely.

**10. Profile resolution (`core/profile.ts`)**

`standard` maps to: `model: claude-sonnet-4-6`, `effort: low` (E1 cost-reduction), `maxBudgetUsd: 0.05`. A brevity hint is selected: "Aim for under 4000 tokens. Prefer code over prose."

**11. Session fingerprint (`wrapper/session.ts`)**

Flags that affect the system-prompt prefix are hashed:
`sha256(["claude-sonnet-4-6", "all", null, false, false, "Aim for under 4000 tokens…"]).slice(0,16)` → `a3f7d2c1e8b940a2`

`getByFingerprint(cwd, "a3f7d2c1e8b940a2")` finds a session from 4 hours ago. **Session reused.** No cold boot cost.

**12. Spawn (`wrapper/spawn.ts`)**

```bash
claude --print --output-format json \
  --session-id a1b2c3d4-… --resume \
  --model claude-sonnet-4-6 --effort low --max-budget-usd 0.05 \
  --append-system-prompt "Aim for under 4000 tokens. Prefer code over prose."
```

stdin receives the prompt text. stdout is piped live to your terminal.

**13. Stream (`wrapper/stream.ts`)**

Tokens stream to your terminal in real time. SIGINT is forwarded so Ctrl-C works normally.

**14. Output parsing (`wrapper/output.ts`)**

Token fields from Claude's JSON envelope (`total_cost_usd` is fabricated on Pro/Team and is not used):
```json
{
  "cache_read_input_tokens": 36840,
  "input_tokens": 142,
  "output_tokens": 287,
  "stop_reason": "end_turn"
}
```

Stop reason is `end_turn` (not `max_tokens`), so the classifier cache entry stays valid.

**15. Telemetry (`core/telemetry.ts`)**

Decision record appended to `~/.maestro/decisions.jsonl`:
```json
{
  "prompt": "add error handling to the fetch call in src/api.ts",
  "decision": { "class": "standard", "classifier": "heuristic", "confidence": 0.62 },
  "cost": { "actual": 0.0083, "hypothetical_opus": 0.048 },
  "sessionId": "a1b2c3d4-…",
  "fingerprint": "a3f7d2c1e8b940a2"
}
```

**Net cost for this turn: $0.0083. Without routing (Opus everywhere): $0.048. Savings: 83%.**

---

## Per-prompt data flow

```
       ┌──────────────────────────────────────────────────────────────┐
       │                       User prompt                            │
       │  (VSCode panel via claudeProcessWrapper, maestro run/shell)  │
       └─────────────────────────────┬────────────────────────────────┘
                                     ▼
       ┌──────────────────────────────────────────────────────────────┐
       │ wrapper/passthrough.ts                                       │
       │   /clear, /model, /help, /cost, /compact → bypass           │
       └─────────────────────────────┬────────────────────────────────┘
                                     ▼
       ┌──────────────────────────────────────────────────────────────┐
       │ Prompt preprocessing (pure functions, applied before class.) │
       │   line-stripper.ts    strip digit+tab prefixes (skips RTK)  │
       │   tool-envelope.ts    collapse CC tool_result boilerplate    │
       │   paste.ts            condense paste-heavy structured input  │
       └─────────────────────────────┬────────────────────────────────┘
                                     ▼
       ┌──────────────────────────────────────────────────────────────┐
       │ core/pipeline.ts — cheap-first, short-circuit at conf ≥ 0.55 │
       │                                                              │
       │  1. override.ts             @fast / @deep / @think           │
       │  2. turn-type.ts            tool_result / continuation       │
       │  3. tool-result-content.ts  content of tool outputs          │
       │  4. tool-override.ts        model hints in tool names        │
       │  5. markov.ts               recent session class history     │
       │  6. heuristic.ts            built-in regex + user rules      │
       │  7. embedding.ts            ONNX cosine sim (optional peer)  │
       │  8. llm.ts                  Haiku --json-schema (opt-in)     │
       │                                                              │
       │  Sub-threshold results → weighted vote. No match → standard. │
       └─────────────────────────────┬────────────────────────────────┘
                                     ▼
       ┌──────────────────────────────────────────────────────────────┐
       │ wrapper/first-turn-guard.ts                                  │
       │   New session + Opus class → downgrade to Sonnet             │
       └─────────────────────────────┬────────────────────────────────┘
                                     ▼
       ┌──────────────────────────────────────────────────────────────┐
       │ wrapper/tool-volume.ts                                       │
       │   ≥4 tool calls this turn → upgrade one model tier          │
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

**Tool-result-content** inspects the text content of tool outputs for patterns that signal complexity — compiler errors, stack traces, large file reads. Routes upward when the content suggests the user is debugging or navigating non-trivial output.

**Tool-override** reads tool names and result metadata for explicit model hints. Returns null if no hint is found.

**Markov** biases the current turn toward the dominant class of the last five turns in this session. Prevents isolated cheap turns from disrupting a consistently complex session. Disabled when K2 escape conditions fire.

**Heuristic** applies 45+ compiled regexes in priority order. The highest-confidence match wins. Built-in rules cover git operations, version bumps, docstring edits, rename/format tasks, debug and production-incident language, architecture and design vocabulary, and the "why is this X" explanation heuristic. User-defined rules from `~/.maestro/heuristics.json` are appended after built-in rules and can override via higher confidence.

**Embedding** (optional peer `@huggingface/transformers` v3 or v4) computes cosine similarity between the prompt embedding and ~60 frozen labeled exemplars. Returns null if the peer isn't installed — the LLM stage is the final fallback. The model used for inference is configurable via `embeddingModel` in `~/.maestro/config.json`.

**LLM** calls Haiku via `--json-schema` with a structured prompt including frozen few-shot examples from `classifiers/fewshot.ts`. Returns a class + confidence. Off by default in the wrapper hot path (adds 2–20s latency); opt in via `useLlmClassifierInWrapper: true`. Used by default in offline eval and tuning workflows.

## Session reuse and cost amortization

The single largest cost driver is `cache_creation_input_tokens` — Claude Code's system prompt is ~37k tokens and gets cached on the first turn of every new session. A naive implementation pays this cost on every class transition because different classes use different flags (`--bare`, `--tools`, `--append-system-prompt`), which changes the system-prompt prefix and busts Anthropic's cache.

**Track Z — system-prompt fingerprinting.** `wrapper/session.ts` keys sessions by `sha256([model, tools, mcpConfig, bare, excludeDynamic, appendSystemPrompt]).slice(0,16)` — a hash of every flag that affects the system-prompt prefix. `getByFingerprint(cwd, fingerprint)` reuses the same session ID whenever the fingerprint matches, regardless of which class produced each turn. Sessions with different fingerprints (e.g. trivial's `--bare` vs standard's full tool set) get separate IDs so they never cross-contaminate. Adjacent-tier fingerprints are prewarmed in the background after each turn via `wrapper/prewarm.ts`, so the next model tier's cache entry is warm before it's needed.

Model swaps within a fingerprint group are safe — verified by spike: Haiku → Sonnet preserves conversation context via `--session-id` + `--resume`.

**First-turn guard.** On the first turn of a new session, `wrapper/first-turn-guard.ts` downgrades any Opus-class routing to Sonnet. A fresh Opus session boot costs $3–12 at ephemeral cache rates; Sonnet runs ~$0.30. Subsequent turns within the session route freely — the downgrade applies only once and is recorded as a `first_turn_guard.opus_to_sonnet` diagnostic.

**E1.escalate.** When a `max_tokens` stop reason is recorded on a `standard` turn, the session is flagged as escalated. On the next turn, `effort: low` is promoted to `effort: medium` for that session, capping the regression at one turn's extra cost. The classifier cache entry for that prompt is also invalidated so the pipeline re-classifies upward.

## Prompt preprocessing

Three pure-function transforms run on every prompt before classification. Each is idempotent and composable.

**Line-number stripping (`wrapper/line-stripper.ts`).** Removes POSIX line-number prefixes (`^\d+\t`) from tool results — the format that `cat -n` and the Claude Code `Read` tool emit. These location markers don't affect routing decisions but inflate token counts. The transform is skipped when RTK is detected on PATH, since RTK handles the same stripping at the I/O layer.

**Tool-envelope compression (`wrapper/tool-envelope.ts`).** Collapses four categories of Claude Code-specific boilerplate that RTK doesn't touch:
- C1: full-block replacement for Write/Edit acknowledgements
- C2: trailing "file state is current in your context" footers
- C3: full-block replacement for TodoWrite confirmations
- C6: noise lines from interrupted tool spawns

Empirical basis: 2,586 real tool_result blocks. Combined savings ~5% on top of RTK.

**Paste detection and condensation (`wrapper/paste.ts`).** Detects prompts dominated by pasted structured data (analytics dumps, log output, tables) rather than natural-language instructions. Triggers when: prompt ≥800 chars, ≥10 non-empty lines, ≤5 code keywords, ≥65% short lines (<60 chars each). When triggered, condenses the prompt by keeping the first 350 and last 150 characters with a `[…N chars trimmed…]` marker, reducing classifier noise from large structured pastes.

## Tool-volume escalation

`wrapper/tool-volume.ts` tracks the number of `tool_use` blocks in each assistant turn. When a turn accumulates ≥4 tool calls — a signal that Claude is executing a multi-step autonomous task — the module upgrades the next turn's model one tier (haiku → sonnet → opus). This prevents long agentic sequences from being misclassified as simple by early-stage classifiers that can't observe future tool call volume.

## Batch-hint advisory

`wrapper/batch-hint.ts` (P9) observes the timing and class of recent prompts. When ≥3 prompts arrive within a 30-second window — a pattern that suggests the user is sending sequential quick-fire questions — it emits a one-shot advisory suggesting they batch related prompts together. This fires purely as a hint; Maestro never buffers or auto-merges prompts.

Empirical basis from real telemetry: 53 clusters / 160 turns over 5 days. Sequential cost was $388; equivalent batched cost ~$95 (mean 67.5% savings per cluster).

## Stream-json control requests

`wrapper/stream-json-frames.ts` parses the Claude Code SDK's `--input-format stream-json` wire protocol. Beyond user messages and tool results, it handles two undocumented `control_request` frame types:

- **`set_model`** — instructs the session to switch models mid-conversation. Maestro intercepts this to keep its session store consistent with the active model.
- **`set_max_thinking_tokens`** — caps thinking tokens per turn (null = uncapped). Maestro uses this in sdk-proxy mode to apply effort routing without having `--effort` available as a spawn-time flag. The subtype was reverse-engineered from the bundled `cli.js` Zod schemas.

## SQLite telemetry backend

On Node 22.5+, `core/db.ts` maintains a SQLite database (`~/.maestro/maestro.db`) alongside `decisions.jsonl`. The database uses Node's built-in `node:sqlite` module — zero new runtime dependencies. `openDb()` returns a singleton; on first open it runs a one-time JSONL→SQLite migration and creates the schema:

```sql
CREATE TABLE events (
  id       INTEGER PRIMARY KEY,
  ts       TEXT NOT NULL,
  type     TEXT NOT NULL,
  session_id TEXT,
  class    TEXT,
  classifier TEXT,
  raw_json TEXT NOT NULL
);
-- indexes on: ts, type, session_id, class, classifier
```

`telemetry.ts` mirrors every `log()` call into SQLite when `dbPath` is configured. `readAll()` prefers SQLite when the database is populated. `stats.ts` uses `readEventsFromDbSince()` for date-filtered scans instead of reading the full JSONL. `export-prompts.ts` uses `collectRowsFromDb()` for SQL-backed queries. On Node < 22.5, all paths fall back to JSONL-only — no configuration required.

## Token pricing

`core/pricing.ts` centralizes all rate tables and cost derivation functions. `computeTurnCost()` calculates the real per-turn cost from token volumes × the model's rates. `computeOpusBaseline()` reprices any set of token counts at Opus rates to derive the "what this would have cost without routing" counterfactual. Both support the 1M-context Opus variant, which costs 2× standard on input and cache tokens.

`total_cost_usd` from Claude Code's JSON output is fabricated on Pro/Team subscriptions. All cost figures in Maestro come from token volumes × rates, never from `total_cost_usd`.

## Auto-compact in sdk-proxy mode

`wrapper/sdk-proxy.ts` implements proactive session compaction. After each turn, it records `lastCacheReadTokens` into the session store. Before forwarding the next user message, it checks whether `cache_read_input_tokens > userConfig.autoCompactThresholdTokens` (default 300k). When the threshold is crossed and `userConfig.autoCompact === true`, Maestro injects `/compact` into the conversation stream before the user message, then clears the flag to avoid double-compaction. If the user manually sends `/compact`, the flag is also cleared.

A `compact` telemetry event is emitted on each injection so `maestro stats` can report a "compact hints" counter alongside the standard cost summary.

## Proactive compaction advisory (run-cmd mode)

`core/compaction.ts` exposes `classifyCompactionCandidate()`, called from `run-cmd.ts` before each spawn. It fires when the prompt exceeds 3k characters AND the current session has accumulated > 80k cached tokens. When both conditions hold it merges a `compaction.candidate` hint diagnostic into the `Decision` record written to `decisions.jsonl`. This gives `maestro stats` a signal for sessions that are compaction candidates even in non-proxy mode.

## Community tuning loop

1. Users with `posthogApiKey` set emit `maestro_override` events when they use `@deep`/`@fast` to correct a routing decision.
2. A weekly GitHub Actions workflow queries PostHog via HogQL, mines override patterns, and commits updated heuristics to `community/heuristics.json`.
3. On every spawn, Maestro checks if 7 days have passed since the last auto-tune. If so, a detached background process fetches `community/heuristics.json`, merges new rules into `~/.maestro/heuristics.json`, and records the timestamp in `~/.maestro/state.json`.

Local tuning (without PostHog) works the same way but draws only from the user's own `~/.maestro/decisions.jsonl`.

## Tournament evaluator

`maestro bench --tournament` validates which downgrades are safe without guessing. For each sampled prompt:

1. **A spawn** — runs at the current assigned class, captures the response
2. **B spawn** — runs one tier cheaper (e.g. standard → simple)
3. **Judge spawn** — Sonnet with `--json-schema` compares both responses and returns `{ winner: "A" | "B" | "tie" }`

The tournament logic lives in `eval/tournament.ts`. `eval/sample-stratified.ts` handles stratified sampling — up to N entries with roughly equal coverage per class, deterministic with an optional seed. Pattern mining over tied/B-win rows surfaces heuristic candidates.

Requires `--confirm-cost` to actually spend money — without it, the command prints a cost estimate only.

## Module layout

```
src/
  core/             Pure logic, zero internal deps.
    types.ts            Domain types: Class, Profile, Decision, SessionContext, …
    cache.ts            LRU + TTL + sha256 keying (pipeline decision cache)
    classifier-cache.ts In-process LRU prompt→class cache; K1 self-invalidation on max_tokens
    classifier.ts       createClassifier factory; validates name/weight/fn at creation time
    config-schema.ts    Zod schema for UserConfig; parseUserConfig with human-readable errors
    telemetry.ts        JSONL writer + SQLite mirror (Node 22.5+); readAll prefers SQLite when populated
    db.ts               MaestroDb interface; openDb() singleton; JSONL→SQLite one-time migration;
                        schema: events table indexed on ts/type/session_id/class/classifier
    langfuse.ts         Optional Langfuse peer; streams decision/outcome/correction events as traces;
                        dynamic import — silently no-ops when peer absent
    compaction.ts       Proactive compaction advisory; classifyCompactionCandidate() fires when
                        prompt >3k chars into a session with >80k cached tokens
    posthog.ts          Fire-and-forget capture + HogQL query client
    pipeline.ts         Short-circuit + weighted vote; Y.guarantee; K2 markov escape; E3 escalation
    pricing.ts          Rate tables + computeTurnCost, computeOpusBaseline, costFromEvent;
                        supports 1M-context Opus variant; never trusts total_cost_usd
    profile.ts          Built-in profiles + layered loader (E1: standard effort=low, X: output caps)
    extract.ts          JSON extraction (fenced + brace-balanced fallback)

  classifiers/      Pipeline stages. Depend only on core/.
    override.ts         @fast / @deep / @think
    turn-type.ts        user_prompt / tool_result / error_recovery / continuation
    tool-result-content.ts  complexity patterns inside tool outputs
    tool-override.ts    model hints in tool names or result metadata
    markov.ts           Recent session class history; K2 escape conditions
    heuristic.ts        Built-in regex + user rules (includes "why is this X" heuristic)
    embedding.ts        ONNX cosine similarity (optional peer; embeddingModel config overrides model)
    llm.ts              Haiku --json-schema fallback
    fewshot.ts          Frozen few-shot examples for LLM classifier (changing invalidates baselines)
    exemplars-seeds.ts  Seed exemplars for embedding classifier

  profiles/         Re-exports for the `profiles` namespace (G5 internal index).
    internal-index.ts   Re-exports balanced/cheap/quality profiles + ALL_CLASSES from core/profile.ts

  wrapper/          Subprocess concerns.
    preflight.ts        Verify Claude CLI version + required flags
    session.ts          Fingerprint-keyed session store (Track Z); getByFingerprint; updateStopReason;
                        persists lastCacheReadTokens per session for auto-compact + stats
    prewarm.ts          Background prewarm of adjacent fingerprint tiers (Z.bootstrap)
    continuation.ts     Two-signal continuation detection (M1); CONTINUATION_HINT injection
    spawn.ts            buildClaudeArgs (pure) + spawnClaude; X.soft class-specific brevity hints
    stream.ts           Live pipe + capture + signal forwarding
    stream-json-frames.ts  Frame parsing for sdk-proxy; set_model + set_max_thinking_tokens control requests
    sdk-proxy.ts        Per-turn routing proxy (VSCode panel + maestro shell);
                        auto-compact: injects /compact when cache_read > autoCompactThresholdTokens
    sdk-host.ts         Human SDK host for maestro shell (stream-json REPL)
    passthrough.ts      Slash-command bypass
    output.ts           Parse --output-format json → CostBreakdown
    line-stripper.ts    Strip POSIX line-number prefixes from tool results (skips when RTK on PATH)
    tool-envelope.ts    P7: collapse CC-specific tool_result boilerplate (~5% savings on top of RTK)
    paste.ts            Detect + condense paste-heavy structured prompts (analytics dumps, logs)
    tool-volume.ts      ≥4 tool calls this turn → upgrade model one tier
    first-turn-guard.ts New session + Opus class → downgrade to Sonnet (avoids $3–12 cold-boot)
    batch-hint.ts       P9: detect rapid sequential prompts; emit batching advisory (one-shot)

  cli/              Commander shell.
    index.ts            Entry point; registers all commands
    run-cmd.ts          maestro run — K1 cache; M1 continuation; Track Z fingerprint; E1.escalate post-turn;
                        compaction advisory (classifyCompactionCandidate merges hint into Decision)
    shell-cmd.ts        maestro shell — interactive REPL entry point; seeds Markov from prior session
    init.ts             maestro init — idempotent setup wizard; orchestrates four install steps in sequence
    doctor.ts           maestro doctor — non-destructive environment checker (Node, Claude CLI, config, VSCode)
    install-hook.ts     maestro install-hook — write Stop-event feedback hook into ~/.claude/settings.json
    install-vscode.ts   maestro install-vscode — write claudeProcessWrapper into VSCode user settings.json
    install-commands.ts Helper: register install-* subcommands
    install-defaults.ts Helper: write default config and heuristics files
    guide.ts            maestro guide — post-install checklist
    export-prompts.ts   maestro export-prompts — relabel-ready JSONL; --fallbacks reads fallbacks.jsonl;
                        --setfit outputs {text, label} for SetFit training; SQL-backed on Node 22.5+
    export-corrections.ts  maestro export-corrections — override correction signal for LLM tuning;
                        output compatible with scripts/dspy-optimize.py
    telemetry-cmd.ts    maestro telemetry {status,show,feedback,langfuse,off,forget}
    tune.ts             Telemetry analysis, community fetch, auto-tune
    stats.ts            Cost vs Opus-everywhere baseline; session boot dominance warning;
                        compact hints counter; SQL-filtered scan when db available
    health.ts           Baseline snapshot comparison; regression detection >10%
    oracle.ts           maestro oracle — wires all four oracle dimensions; --confirm-cost for quality
    bench.ts            Eval (defaults to bundled evals/labeled.jsonl) + tournament
    replay.ts           JSONL replay against current pipeline
    wire-compat.ts      Wire-compatibility layer for claudeProcessWrapper; pass-through for mgmt subcommands
    render.ts           ANSI color helpers (bold, cyan, green, red, dim, header)
    utils.ts            Shared constants (DEFAULT_CONFIG_DIR, DEFAULT_USER_CONFIG)

  eval/oracle/      Oracle evaluation layer — pure computation, no subprocess spawning.
    reader.ts               loadWindow, groupBySession, pairDecisionsWithOutcomes
    telemetry-correctness.ts 4 checks: cost reconciliation, fallback rate, cache hit rate, outcome linkage
    tool-correctness.ts     5 checks: fingerprint stability, flag coverage, E1 escalation, K1 invalidation, M1 two-signal
    tokens-saved.ts         savings vs Opus-everywhere baseline; E1/Track Z/X isolation by date
    output-quality.ts       truncation rate check; bench-accuracy + E1 tournament stubs (--confirm-cost)
    report.ts               OracleReport type; buildReport; printReport (human + JSON)

  eval/
    tournament.ts       Full tournament implementation: A/B/judge spawns, stratified sampling,
                        pattern mining, MatrixResult and TournamentReport types
    sample-stratified.ts  Pick up to N entries with equal per-class coverage; deterministic with seed
```

## Configuration layers

Loaded in priority order (later layers override earlier):

1. **Built-in profile** (`balanced` / `cheap` / `quality`)
2. **User config** (`~/.maestro/config.json`) — profile, aggressiveness, cost caps, classifier flags
3. **Profile overrides** (`~/.maestro/profile-overrides.json`) — per-class model/effort/budget tweaks
4. **User heuristics** (`~/.maestro/heuristics.json`) — regex patterns → class
5. **Per-project config** (`<repo>/.maestro/`) — allowed fields only (`profile`, `excludeDynamicSections`, `useEmbeddingClassifier`)

Fields that affect telemetry paths, billing caps, and hot-path latency are global-only. A committed `.maestro/config.json` in a shared repo cannot silently affect teammates on those dimensions.

`core/config-schema.ts` validates user config through a Zod schema (`parseUserConfig`) on every load. Unknown keys are silently stripped (`.strip()`). Type errors and invalid enum values throw `ConfigValidationError` with a human-readable message listing every bad field. A compile-time drift guard (`SchemaCoversUserConfig`) causes a TypeScript error if a field is added to `UserConfig` but omitted from the schema.

## Pipeline hardening

**Y.guarantee.** When no classifier fires above threshold and the weighted vote produces no clear winner, the pipeline falls back to `class: "standard", classifier: "forced.standard", confidence: 0.1`, and attaches a `fallback.forced_standard` diagnostic. `maestro stats` tracks this separately from genuine standard classifications, giving a debuggable signal for classifier coverage gaps.

**K2 — Markov lock-in escape.** `pipeline.ts` breaks the Markov chain when the current prompt is >2.5× the rolling session average length, contains escalation keywords (`architect`, `design`, `production`, `incident`, etc.), includes an `@override` directive, or the prior turn stopped at `max_tokens`. When any escape condition fires, the cached classification is discarded and the full pipeline runs.

**E3 — Reasoning effort escalation.** When a turn is classified as `reasoning` or `max`, E3 checks three signals: an `entropy_escalation` diagnostic from any classifier, 3+ consecutive reasoning/max turns in the last 5, and a prior `max_tokens` stop reason. When 2 of 3 signals fire, the effort is promoted to `high` and a `reasoning.effort_escalated` diagnostic is emitted.

**X — Output token discipline (soft caps via system prompt).** The Claude CLI has no `--max-tokens` flag, so X is enforced through `--append-system-prompt` brevity hints. trivial: "Output only the answer." simple: "Be concise. Skip preamble." standard: "Aim for under 4000 tokens. Prefer bullets and code over prose." hard/reasoning/max: no hint (suppress constraint on complex tasks).

**K1 — Classifier result cache.** An in-process LRU cache (`src/core/classifier-cache.ts`) stores `sha256(prompt) → Classification` with a 24-hour TTL and 1000-entry limit. Cache hits skip the full pipeline on repeated or near-identical prompts. When a turn completes with `stopReason: "max_tokens"` on a `standard` class, the cache entry for that prompt is invalidated so the next identical prompt re-classifies upward.

**M1 — Two-signal continuation.** `wrapper/continuation.ts` requires two simultaneous signals before routing a continuation to simple class: the linguistic pattern match AND `priorStopReason === "max_tokens"`. Single-signal matches proceed to the normal pipeline. When both signals fire, Maestro injects `CONTINUATION_HINT` ("Resume from where you stopped. No recap. Continue directly.") as the `appendSystemPrompt`, overriding the standard brevity hint.

## Langfuse integration

`core/langfuse.ts` streams routing events to Langfuse as traces. The peer (`langfuse` npm package) is dynamically imported on first use — when it's absent the module silently no-ops. Three event types are streamed: `decision` (classifier result + model profile selected), `outcome` (token counts + stop reason after the spawn), and `correction` (when the user applies an `@fast`/`@deep` override to fix a misroute). Configured via `maestro telemetry langfuse --public-key … --secret-key … [--host …]`, which writes keys to `~/.maestro/config.json`.

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

## Setup commands

**`maestro init`** runs the four install steps in sequence — defaults, VSCode wiring, commands, feedback hook — and reports each step's status (`written` / `already-present` / `failed`). Idempotent: safe to run more than once.

**`maestro doctor`** checks the environment without writing anything: Node.js version (≥20), Claude CLI version (≥2.1.0), VSCode `claudeProcessWrapper` setting, user config validity, and maestro binary path. Reports pass/fail per check with a suggested fix when applicable.

**`maestro install-vscode`** writes the path of the current maestro binary into the `claudeCode.claudeProcessWrapper` field of VSCode's user `settings.json`. Supports `--dry-run`, `--uninstall`, and explicit `--wrapper` and `--path` overrides.

**`maestro install-hook`** installs `stop-feedback.sh` into `~/.maestro/hooks/` and registers it as a `Stop` event hook in `~/.claude/settings.json`. The hook prompts for quality feedback after Maestro responses, controlled by `feedbackPrompts` and `feedbackSampleRate` in user config. Deduplicated via an embedded `HOOK_MARKER` tag.

## Known behavioral notes

**`--max-budget-usd` is a soft cap.** Verified during a spike: a `$0.01` cap on a long-essay prompt resulted in `$0.063` actual cost (6.3× overrun). The output parser detects `subtype: error_max_budget_usd` and emits a `claude.budget_exceeded` diagnostic. Profile defaults are sized with this margin in mind.

**`--bare` requires four conditions.** The profile must enable it, the heuristic must tag the prompt `bare_safe`, no `@fast+context` override must be present, and the auth method must be API key (not OAuth). All four are checked in `wrapper/spawn.ts`.

**Runtime dependencies.** `commander` (CLI framework) and `zod` (config validation) are runtime dependencies. Optional peers are `@huggingface/transformers` (embedding classifier, v3 or v4) and `langfuse` (tracing integration).

Details and spike results in [router-observations.md](router-observations.md).
