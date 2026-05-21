# Maestro · Project Brief

## Mission

A CLI wrapper that classifies each Claude Code prompt and routes it to the
optimal model + thinking budget. Works on Claude Pro/Team subscriptions — no
API key required.

**Target:** ~70–80% cost reduction vs default Claude Code at ≥95% quality
parity, with zero infrastructure dependencies beyond the user's existing
Claude Code install.

## Why this exists

Claude Code defaults to one model per session (typically Sonnet or Opus). In
practice, most coding prompts don't need the full power of the most expensive
model — many are formatting, renaming, simple edits, or follow-ups to a tool
call where the LLM is just deciding what to do next with a known result.

Manually switching models per prompt is tedious and error-prone. Maestro
classifies each prompt automatically and picks the smallest model + smallest
thinking budget that will still produce the right answer.

## What ships in v0.2

- A CLI binary `maestro` that wraps `claude --print`
- A classifier pipeline (override → turn-type → heuristic, short-circuit at
  0.6 confidence)
- A profile system mapping each complexity class to `{model, effort,
  maxBudgetUsd, tools?, bare?, mcpConfig?}`
- Session continuity via `--session-id` + `--resume` so the conversation
  survives model swaps mid-thread
- Real token + cost telemetry parsed from `--output-format json`
- Fine-tuning commands: `stats`, `tune` (incl. `--learn` for pattern mining),
  `replay`, `bench` (incl. `--propose` and `--tournament`), `telemetry
  feedback`
- Three editable config files in `~/.maestro/` for user customization:
  - `config.json` — global preferences
  - `profile-overrides.json` — per-class model/effort/budget tweaks
  - `heuristics.json` — custom regex patterns
- Two integration paths for VSCode:
  - **Terminal**: invoke `maestro` instead of `claude`
  - **Extension panel UI**: set `claudeCode.claudeProcessWrapper` to
    `<which maestro>` in VSCode settings

## What's explicitly out of scope for v0.2

See [tasks/todo.md → Backlog](../tasks/todo.md) for the full list. Highlights:

- Remote anonymized telemetry (PostHog) — deferred to v0.3 with opt-in flow
- Embedding-based classifier (`@xenova/transformers`) — heuristic + override
  + turn-type cover v0.2's needs
- LLM-as-classifier — re-introducable via `claude --print --json-schema` in
  v0.3 (no API needed)
- API mode (CCR adapter, Anthropic SDK middleware) — only relevant if/when
  per-prompt subprocess startup becomes a measurable bottleneck
- Bedrock, OpenAI/Codex compatibility — out of scope for the Claude-only
  focus of v0.2

## Spike-verified assumptions

The wrapper architecture rests on two facts verified by running spikes
during planning:

1. **Session continuity survives model swap.** A session started with Haiku
   and resumed with Sonnet preserved context (planted fact recalled
   correctly across the swap). Verified with Claude CLI 2.1.112 on Team
   OAuth.

2. **`--output-format json` returns exact token counts and cost.** No
   estimation needed. The JSON includes `total_cost_usd`, separate input /
   output / cache_read / cache_creation tokens, exact model variant used,
   duration, stop_reason, and service tier. This drives all telemetry.

These were the two highest-risk assumptions. Both held.

## Reference

- Public API surface and full module specification: [tasks/todo.md](../tasks/todo.md)
- Architecture decisions: [docs/adr/](adr/)
- External pattern credits: [docs/INSPIRATION.md](INSPIRATION.md)
