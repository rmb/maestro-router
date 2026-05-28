# Contributing to maestro-router

Thanks for your interest. Maestro is a cost-reduction tool for Claude Code — every change to the routing pipeline or classifiers must measurably preserve savings without regressing accuracy.

## Setup

```bash
git clone https://github.com/rmb/maestro-router.git
cd maestro-router
pnpm install --ignore-scripts
MAESTRO_SKIP_EMBED_CHECK=1 pnpm build
pnpm test
```

Node ≥ 20, pnpm ≥ 9 required.

## What to work on

Good first issues are tagged [`good first issue`](https://github.com/rmb/maestro-router/issues?q=label%3A%22good+first+issue%22). Feature ideas that weren't accepted into the current scope live in [`docs/future-ideas.md`](docs/future-ideas.md) — if something there interests you, open an issue first before building it.

## Rules

**Classifier budget: ≤50ms p95.** Every classifier must include a `// budget: <ms>` comment and a runtime test at 2× that budget.

**No new default-on pipeline stages.** New classifiers default to `false` in config and require an ADR in `docs/adr/` plus `bench --propose` evidence before enabling by default.

**No new runtime dependencies** without an ADR. Optional peers are fine; runtime deps are not.

**One module = one commit.** Imperative subject line, ≤72 chars. No "WIP" commits.

**Eval gate.** Classifier changes must pass `pnpm bench` with no >2% regression vs `evals/baseline.json`.

## Submitting a PR

1. Fork, branch from `main`.
2. Make the smallest change that solves the problem.
3. Run `pnpm typecheck && pnpm lint && pnpm test`.
4. For classifier changes: `pnpm bench` and paste the diff in the PR description.
5. Fill in the PR template.

## Cost discipline

Maestro's value is cost reduction. Any change that adds a model spawn (even for evals) must estimate cost upfront and require `--confirm-cost` if the estimate exceeds $1.

## License

By contributing you agree your changes are licensed under Apache 2.0.
