# CLAUDE.md — Maestro persistent contract

Read this first on every session. Cross-references the build plan in
[tasks/todo.md](tasks/todo.md) and the architecture decisions in
[docs/adr/](docs/adr/).

## What Maestro is

A CLI wrapper that spawns `claude --print` per turn with chosen
`--model`/`--effort`/`--max-budget-usd` flags. Routes each prompt to the
cheapest model + thinking budget that will produce the right answer. Works
on Claude Pro/Team subscriptions — no API key needed.

## Architecture (single picture)

```
User prompt (VSCode terminal or panel UI)
  │
  └─ stdin → maestro CLI
       ├─ passthrough.ts: detect /model, /help, /clear, /cost, /compact → bypass classification
       ├─ pipeline.ts: cheap-first order, short-circuit at 0.6 confidence
       │    1. override.ts        (@fast / @deep / @think / @fast+context / etc.)
       │    2. turn-type.ts       (user_prompt / tool_result / error_recovery / continuation)
       │    3. heuristic.ts       (built-in regex + user heuristics.json)
       │    4. llm.ts             (S12 — claude --print --json-schema haiku, opt-out)
       ├─ profile.ts: class → { model, effort, maxBudgetUsd, tools?, bare?, mcpConfig?, excludeDynamicSections? }
       ├─ cache.ts: sha256(prompt + scenario), 24h TTL, 1000 entries
       ├─ session.ts: reuse session_id by cwd (F9 amortization)
       └─ spawn.ts → `claude --print --session-id <uuid> --resume --model X --effort Y --max-budget-usd Z [--bare] [--tools …] [--strict-mcp-config --mcp-config …] [--exclude-dynamic-system-prompt-sections] --output-format json`
            │
            └─ stream.ts: stdout → user, JSON tail parsed by output.ts → telemetry
```

## Phase status

- **Phase 1 (modules 1–10, target `v0.0.1-core`)**: in progress. Foundation + classifiers + eval seed.
- **Phase 2 (modules 11–16, target `v0.1.0-wrapper`)**: blocked on Phase 1.
- **Phase 3 (modules 17–24, target `v0.2.0-cli`)**: blocked on Phase 2.

Plan: see [tasks/todo.md](tasks/todo.md) for the full module list, gap
resolutions (G1–G9), cost optimizations (C1–C12), fine-tuning design
(F1–F9), Claude-specific savings (S6–S11), risk register (R5–R8), and the
backlog of deferred ideas.

## Hard constraints

- **Node ≥ 20, ESM only, TypeScript strict.** `verbatimModuleSyntax` is on
  so use `import type` for type-only imports.
- **Zero runtime deps in v0.2.** Optional peers: `commander`, `picocolors`,
  `cli-table3`, `yocto-spinner` (for CLI in Phase 3).
- **License: Apache 2.0.** Every source file in `src/` opens with:
  `// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0`
- **Test policy:**
  - Skip type-only files (e.g. `core/types.ts`)
  - Required for everything in `core/`, `classifiers/`, `wrapper/`, `cli/`
  - Property tests for `core/pipeline.ts`
  - Snapshot tests for CLI output (Phase 3)
- **One module = one commit.** Imperative one-line message.
- **Each classifier ≤ 50ms p95.** `// budget: <ms>` comment + runtime test
  at 2× budget.

## Workflow

1. `TodoWrite` for tasks touching 3+ files.
2. Plan in ≤5 lines per module. Don't ask permission; proceed.
3. One module = one commit.
4. Tests with the module. Vitest. Don't mock what you didn't write.
5. After corrections, append one line to [docs/lessons.md](docs/lessons.md).
6. Concrete first, abstract on second use.
7. Stop and ask only if public API shape is ambiguous.

## Verification gate per module

- `pnpm typecheck` clean
- `pnpm lint` clean
- `pnpm test` green
- `pnpm dlx publint` clean at release tags
- Example in `examples/` runs (where module is user-facing)
- `pnpm eval` no >2% regression after modules 6, 9, 10, 21

## Critical knowledge from planning spikes

1. **Spike 1 — session continuity survives model swap.** Verified Haiku →
   Sonnet preserves context with `--session-id` + `--resume` on Team OAuth.
   See [docs/router-observations.md](docs/router-observations.md).

2. **Spike 2 — exact cost via `--output-format json`.** Every Claude CLI
   invocation returns `total_cost_usd`, exact input/output/cache tokens,
   model variant, duration, stop reason. No estimation needed.

3. **`cache_creation_input_tokens` dominates first-turn cost** (~37k tokens
   for a trivial prompt). This is Claude Code's system prompt being cached.
   Session reuse is critical (F9) — never spawn fresh session for follow-up
   prompts in the same cwd.

4. **VSCode panel coverage** via `claudeCode.claudeProcessWrapper` setting
   in the official `anthropic.claude-code` extension. Point it at `<which
   maestro>` and the panel routes through Maestro automatically.

## Deferred (do not build in v0.2)

- Remote PostHog telemetry → v0.3 (S1)
- Embedding classifier (`@xenova/transformers`) → v0.3 (S2)
- Session token ceiling — free via `--max-budget-usd` (C11 → essentially shipped)
- Tournament matrix (model × effort) — v0.3 (S4)
- Per-tool profile overrides → v0.3 (C12)
- Per-project config discovery → v0.3
- Interactive feedback Stop-hook → v0.3 (F7)
- `maestro init` / `maestro doctor` → v0.3
- CCR + adapters + providers + translator + gateway + Bedrock + Codex → out of scope

## Risk mitigations

- **R6 — Claude CLI flag stability.** `wrapper/preflight.ts` verifies
  required flags at startup. Pinned compatibility range in package.json.
  Tested against CLI 2.1.112.
- **R7 — Session resumption corruption across multi-swap.** Module 12 tests
  5-turn 4-model swap preserves context.
- **R8 — `--max-budget-usd` enforcement semantics.** Phase 2 spike with
  $0.01 cap on a long-output prompt documents observed behavior in
  [docs/router-observations.md](docs/router-observations.md).

## Continuity protocol

On session start:
1. Read this file.
2. `git log --oneline -10` — see what shipped.
3. Check [tasks/todo.md](tasks/todo.md) for current phase.
4. Read [docs/session-state.md](docs/session-state.md) if present.

On context ≥75%:
- Finish current module if green, or revert.
- Write [docs/session-state.md](docs/session-state.md):
  ```
  last shipped: <module>
  next: <module>
  blockers: <one line or "none">
  ```
- Tell the user to start fresh. Stop.

## Failure modes to avoid

- Building module N+1 before module N tests pass.
- Adding a runtime dep "because it's easier" — no new runtime dep without
  an ADR.
- Returning `class: "standard"` when you mean null (no signal).
- Mocking the cache or pipeline in classifier tests.
- Hot-reload that re-instantiates the cache.
- Throwing on the hot path — classifiers return null + diagnostic, never throw.
- Default exports outside the (intentionally limited) places they belong.
- Conversation history in any LLM classifier prompt — last user turn only.

Stop-loss:
- 3 test failures on the same module → stop and report.
- Feature not in spec → log to [docs/future-ideas.md](docs/future-ideas.md), continue.
- Spec looks wrong → stop and ask.

## Communication rules

- State decisions, build, move on.
- Per-module wrap-up: 3 bullets — shipped / tested / next.
- Errors: `file:line — cause — fix.`
- No preamble, no recaps, no emojis, no apologies for tool calls.
- No manual `/model` invocations from inside the build (Maestro handles routing).
