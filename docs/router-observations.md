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

## 2026-05-21 · Spike R8 — `--max-budget-usd` enforcement is soft

Ran `echo "write a 1000-word essay about how quantum computing works" |
claude --print --max-budget-usd 0.01 --output-format json --model haiku`.

The CLI honored the cap by terminating, but only at a coarse checkpoint:

```json
{
  "type": "result",
  "subtype": "error_max_budget_usd",
  "is_error": true,
  "stop_reason": "end_turn",
  "total_cost_usd": 0.06260525,
  "errors": ["Reached maximum budget ($0.01)"],
  "usage": { "input_tokens": 0, "output_tokens": 0 },
  "modelUsage": {
    "claude-haiku-4-5-20251001": { "inputTokens": 9, "outputTokens": 2441, "costUSD": 0.06260525 }
  }
}
```

**Implications for Maestro:**

1. The cap is a backstop, not a hard guarantee. Actual cost can exceed by
   several × (6.3× in this run).
2. Top-level `usage.output_tokens` is 0 on budget-error; the real count is
   in `modelUsage[<model>].outputTokens`. Output parser must look there too.
3. The specific failure mode is identifiable by `subtype:
   "error_max_budget_usd"` plus `errors` array.
4. Profile defaults need margin: set `maxBudgetUsd` ~50% above expected,
   not at exact expected, to avoid normal completions triggering it.

**Action items rolled into module 16 (output.ts):**
- Detect `subtype === "error_max_budget_usd"` and emit
  `claude.budget_exceeded` diagnostic (with the cap that was hit and the
  realized cost so user sees the overrun).
- Fall back to `modelUsage[*].outputTokens` when top-level `usage.output_tokens`
  is 0 (budget-error case).
- Adjust profile `maxBudgetUsd` defaults upward in v0.2.1 if real telemetry
  shows budget errors in normal completions.

## 2026-05-21 · Phase 2 smoke — end-to-end wrapper works; model swaps cost cache

Ran two smoke turns via examples/smoke.ts:

**Turn 1** ("rename foo to bar", new session, Haiku):
- cache_create: 14,429 (vs 37,863 in spike 2 without S7)
- cost: $0.020 (vs $0.048 in spike 2)
- **~60% reduction** on the system-prompt cache cost from
  `--exclude-dynamic-system-prompt-sections` (S7) + `--tools Read,Edit` (S8) +
  `--strict-mcp-config --mcp-config '{"mcpServers":{}}'` (S9).

**Turn 2** ("what is the file extension in foo.bar.tsx?", same session, Sonnet):
- `--resume <uuid>` preserved conversation context ✓
- cache_read: 11,240 (conversation prefix reused from prior turn)
- BUT cache_create: 15,521 (Sonnet had no prior cache; fresh cache write)
- cost: $0.062 (Sonnet token rates × cache write)

**Finding: model swaps within a session incur cache_creation on the new
model.** Prompt cache is keyed by `(content, model)`, so switching from
Haiku to Sonnet within a session pays the cache-create cost for Sonnet on
that turn. Subsequent same-model turns benefit from cache_read.

**Implications:**
- Maestro's classification should bias toward model stability where
  quality permits — bouncing between models per turn defeats prompt
  caching even with session reuse.
- The fine-tuning loop (`maestro tune --learn`) should detect rapid
  model-tier churn as a pattern worth flattening (suggest profile
  adjustments that keep similar prompts on the same model).
- `stats` (Phase 3) should distinguish cache_creation cost from
  cache_read cost in its report so users see the model-swap penalty.

**Other fixes from smoke testing:**
- `--mcp-config '{}'` is rejected by Claude CLI ("Does not adhere to MCP
  server configuration schema"). The correct empty form is
  `'{"mcpServers":{}}'`. Built-in profiles updated.
- The session store now returns `{sessionId, isNew}` so the wrapper knows
  whether to pass `--session-id` (new) or `--resume` (continuing).
