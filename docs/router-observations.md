# Router Observations

Notes on Claude CLI behavior, edge cases, and routing decisions that need
human judgment. Each entry: date-stamped H2 section, plain markdown.

## 2026-05-21 · Spike 1 — session continuity across model swap

Verified that `claude --print --session-id <uuid>` followed by
`claude --print --resume <uuid> --model <different>` preserves context.

Test:
```
SID=$(uuidgen)
echo "My favorite color is purple. Acknowledge with one word." \
  | claude --print --session-id "$SID" --model haiku
# → "Purple."
echo "What did I just say is my favorite color? Answer with one word." \
  | claude --print --resume "$SID" --model sonnet
# → "Purple."
```

Conclusion: model swap mid-conversation is safe on Team subscription.

## 2026-05-21 · Spike 2 — `--output-format json` exposes exact cost

A trivial `say hi` prompt on Haiku returned (excerpt):
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

Key finding: the `cache_creation_input_tokens: 37863` is the Claude Code
system prompt being cached on first invocation. Every fresh `claude --print`
session pays this once. Subsequent turns on the same session_id read from
cache cheaply. This is the strongest argument for aggressive session reuse
(plan F9) and for `--exclude-dynamic-system-prompt-sections` (plan S7) to
maximize cross-session cache hits.
