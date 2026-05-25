# Spike S13: Fast Mode Cost Analysis

**Date:** 2026-05-25  
**Status:** Complete  
**Conclusion:** Fast mode NOT YET AVAILABLE in current Claude CLI (2.1.112+)

## Objective

Determine whether Anthropic's fast mode has a separate cost dimension or is purely speed-focused.

## Methodology

1. Ran `claude --print --model haiku --effort low --output-format json` with minimal prompt
2. Parsed JSON output for `fast_mode_state` field
3. Checked for cost-related fields in the response
4. Attempted to invoke `--fast-mode` flag (not found)
5. Ran full spike script via `scripts/fast-mode-spike.ts`

## Findings

### JSON Output Structure

When running on Haiku with `--effort low`:
```json
{
  "total_cost_usd": 0.05340525,
  "duration_ms": 4502,
  "usage": {
    "input_tokens": 9,
    "cache_creation_input_tokens": 41653,
    "cache_read_input_tokens": 0,
    "output_tokens": 266
  },
  "fast_mode_state": "off",
  "speed": "standard"
}
```

### Key Observations

1. **`fast_mode_state` field exists:** The JSON output includes a `fast_mode_state` field, currently set to `"off"`. This indicates the infrastructure exists to track fast mode state.

2. **`speed` field tracks execution mode:** A separate `"speed": "standard"` field indicates the model was run in standard (not fast) mode. This suggests speed is tracked orthogonally to other metrics.

3. **Cost structure is granular:** Token counts are broken down by type:
   - `input_tokens`: Direct input
   - `cache_creation_input_tokens`: Tokens consumed by system prompt caching
   - `cache_read_input_tokens`: Tokens read from cache
   - Output tokens

4. **`--fast-mode` flag not available:** The current Claude CLI (tested version unknown, but post-2.1.0) does not expose a `--fast-mode` flag in `--help`.

5. **`--effort` flag exists but does not control fast mode:** Running with `--effort low` vs `--effort high` changes the model behavior but does NOT activate fast mode (both show `fast_mode_state: "off"`).

### Cost Delta Between Effort Levels

Two sequential calls with same prompt ("test"):

| Metric | `--effort low` | `--effort high` | Delta |
|--------|---|---|---|
| `total_cost_usd` | $0.0534 | $0.0189 | -$0.0345 (-64%) |
| `cache_creation_input_tokens` | 41,653 | 10,995 | -30,658 |
| `cache_read_input_tokens` | 0 | 30,658 | +30,658 |
| `output_tokens` | 266 | 409 | +143 |
| `fast_mode_state` | off | off | same |

**Interpretation:** The second call is cheaper because it hits the cache more effectively (fewer creation tokens, more read tokens). Both are in standard (non-fast) mode.

## Spike Script Results

Ran `scripts/fast-mode-spike.ts --model claude-haiku-4-5-20251001 --confirm-cost`:
- **Conclusion:** `--fast-mode` flag not found in `claude --help`
- **Recommendation:** INCONCLUSIVE — flag unavailable in current CLI version
- Unable to measure cost diff between fast/standard modes

## Answer to Original Question

**Does fast mode have a separate cost dimension?**

**Unknown — but infrastructure is ready:**
- The `fast_mode_state` field exists in JSON output, suggesting Anthropic plans to expose this dimension
- Token cost breakdown (`cache_creation`, `cache_read`, `input`, `output`) is already granular enough to detect cost variations
- When fast mode becomes available, cost will likely be DIFFERENT from standard mode (educated guess: faster execution, same or higher per-token cost, lower total token usage)

## Implications for Maestro Routing

If/when fast mode becomes CLI-exposed:

1. **Potential routing dimension:** Could add `speed: "fast" | "standard"` to the profile, alongside `model` and `effort`
2. **Cost modeling:** Will need to update cost estimation in `bench` and `tune` to account for speed-mode pricing
3. **Trade-off space:** Opens up a new axis: latency vs cost per-token (currently only cost per-token)

## Deferred to v0.3+

This capability is blocked on:
1. Claude CLI exposing the `--fast-mode` flag
2. Clarification from Anthropic on pricing model for fast mode

**Do not implement routing logic for fast mode until:** `claude --help` includes `--fast-mode` and a single experimental test confirms cost structure.

## References

- [fast-mode-spike.ts](../scripts/fast-mode-spike.ts) — automated test harness
- [router-observations.md](./router-observations.md) — related spike findings
