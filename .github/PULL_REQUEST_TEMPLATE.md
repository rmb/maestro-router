## What

<!-- One-line summary of the change -->

## Why

<!-- What problem does this solve, or what opportunity does it take? -->

## Checklist

- [ ] `pnpm typecheck` clean
- [ ] `pnpm lint` clean
- [ ] `pnpm test` green
- [ ] `pnpm bench` no >2% regression vs baseline (for classifier changes)
- [ ] Each classifier change stays ≤50ms p95
- [ ] New runtime dependencies have an ADR in `docs/adr/`
- [ ] New pipeline stages default OFF
