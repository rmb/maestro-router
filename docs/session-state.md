# Session state

Last updated: 2026-05-21 · end of Phase 1.

## Last shipped

`v0.0.1-core` — modules 1–10 complete.

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

## Next

Phase 2 — modules 11–16:
- 11 — `wrapper/preflight.ts`: verify `claude` CLI version + required flags
- 12 — `wrapper/session.ts`: UUID session ID management with aggressive reuse (F9)
- 13 — `wrapper/spawn.ts`: spawn `claude --print` with chosen flags (S6–S9)
- 14 — `wrapper/stream.ts`: stdin/stdout piping, SIGINT
- 15 — `wrapper/passthrough.ts`: detect slash commands, bypass classification
- 16 — `wrapper/output.ts`: parse `--output-format json` for real token counts

Phase 2 mid-spike: R8 verification of `--max-budget-usd` enforcement semantics.

## Blockers

None.

## Open notes

- pnpm 11 build-script approval is an environment quirk — install with
  `--ignore-scripts` (logged in lessons.md).
- Eval misses are mostly on multi-turn entries where the synthesized
  conversation didn't include a `Read/Grep/LS/Glob` tool_use block — improving
  the eval's request builder may bump trivial accuracy. Acceptable for v0.0.1.
- Heuristic confidence tuning is mostly conservative; tournament downgrade
  (Phase 3, module 23) and the tuning loop will refine over time.
