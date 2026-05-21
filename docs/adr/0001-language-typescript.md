# ADR-0001 · Language: TypeScript

## Status

Accepted · 2026-05-21

## Context

Maestro is a CLI that wraps the Claude Code CLI. The language choice affects
distribution model, contributor pool, runtime characteristics, and how
easily users can install and run it.

## Decision

**TypeScript on Node ≥ 20, ESM, strict mode.** Distributed via npm.

## Rationale

- **Distribution friction**: `npm install -g maestro-router` is the most
  common way developers install CLIs. Going through Node + npm has the
  lowest installation friction for the target audience (Claude Code users,
  who already have Node installed).
- **Contributor pool**: The TypeScript / JavaScript ecosystem has the
  largest pool of OSS contributors. Lower barrier to bug reports + PRs.
- **Runtime fit**: Node ≥ 20 has stable ESM, native `node:test` (we use
  Vitest), `node:http`, `crypto.randomUUID`, `child_process` for spawning
  the Claude subprocess. No native bindings needed in v0.2.
- **Type safety**: Strict TypeScript catches the same class of bugs as Go's
  type system. `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `verbatimModuleSyntax` together approximate the safety of more
  rigid type systems.
- **Tooling**: ESLint flat config, Vitest, publint, are-the-types-wrong —
  the toolchain for shipping a small ESM library is mature.

## Alternatives considered

- **Go**: Single static binary, no Node dependency. But it puts a sharper
  edge on contributor onboarding (smaller ecosystem of Claude Code users
  writing Go).
- **Rust**: Excellent single-binary distribution and performance. But the
  per-prompt subprocess startup is bound by Claude CLI startup time
  (~hundreds of ms), so Maestro's overhead being 5ms vs 50ms doesn't
  matter. Contributor pool smaller.
- **Bash / shell**: Tempting for a wrapper, but the classification
  pipeline + telemetry + config layering is enough state to want a real
  language.

## Consequences

- Users must have Node ≥ 20 installed. This is already required by Claude
  Code itself, so it's not an incremental ask.
- Maestro startup time per prompt is dominated by Node startup (~50–100ms)
  + Claude CLI startup, not by Maestro's own logic.
- ESM-only means CommonJS consumers can't `require()` Maestro internals;
  since Maestro is consumed as a CLI binary, this is fine.
