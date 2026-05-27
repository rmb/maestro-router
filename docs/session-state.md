# Session State — post v0.2.5 pricing audit

## What Shipped (this session, on top of v0.2.5)

### commit 4843504: stats: derive spent from token volumes
Root cause of spurious "7.9% savings": `stats.ts` was reading `total_cost_usd` from
Claude Code's JSON output, which is fabricated on Pro/Team subscriptions. Real savings
are **88.7%** — now visible.

### commit 3d654af: fix: eliminate fabricated total_cost_usd across all cost paths
Created `src/core/pricing.ts` as the single source of truth for all cost math.
Replaced `total_cost_usd` reads in stats.ts, tournament.ts, tokens-saved.ts,
telemetry-correctness.ts. Test fixtures updated; 997/997 tests passing.

### Earlier this session
- sdk-proxy auto-compact (injected /compact as JSON user frame; was missing entirely)
- Heuristic patterns: commit/push, continue, change-X-to-Y
- autoCompactThresholdTokens: 300k → 200k

## Current live stats (2026-05-27)
```
requests:        109
spent:           $37.63
would-be opus:   ~$334.17
saved:           $296.54 (88.7%)
cache hit:       95.4%
auto-compacts:   6
fresh sessions:  0.9%
cache_read cost: 51.4% of spend
fallback rate:   7.3%  (target <5%)
```

## Next
- Monitor 2–3 more days; confirm 88.7% holds
- fallback rate 7.3% → still above 5%; another tune pass when data accumulates
- cache_read at 51.4% is structurally expected; auto-compact at 200k threshold should
  reduce it over the next few days

## Deferred
- sdk-proxy runtime model tracking (set_model frame doesn't update telemetry.decision.spec.model)
- v0.3 planning
