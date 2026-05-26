# Cost Optimization Deep Dive — Implementation Plan

> Source: 7 parallel white-hat investigations of Claude Code public surface (2026-05-25).
> Each item references the agent that produced the finding.

## Executive summary

13 concrete improvements ranked by `(impact / effort)`. Top 3 single-shot wins:

1. **Fix silent cache misses** — `computeFingerprint` hashes 3 of 6+ cache-affecting dimensions. Every class swap inside a model currently pays `cache_creation` it shouldn't. (P1)
2. **Detect 2× Opus billing** — Claude Code silently uses the 1M-context Opus variant (`claude-opus-4-7[1m]`) which costs 2× normal input. Maestro doesn't parse this. (P2)
3. **Enable effort control in VSCode panel mode** — Maestro's sdk-proxy currently has zero effort control (only `set_model`). The reverse-engineered `set_max_thinking_tokens` control_request enables real per-turn thinking budgets. (P3)

Estimated combined annual savings on a heavy-use account: **$2,000–4,000** plus quality wins from proactive rate-limit handling.

## TIER 1 — Quick wins

### P1. Fix `computeFingerprint`
Extend fingerprint to hash all 6 dimensions (tools, mcpConfig, appendSystemPrompt). Move M1 continuation hint to user message. Pin stable trailer for empty appendSystemPrompt classes.

### P2. Detect `[1m]` Opus variant
Parse `claude-opus-4-7[1m]` suffix in `parseOutput`. Log warning when 1M variant used unnecessarily.

### P3. Inject `set_max_thinking_tokens`
Add `buildSetThinkingTokensRequest` builder. Inject alongside `set_model` in sdk-proxy based on `decision.spec.effort`. Maps: low→2048, medium→8192, high→null.

## TIER 2 — Telemetry foundation

### P4. Split `cache_creation` ephemeral 1h vs 5m
Anthropic charges 2× for 1h tier. Surface in `maestro stats`.

### P5. Add `sessionId` + `turnIndex`
Required for batch detection, break-even analysis, per-session optimization.

### P6. Parse `rate_limit_event`
Switch sdk-proxy to verbose stream. Proactively downgrade before quota errors.

## TIER 3 — Compression

### P7. Tool envelope compression
New `tool-envelope.ts`. Collapse Claude Code-specific boilerplate:
- C1: Write/Edit ack-only blocks (375/2586 = 2.92%)
- C2: Trailing footer strip (1.21%)
- C3: TodoWrite ack collapse (0.84%)
- C6: Drop stream-closed error chaff

## TIER 4 — Profile extensions

### P8. Extend tools/mcpConfig to standard class
Add `mcpConfig: '{"mcpServers":{}}'` to standard/hard. Add `readonly_safe` heuristic for tool restriction.

## TIER 5 — Features

### P9. Batch-hint advisor
Detect 2+ short prompts in 30s. Emit advisory hint.

### P10. `get_context_usage` probe
Probe before routing. Suggest `/compact` when cache_read > 500k tokens.

## TIER 6 — Spikes

### P11. `--system-prompt` full replacement for @raw mode
### P12. `can_use_tool` interception for trivial turns
### P13. `--disable-slash-commands` measurement

## Order of operations

Sprint 1: P1, P2, P5 (bug fixes + telemetry foundation)
Sprint 2: P3, P4, P6 (protocol exploitation)
Sprint 3: P7 (compression)
Sprint 4: P8, P9, P10 (features)
Spikes: P11, P12, P13 (measurement scripts)
