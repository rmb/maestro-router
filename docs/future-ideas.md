# Future Ideas

Backlog of ideas considered during planning that are NOT being built in v0.2.
Each entry includes rationale so future contributors can re-evaluate.

## Deferred to v0.3 (specified, will revisit)

### Remote PostHog telemetry (S1)
Opt-in anonymous usage data to improve routing across users. Includes
`core/telemetry-remote.ts`, consent flow, CLI `off`/`forget` subcommands,
ADR-0005, PostHog EU project + dashboards. v0.2 ships local-only telemetry.

### Embedding classifier (S2)
`@xenova/transformers` peer, ONNX local embedding via
`Xenova/all-MiniLM-L6-v2`, build-time `pnpm embed` script, `exemplars.json`
+ `seeds.checksum` (R3 mitigation), runtime fail-open if peer missing. v0.2
relies on override + turn-type + heuristic.

### LLM classifier via `--json-schema` (S12)
`claude --print --model haiku --json-schema '{...}'` returns structured JSON.
Brings back the original LLM classifier without requiring API access — just
spawn Haiku via CLI for ambiguous prompts. Adds ~$0.001 per classifier call
(Haiku via subscription). Worth re-introducing in v0.3 when v0.2 telemetry
shows where heuristic + turn-type + override leave gaps.

### Tournament matrix (S4, C6 expansion)
Expand `bench --tournament` from single-axis model-tier downgrade to a model
× effort matrix per class. Surfaces wins from budget reduction independent
of model tier.

### Per-tool profile overrides (C12)
Adapter-layer hook to detect upcoming tool call in conversation and apply
tool-specific class: Read/Grep/LS/Glob → trivial, Edit → simple, Bash →
simple unless chained, Write → standard. v0.2 has no adapter layer; rebuild
as a Claude Code hook integration in v0.3.

### Per-project config (F2 hook)
`<cwd>/.maestro/config.json` discovered by walking up from cwd. Config
loader has the hook in v0.2 but discovery is disabled until v0.3.

### Interactive feedback Stop-hook (F7)
Automated 👍/👎/skip prompt after each response, recorded as feedback events.
Hook script shipped in `hooks/` in v0.2 but not enabled by default.

### `maestro init` and `maestro doctor` commands
Convention setup + environment diagnostics. Manual setup works in v0.2 via
README instructions.

### `--fast-mode` cost profile (S13)
Spike 2 output included `"fast_mode_state": "off"`. Anthropic's fast mode
may be a speed-only tier or may have a separate cost dimension. One quick
spike to clarify before deciding whether to expose per-class.

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
