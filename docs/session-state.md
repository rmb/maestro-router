# Session state

Last updated: 2026-05-21 · end of Phase 2.

## Last shipped

`v0.1.0-wrapper` — modules 11–16 complete (Phase 2). Phase 1 remains
tagged `v0.0.1-core`.

- core/types.ts (1)
- core/cache.ts + tests (2)
- core/telemetry.ts + tests (3)
- core/classifier.ts + tests (4)
- core/profile.ts + tests (5)
- core/pipeline.ts + property tests (6)
- core/extract.ts + tests (7)
- classifiers/override.ts + tests (8)
- classifiers/turn-type.ts + tests (9)
- classifiers/heuristic.ts + tests (10)

Eval baseline saved to `evals/baseline.json`:
- 137 entries, 83.94% accuracy
- Per-class: trivial 74%, simple 67%, standard 96%, hard 88%, reasoning 91%, max 89%
- p50/p95 latency 0ms (no LLM in pipeline)

## Phase 2 deliverables

- wrapper/preflight.ts (11): verifies Claude CLI version + 12 required flags
- wrapper/session.ts (12): UUID store with aggressive cwd reuse (F9), returns `{sessionId, isNew}`
- wrapper/spawn.ts (13): buildClaudeArgs (pure) + spawnClaude (subprocess); S6/S7/S8/S9 flags
- wrapper/stream.ts (14): streamClaude with live stdout piping + AbortSignal + SIGINT
- wrapper/passthrough.ts (15): isKnownSlashCommand + isSlashPrefix
- wrapper/output.ts (16): parseOutput with S10 compact hint + R8 budget-exceeded detection

End-of-Phase-2 status:
- 240 unit tests passing
- pnpm typecheck / lint / test clean
- Eval baseline unchanged at 0.8394 (no regression, no new classifiers in Phase 2)
- R8 spike confirmed: `--max-budget-usd` is a soft cap (~6× overrun observed)
- Smoke tests confirmed: end-to-end wrapper routes correctly; S7+S8+S9 cut
  cache_creation by ~60% on trivial prompts; session reuse preserves
  conversation context across model swaps but **model swaps still pay
  cache_create on the new model** (documented in router-observations.md)

## Next

Phase 3 — modules 17–24:
- 17 — `cli/index.ts`: commander entrypoint, shebang, version from package.json
- 18 — `cli/utils.ts`: layered config loader (F2), format(), wrap() error boundary
- 19 — `cli/telemetry-cmd.ts`: telemetry status / show / feedback
- 20 — `cli/stats.ts`: cost vs Opus-everywhere baseline, cache cost breakdown
- 21 — `cli/tune.ts`: dry-run + --apply + --learn (F3, F5)
- 22 — `cli/replay.ts`: log replay against current pipeline
- 23 — `cli/bench.ts`: standard mode + --propose + --tournament (single-axis)
- 24 — `src/index.ts`: public API surface + internal-index.ts files

## Blockers

None.

## Open notes

- pnpm 11 build-script approval quirk — install with `--ignore-scripts`
  (lessons.md).
- Eval baseline-equal because Phase 2 only added wrapper infrastructure
  (no classifier changes). Phase 3's `bench --tournament` is where
  accuracy will be re-evaluated with real Claude calls.
- Smoke testing revealed two real bugs (mcpConfig `{}` rejected; session
  reuse confusion between --session-id and --resume). Both fixed; documented
  in router-observations.md.
- Cost of Phase 2 spikes + smokes: ~$0.12 total on the Team subscription.
