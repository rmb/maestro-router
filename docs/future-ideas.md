# Future Ideas

Backlog of ideas considered during planning that are NOT being built in v0.2.
Each entry includes rationale so future contributors can re-evaluate.

## Recently Shipped (v0.2.3+)

### ~~C1: Always-log decision telemetry~~ — Shipped v0.2.3
Moved telemetry creation before the `if (parsed)` conditional so decision
events are logged even when parsing fails or interrupts occur. Cost field is
optional (null when event has no cost data). Enables accurate decision-event
counting in stats independent of output parse success. See `src/cli/run-cmd.ts`.

### ~~G2: MaxOutputTokens hint emission~~ — Shipped v0.2.3
Emit `"Keep response under N tokens."` hint for hard/reasoning classes when
`spec.maxOutputTokens` is set, even when CLASS_BREVITY is empty (classes that
suppress default hints). Helps Claude output-gate tokens beyond requested cap.
See `src/wrapper/spawn.ts::resolveAppendSystemPrompt()`.

### ~~Task 3: P90 duration per class in stats~~ — Shipped v0.2.3
Added `durationApiMsP90ByClass: Partial<Record<Class, number>>` to stats
summary, computed as 90th percentile of API call durations grouped by routing
class. Identifies tail latency per class (only includes classes with data).
See `src/cli/stats.ts`.

### ~~K2: Markov short-circuit in pipeline~~ — Shipped v0.2.3
Uses recent routing class history (last ≤5 classes from session state) to
predict current class via hardcoded markov transition matrix trained on real
Maestro data. Short-circuits all classifiers when confidence ≥ 0.75, avoiding
expensive embedding/LLM classifiers on predictable sequences. See
`src/classifiers/markov.ts`.

### ~~I1: Line-number stripping in SDK proxy~~ — Shipped v0.2.3
Strips POSIX line-number prefixes (`^\d+\t`) from tool result blocks before
forwarding to Claude. Reduces token inflation from location metadata in Read
tool output. Idempotent regex-based stripping with <1ms budget. See
`src/wrapper/line-stripper.ts`.

## Deferred to v0.3 (specified, will revisit)

### ~~Remote PostHog telemetry (S1)~~ — Core shipped; consent UX deferred
`posthogApiKey` in `~/.maestro/config.json` opts in; `run-cmd.ts` emits
`maestro_decision` + `maestro_override` events on every spawn. `tune --posthog`
mines cross-user correction patterns via `core/posthog.ts`. Opt-out: remove
the key. Formal `telemetry off`/`forget` CLI subcommands and a PostHog-specific
ADR remain deferred to v0.3.

### ~~Embedding classifier (S2)~~ — Shipped in v0.2.2
`@xenova/transformers` peer, ONNX local embedding via
`Xenova/all-MiniLM-L6-v2`, build-time `pnpm embed` script, `exemplars.json`
+ sha256 `seedsChecksum` drift gate (verified at runtime *and* by the
`prebuild` script), runtime fail-soft when the peer is missing. Runs between
`heuristic` and `llm` so it can short-circuit before paying the LLM cost.
Opt out with `userConfig.useEmbeddingClassifier = false`. See
`src/classifiers/embedding.ts`.

### ~~LLM classifier via `--json-schema` (S12)~~ — Shipped in v0.2.1
`claude --print --model haiku --json-schema '{...}'` returns structured JSON.
Brings back the LLM classifier without API access — just spawn Haiku via CLI
for ambiguous prompts. ~$0.001 per uncertain prompt. Runs *after*
override + turn-type + heuristic, only fires on prompts none of them matched.
Anti-injection wrapping via `<PROMPT_TO_CLASSIFY>` tags. Opt out with
`userConfig.useLlmClassifier = false`. Oracle-mocked eval lifts accuracy from
83.94% → 91.24% (upper bound; live Haiku will be lower).
See `src/classifiers/llm.ts`.

### ~~Tournament with real Claude (S4 single-axis)~~ — Shipped in v0.2.1
`maestro bench --tournament --confirm-cost` runs the single-axis model-tier
downgrade tournament with real Claude calls and a Sonnet judge. For each
sampled prompt it spawns A (current tier) + B (one tier cheaper) + judge,
aggregates per-class win rates, and mines token patterns from winning
prompts. Sequential, budget-capped, and `--tournament-output` writes a
proposal validatable via `bench --propose`. See `src/eval/tournament.ts`.

### ~~Tournament matrix (S4, C6 expansion)~~ — Shipped
`bench --tournament-matrix` tests same-model effort-step-down per prompt in
addition to the model-tier downgrade. Aggregates per-class `MatrixResult[]`
alongside the standard win-rate table. See `src/eval/tournament.ts` and
`src/cli/bench.ts`.

### ~~Per-tool profile overrides (C12)~~ — Already shipped
Implemented in `src/classifiers/tool-override.ts`. Uses sdk-proxy metadata
injection to track tool_use_id → tool_name, then classifies: Read/Grep/LS/Glob
→ trivial, Edit/Write/MultiEdit → simple, Bash → simple. Confidence 1.0,
<1ms budget. Integrated in pipeline after override/turn-type classifiers.

### ~~Per-project config (F2)~~ — Already shipped
Walk-up discovery from cwd in `src/cli/utils.ts::loadCliConfig()`. Finds
`.maestro/config.json` up to root (excludes `~/.maestro`). Merges: project
wins ties on UserConfig keys; per-class ProfileOverride stacks on top of
global; heuristics lists concatenate. Field filtering blocks unsafe overrides
(telemetryPath, feedbackSampleRate, useLlmClassifierInWrapper stay global).

### ~~Interactive feedback Stop-hook (F7)~~ — Shipped in v0.2.1
`hooks/stop-feedback.sh` runs on Claude Code's Stop event; sampling controlled
by `feedbackPrompts` (`never` | `occasional` | `always`) and `feedbackSampleRate`
in `~/.maestro/config.json` (default 0.2 = 1-in-5). Recorded via
`maestro telemetry feedback <sid> --rating <n> --auto`, distinguishable from
manual ratings by `source: "auto"`. Install with `maestro install-hook`
(idempotent; `--uninstall` removes only Maestro's entry).

### ~~`maestro init` and `maestro doctor` commands~~ — Shipped
`maestro init` runs all four install steps (defaults, vscode, commands, hook)
idempotently with per-step status. `maestro doctor` runs non-destructive
environment checks (Node version, claude binary, VSCode wiring, config files,
telemetry dir). See `src/cli/init.ts` and `src/cli/doctor.ts`.

### `--fast-mode` cost profile (S13) — blocked on Anthropic
Spiked 2026-05-25: `--fast-mode` CLI flag not yet available. JSON output
already includes `fast_mode_state: "off"` and `speed` fields, so the
infrastructure is there. When the flag ships, check if cost differs from
standard mode — if so, add as a per-class routing dimension. See
`docs/spike-fast-mode-s13.md` for full spike notes.

### API mode (CCR adapter, SDK middleware)
For users with API access who want lower per-prompt latency. The wrapper has
~50ms subprocess startup overhead per turn; direct API call has none. Worth
adding as an alternative mode once the wrapper is proven.

## Considered but not pursued (rationale captured)

### Speculative parallel routing
Minimizes latency by burning tokens (route to multiple models in parallel,
return first acceptable). Wrong direction for cost minimization. Re-consider
if/when latency becomes the binding constraint.

### Dynamic prompt rewriting
Strip non-essential context for low-class actions to reduce input tokens.
Semantic risk: could change behavior unpredictably. Re-consider only if a
safe extraction heuristic emerges.

### Sub-prompt decomposition
Split multi-action prompts and route each. Requires an LLM call to save LLM
calls — net benefit unclear. Re-consider if a cheap heuristic decomposer
(regex/grammar) becomes feasible.

### Single-profile distribution (S5)
Ship only `balanced`. Minor file-count reduction; presets are nearly free.
Three profiles retained.

### Upgrade-tournament evals
Test upgrading classes to detect quality regression from downgrades.
Valuable safety net but adds bench complexity. Defer until v0.2 telemetry
surfaces a quality issue worth measuring.

### Embedding model lazy-load + RAM cap
Only relevant after S2 reversed (embedding restored).

### Self-correction loop sub-detector
Folded partially into C10 turn-type classifier (`error_recovery` type). A
richer sub-detector (counts consecutive failures, distinguishes test-failure
from lint-failure) could refine upgrade decisions in v0.3.

### Prefill optimization for structured outputs
N/A without an LLM classifier (deferred with it).

### Output length prediction
Heuristic predicting output length to set `--max-budget-usd` dynamically.
The static per-class caps get most of the benefit.

### PTY-based interactive intercept
Wrap interactive `claude` sessions (without `--print`) by pseudo-terminal
multiplexing. Significantly more complex; `--print` mode covers single-turn
well enough for v0.2. Re-consider if users demand mid-session intervention.

### Bedrock and OpenAI/Codex compatibility
Out of scope for the Claude-only focus of v0.2.

## Activation milestones

- **v0.2.1** — bugfixes, hardening, expanded built-in heuristics based on
  real telemetry
- **v0.3** — pull deferred items above based on user demand + v0.2 telemetry
  signals
