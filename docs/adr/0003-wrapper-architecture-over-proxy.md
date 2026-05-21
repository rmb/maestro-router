# ADR-0003 · Wrapper architecture over HTTP proxy

## Status

Accepted · 2026-05-21

## Context

The original plan had Maestro intercept Anthropic API calls via Claude Code
Router (CCR), an HTTP proxy that sits between Claude Code and the Anthropic
API. Users would run CCR locally on port 7000, set `ANTHROPIC_BASE_URL` to
point at it, and CCR would invoke Maestro as its custom router.

That design assumed users had an Anthropic API key. During planning we
discovered that Maestro's primary user (CTO at kununu — see
[../PROJECT_BRIEF.md](../PROJECT_BRIEF.md)) has a Claude Team subscription
and explicitly does not want API access. The CCR/proxy approach cannot
intercept OAuth-authenticated Claude Code requests because the auth tokens
are scoped to Anthropic's first-party endpoints, not arbitrary HTTP
endpoints.

## Decision

Maestro becomes a **CLI wrapper** that spawns `claude --print` as a
subprocess per turn, passing the appropriate flags (`--model`, `--effort`,
`--max-budget-usd`, `--session-id`, `--resume`, `--output-format json`).
Users invoke `maestro` instead of `claude` (terminal) or set
`claudeCode.claudeProcessWrapper` in VSCode settings.

## Rationale

Verified during planning via two spikes:

### Spike 1 — Session continuity survives model swap

```bash
SID=$(uuidgen)
echo "My favorite color is purple." | claude --print --session-id "$SID" --model haiku
# → "Purple."
echo "What is my favorite color?" | claude --print --resume "$SID" --model sonnet
# → "Purple."
```

Conversation context survives the model swap. This means Maestro can
classify each turn independently and route it to the cheapest model that
will produce the right answer, without breaking the user's ongoing
conversation.

### Spike 2 — Exact token + cost data from `--output-format json`

```json
{
  "total_cost_usd": 0.04850775,
  "usage": {
    "input_tokens": 9,
    "output_tokens": 234,
    "cache_creation_input_tokens": 37863,
    "cache_read_input_tokens": 0
  }
}
```

Maestro gets exact cost and token counts per turn — no estimation. This
drives the `stats` and `bench` commands with real numbers.

### Why this beats the proxy approach

- Works with any Claude Code auth (API key, Pro, Team, Bedrock, Vertex).
- No long-running daemon to manage. No `launchctl`/`systemd` units.
- No `ANTHROPIC_BASE_URL` redirect that breaks when the daemon is down.
- No HTTPS cert / TLS termination concerns on localhost.
- VSCode panel UI is covered via `claudeCode.claudeProcessWrapper` setting
  in the official extension — same as the terminal.

## Alternatives considered

- **CCR / HTTP proxy** — original plan. Rejected because of OAuth/auth
  scope incompatibility with subscription users. Could come back as an
  optional "API mode" in v0.3 for users with API access who want lower
  per-prompt latency (subprocess startup ~50ms).
- **Anthropic SDK middleware** — wrap the SDK in user code. Doesn't help
  for Claude Code itself; user can't modify Claude Code internals.
- **Claude Code hook (PreToolUse / UserPromptSubmit)** — hooks can add
  context but cannot inject CLI flag changes like `--model`. Wrong layer
  for model routing.

## Consequences

- Maestro pays ~50ms of subprocess startup per turn. Negligible relative
  to Claude API latency (1–10s typical) and Claude CLI startup
  (~hundreds of ms).
- Maestro depends on Claude CLI flags being stable. Mitigation:
  `wrapper/preflight.ts` verifies version + required flags at startup;
  errors with clear upgrade instructions on mismatch. Tested against
  Claude CLI 2.1.112.
- Cannot intercept mid-session prompts in an interactive (non-`--print`)
  Claude Code session — `--print` mode is one-shot. Users get
  Maestro-routed behavior for every turn they pipe through `maestro`,
  which is the default flow when `claudeProcessWrapper` is set.
