# Maestro · Build Plan (v3 — wrapper architecture)

A CLI wrapper around Claude Code that classifies each prompt and routes it to
the optimal model + thinking budget. Works on Claude Pro/Team subscriptions —
**no API access required**. Verified via spike: session continuity survives
model swap on Team OAuth (Haiku → Sonnet preserved context).

- **Package:** `maestro-router` (npm name confirmed available)
- **License:** Apache 2.0, copyright `Maestro Contributors`
- **Runtime:** Node >=20, ESM, TypeScript strict
- **Auth:** uses Claude Code's existing OAuth (`claude auth status`); never touches credentials
- **Target users:** Claude Code users on subscription or API; this plan optimizes for subscription
- **Repo:** [github.com/rmb/maestro-router](https://github.com/rmb/maestro-router) (remote connected)
- **Phase:** pre-execution

---

## Architecture — wrapper not proxy

```
User types prompt (VSCode terminal OR VSCode panel)
  │
  ├─ Terminal:  user runs `maestro` (or aliased `claude`)
  └─ Panel UI:  set `claudeCode.claudeProcessWrapper` → /usr/local/bin/maestro
                (verified setting in anthropic.claude-code extension v2.1.145)
  │
  ▼
Maestro CLI
  ├─ Pass through if input is a slash command (/model, /help, etc.)
  ├─ Classify the prompt (override → turn-type → heuristic, short-circuit at 0.6)
  ├─ Load user config + overrides + custom heuristics
  ├─ Pick {model, effort, maxBudgetUsd} from profile (with overrides applied)
  ├─ Cache check (sha256 of prompt + scenario)
  ├─ Spawn `claude --print --session-id <uuid> --resume \
  │         --model <X> --effort <Y> --max-budget-usd <Z> \
  │         --output-format json`
  ├─ Stream subprocess stdout → user
  ├─ Parse JSON output → extract real token counts
  └─ Log decision + outcome to ~/.maestro/decisions.jsonl
```

**Key insight from CLI spike:**

| Maestro concept | Claude CLI flag | Effect |
|---|---|---|
| Model selection | `--model haiku/sonnet/opus` | per-invocation |
| Thinking budget | `--effort low/medium/high/xhigh/max` | per-invocation |
| Per-session cost cap | `--max-budget-usd <N>` | built-in, C11 free |
| Auto-fallback | `--fallback-model <X>` | built-in |
| Session continuity | `--session-id <uuid>` + `--resume` | verified across model swap |
| Non-interactive | `--print` | clean wrap target |
| Real token counts | `--output-format json` | no estimation needed |

---

## Decisions baked in

### Approved (G1–G9, C1–C12, S1–S5 history preserved in [docs/lessons.md](docs/lessons.md) once Phase 1 ships)

- **G1** pnpm throughout (no Bun)
- **G2** `extractJSON`: fenced + brace-balanced fallback for parsing CLI JSON output
- **G3** `~/.maestro/profile-overrides.json` writable by `tune --apply`, never edits source
- **G4** Telemetry counters (`telemetry.eventsLogged`, `telemetry.lastWriteAt`) in `~/.maestro/config.json`
- **G5** `src/classifiers/internal-index.ts` + `src/profiles/internal-index.ts` created at module 24
- **G6** ~~Prompt caching on LLM classifier~~ — N/A (no LLM classifier; pivot dropped it)
- **G7** ~~Embedding peer fail-open~~ — N/A (embedding deferred per S2)
- **G8** ~~Gateway `MAESTRO_API_KEY`~~ — N/A (no gateway)
- **G9** `docs/router-observations.md` — plain markdown, date-stamped H2, used to log Claude CLI quirks

### Cost optimizations (adapted to wrapper)

- **C1** ~~Per-class `maxTokens` caps~~ → **superseded by `--max-budget-usd` per class (built into CLI)**
- **C2** Pipeline test asserts cheap-first order: override → turn-type → heuristic (no LLM/embedding in v0.2)
- **C3** Heuristic fast-path returns confidence 1.0 for definite-trivial patterns (single-line shell, prettier/eslint, single-word ops); short-circuits the pipeline
- **C4** ~~`cache_control` preservation~~ — N/A (no adapter forwarding)
- **C5** `bench` reports: cache hit rate, **real** thinking tokens P50/P95 per class (from `--output-format json`), **real** output tokens P50/P95 per class, override-rate per class
- **C6** Tournament v0.2: model-tier downgrade only (single axis); matrix → v0.3
- **C7** `maestro stats`: 7d rolling cost vs Opus-everywhere baseline, cache hit %, per-class distribution, **per-class override rate** (signal that classifier is misjudging)
- **C8** Eval seed: 100 prompts + 5 injection probes + 10 repeat pairs + 20 multi-turn (10 tool_result, 5 error_recovery, 5 continuation)
- **C9** Phase 2 gate flags any class whose realized cost P95 exceeds the per-class `maxBudgetUsd` cap consistently (>10% of calls in that class)
- **C10** Turn-type classifier — first-class module in Phase 1
- **C11** Session token ceiling — **free via `--max-budget-usd`**; profile exposes per-class caps directly
- **C12** Per-tool profile overrides — deferred to v0.3 (no adapter layer in v0.2 to hook)

### Risks + mitigations (only relevant ones)

- **R1** ~~CCR shadow test~~ — N/A
- **R2** ~~Translator property tests~~ — N/A
- **R3** ~~Exemplar staleness~~ — N/A
- **R4** ~~PostHog key bootstrap~~ — N/A
- **R5** Phase-bridging session boundaries. Mitigation: each phase tag commit writes `docs/session-state.md`.
- **R6 NEW** Claude CLI flag stability. Mitigation: `preflight.ts` (module 11) verifies the version + presence of required flags (`--model`, `--effort`, `--max-budget-usd`, `--session-id`, `--resume`, `--output-format json`); emits a clear error on mismatch. Version pinned in `package.json` peerDependenciesMeta with documented compatibility range. Tested CLI version: `2.1.112`.
- **R7 NEW** Session resumption corruption across model swap. The spike proved single-swap works; multi-swap behavior unknown. Mitigation: Phase 2 module 13 (`session.ts`) ships with a regression test that runs 5 turns across 4 distinct models and asserts context preservation.
- **R8 NEW** `--max-budget-usd` enforcement semantics. The flag exists but exact behavior on overrun (truncate, error, warn?) is unverified. Mitigation: Phase 2 spike with a $0.01 cap on a long-output prompt; document observed behavior in `docs/router-observations.md` and adjust profile defaults accordingly.

### Action-level optimizations (kept)

- **C10** Turn-type classifier — modules 10
- **C11** Session token ceiling — free via CLI flag (no module needed)
- **C12** Per-tool profile overrides — v0.3 backlog

### Fine-tuning (new design)

- **F1** Three user-editable config files in `~/.maestro/`:
  - `config.json` — global preferences (profile name, aggressiveness, disabled models, daily cap, feedback prompts on/off, auto-learn on/off)
  - `profile-overrides.json` — per-class model/effort/budget tweaks
  - `heuristics.json` — custom regex patterns with class + confidence
- **F2** Layered config loader (module 5): per-project (v0.3 hook) → user overrides → user heuristics → user config → built-in profile defaults
- **F3** `maestro tune --learn`: mines override patterns from telemetry, proposes new heuristic rules (auto-generated entries marked `"source": "auto"`)
- **F4** Auto-learning terminal hint after N=5 overrides on similar prompts in 30d window — emitted in one line to stderr, never blocks
- **F5** `maestro bench --propose <overrides-file>`: validates proposed changes against eval baseline before applying; rollback gate at >2% regression
- **F6** `maestro feedback <session-id> --rating 1-5`: manual quality rating; events influence `tune` weighting
- **F7** Optional Stop-hook for interactive feedback (👍/👎/skip) — opt-in via `feedbackPrompts: "occasional" | "always"` in user config
- **F8** Daily cost cap (`dailyCostCapUsd` in user config): when reached, all subsequent classifications add a `cost.daily_cap_reached` diagnostic and force-downgrade by one tier with `info.daily_throttled` diagnostic
- **F9** Session-start cost amortization (discovered via spike 2): Claude Code's first turn in a session writes ~37k system-prompt tokens to cache. Maestro's session manager (module 12) must aggressively reuse session IDs to amortize this — never spawn a fresh session for follow-up prompts in the same cwd. `stats` (module 20) reports "session-start cost" and "in-session turn cost" as separate line items so users see realistic per-turn numbers.

### Claude-specific savings (discovered via expert review of spike data)

The spike showed cache_creation_input_tokens of 37,863 dominated a trivial prompt's cost. These optimizations attack the system-prompt size, not just the model choice.

- **S6** `--bare` mode for definite-trivial classifications. The C3 heuristic fast-path detects safe patterns (single-line shell, prettier/eslint, single-word ops). For those, the profile spawns `claude --bare ...` which skips hooks/LSP/plugin sync/auto-memory/CLAUDE.md auto-discovery — shrinks system prompt by ~80–90%. Trade-off: loses project context. C3 pattern set must be conservative. Users can bypass with new override `@fast+context` (added to module 8) to keep context while still routing to trivial.
- **S7** `--exclude-dynamic-system-prompt-sections` enabled by default. Moves per-machine sections (cwd, env, memory paths, git status) into the first user message so the cached system prompt is stable across cwd/env/git changes. Massive cache-hit-rate improvement across sessions. Opt-out via `userConfig.excludeDynamicSections: false`.
- **S8** Per-class tool restriction via `--tools <list>`. Trivial/simple classes restrict to `Read,Edit`; standard+ use `default`. Removes tool schemas from the cached system prompt. Profile spec gains a `tools` field per class.
- **S9** Per-class MCP isolation. For trivial/simple, pass `--strict-mcp-config --mcp-config '{}'` to disable all MCP servers. Compounds with S8 — minimal system prompt baseline. Profile spec gains `mcpConfig` field per class.
- **S10** Auto-compaction hint. When `cache_creation_input_tokens` per turn exceeds threshold (configurable, default 8k beyond session-start), Maestro emits a one-line hint to stderr: `💡 Session context growing — run /clear or /compact to reset cache cost`. Optional auto-trigger via `userConfig.autoCompact: true`. Numbers come for free from module 16 (`output.ts`).
- **S11** Session-start cost separation extended to `bench` reports (not just `stats`). Tournament comparisons must subtract session-bootstrap cost to be apples-to-apples — otherwise short sessions appear artificially expensive vs long ones.

**Expected compounded savings vs Claude Code default:** ~70–80% (vs the original 60% target with model-routing alone), no API access required.

---

## Repo layout

```
src/
  core/
    types.ts             # 1.  Decision, Diagnostic, Profile, Heuristic, ConsentState
    cache.ts             # 2.  LRU + optional SQLite
    telemetry.ts         # 3.  Local JSONL (decisions + overrides + feedback events)
    classifier.ts        # 4.  createClassifier({ name, classify, weight })
    profile.ts           # 5.  createProfile + layered config loader (F2)
    pipeline.ts          # 6.  Pipeline with 0.6 short-circuit, parallel weighted vote
    extract.ts           # 7.  JSON extraction (fenced + brace-balanced, G2)
  classifiers/
    override.ts          # 8.  @opus/@deep/@think/@sonnet/@fast/@haiku hints (strip from prompt)
    turn-type.ts         # 9.  user_prompt / tool_result / error_recovery / continuation (C10)
    heuristic.ts         # 10. built-in regex patterns + load user heuristics.json (F1)
  wrapper/
    preflight.ts         # 11. verify claude CLI version + required flags (R6)
    session.ts           # 12. UUID generation, --session-id / --resume management
    spawn.ts             # 13. spawn `claude --print --model X --effort Y --max-budget-usd Z`
    stream.ts            # 14. pipe stdin/stdout/stderr, SIGINT handling
    passthrough.ts       # 15. detect slash commands, bypass classification
    output.ts            # 16. parse --output-format json for real token counts
  cli/
    index.ts             # 17. commander entry, version, shebang
    utils.ts             # 18. config loader (F2), format(), wrap() error boundary
    telemetry-cmd.ts     # 19. telemetry status / show / feedback subcommands (F6)
    stats.ts             # 20. cost vs Opus-everywhere, cache hit, override rate (C7)
    tune.ts              # 21. dry-run + --apply + --learn (F3, F5 integration)
    replay.ts            # 22. re-route logs against current pipeline
    bench.ts             # 23. eval suite + --propose + --tournament (single-axis v0.2)
  index.ts               # 24. public API surface (named exports + internal-index.ts files)
evals/
  labeled.jsonl          # 100 prompts + 5 injection + 10 repeat + 20 multi-turn
  run.ts                 # accuracy + confusion + cost + override-rate
  baseline.json          # locked metrics; >2% regression = block
hooks/                   # optional: Stop-hook script for interactive feedback (F7)
  stop-feedback.sh
```

**Checkpoints (git tags):**
- After module 10: `v0.0.1-core` — pipeline runs in tests, classifiers green
- After module 16: `v0.1.0-wrapper` — Maestro can route real prompts via subprocess
- After module 24: `v0.2.0-cli` — full CLI shipped, ready for `npm publish`

---

## Prerequisites for users (README will spell out)

- Node.js >=20
- Claude Code installed (`claude --version` ≥ 2.x)
- Authenticated: `claude auth status` shows `loggedIn: true` (any auth method works: API key, Pro subscription, Team subscription, Bedrock)
- For VSCode panel UI: set `claudeCode.claudeProcessWrapper` → `<which maestro>`
- For terminal: alias or just invoke `maestro` instead of `claude`

---

## Phase 1 · modules 1–10 · target tag `v0.0.1-core`

Foundation: core machinery + three classifiers + eval seed.

### Bootstrap
- [ ] Verify Node >=20 and pnpm available
- [ ] `git status` clean except staged `tasks/todo.md`; remote already configured
- [ ] `pnpm init` with name `maestro-router`, type module, packageManager `pnpm@9`, sideEffects false, license Apache-2.0
- [ ] Install dev deps: `typescript vitest eslint @types/node tsx @typescript-eslint/parser @typescript-eslint/eslint-plugin publint @arethetypeswrong/cli`
- [ ] Write `tsconfig.json`, `eslint.config.js`, `package.json` scripts (typecheck / lint / test / build / eval / verify), `.gitignore`, `NOTICE`, `README.md` stub
- [ ] Verify the LICENSE already in repo is Apache 2.0; keep as-is

### Persistence docs
- [ ] `CLAUDE.md` — the persistent contract for future fresh sessions. Includes: architecture overview (wrapper model), `<repo_layout>`, `<decision_framework>`, fine-tuning design (F1–F8), CLI prerequisites, the deferred-features list (no API, no Bedrock, no Codex), R6/R7/R8 mitigations, and `<continuity>` protocol.
- [ ] `docs/PROJECT_BRIEF.md`
- [ ] ADRs:
  - ADR-0001 language TypeScript
  - ADR-0002 commander CLI framework
  - ADR-0003 wrapper architecture over proxy (with the spike result)
  - ADR-0004 Apache 2.0
- [ ] `docs/INSPIRATION.md` — credits RTK pattern, Microsoft Chat Customizations Evaluations, claude-code-router protocol (even though we don't use CCR, the protocol shape informed scenario mapping)
- [ ] Empty stubs: `docs/lessons.md`, `docs/router-observations.md` (where R6/R7/R8 observations land)
- [ ] `docs/future-ideas.md` seeded with backlog items below
- [ ] `evals/labeled.jsonl` with 100 prompts + 5 injection probes + 10 repeat pairs + 20 multi-turn (10 tool_result, 5 error_recovery, 5 continuation) (C8)

### Module commits

- [ ] 1 — `core/types.ts`: Decision, Diagnostic, Profile, Heuristic, HeuristicRule, UserConfig, ProfileOverride, Class
- [ ] 2 — `core/cache.ts` + tests: LRU, key `sha256(lastUserMessage + scenarioHint)`, 24h TTL, 1000 entries
- [ ] 3 — `core/telemetry.ts` + tests: JSONL append with rotation; supports decision events, override events, feedback events; counter updates in `~/.maestro/config.json` (G4)
- [ ] 4 — `core/classifier.ts` + tests: `createClassifier({ name, classify, weight })`
- [ ] 5 — `core/profile.ts` + tests: `createProfile({ class -> { model, effort, maxBudgetUsd, tools?, bare?, mcpConfig?, excludeDynamicSections? } })` per S6–S9; layered config loader (per-project hook → user overrides → user heuristics → user config → built-in defaults) (F2). Default `excludeDynamicSections: true` globally (S7). Built-in `balanced` profile sets: trivial → `{ model: "haiku", effort: "low", tools: "Read,Edit", bare: true, mcpConfig: "{}", maxBudgetUsd: 0.05 }`; simple → `{ model: "sonnet", effort: "low", tools: "Read,Edit", mcpConfig: "{}", maxBudgetUsd: 0.30 }`; standard+ → full tools, no `--bare`.
- [ ] 6 — `core/pipeline.ts` + property tests: short-circuit at 0.6, parallel weighted vote, 50ms p95 budget, cheap-first ordering invariant (C2)
- [ ] 7 — `core/extract.ts` + tests: fenced regex + brace-balanced fallback (G2)
- [ ] 8 — `classifiers/override.ts` + tests: `@opus/@deep/@think/@sonnet/@fast/@haiku` per spec; strip hint from prompt. **New override `@fast+context`** (S6 escape hatch): routes to trivial but disables `--bare` so project context is preserved. Match `/(?:^|\s)@(opus|deep|think|sonnet|fast(?:\+context)?|haiku)\b/i`.
- [ ] 9 — `classifiers/turn-type.ts` + tests: detect user_prompt / tool_result / error_recovery / continuation; <30ms p95; tool_result short-circuits to simple (or trivial for Read/Grep/LS/Glob results); error_recovery upgrades to hard (C10)
- [ ] 10 — `classifiers/heuristic.ts` + tests: built-in patterns + size policy (>50k chars → longContext diagnostic) + **conservative definite-trivial fast-path with confidence 1.0** (C3 + S6 safety) — pattern set: single-line prettier/eslint invocations, `git status`/`git diff` only (no `git push`), single-word rename/format/lint ops, single-line shell with no `|` or `&&`. Emits `bare_safe: true` diagnostic so module 13 enables `--bare`. Loads user `heuristics.json` (F1); user-defined patterns NEVER get `bare_safe: true` (must be explicit in heuristic entry).

### Phase 1 gate
- [ ] `pnpm typecheck lint test` clean
- [ ] `pnpm eval` produces baseline (accuracy on the seed set, no LLM calls yet)
- [ ] Write `docs/session-state.md`
- [ ] Commit + `git tag v0.0.1-core`

---

## Phase 2 · modules 11–16 · target tag `v0.1.0-wrapper`

The wrapper layer that makes Maestro actually run prompts.

- [ ] 11 — `wrapper/preflight.ts` + tests: detect `claude` binary on PATH; verify version range; verify presence of `--model`, `--effort`, `--max-budget-usd`, `--session-id`, `--resume`, `--output-format json`; emit clear error with upgrade instructions on mismatch (R6)
- [ ] 12 — `wrapper/session.ts` + tests: UUID v4 generation, session lookup by cwd (default: most-recent session in current dir), `--continue` semantics, `--resume <uuid>` semantics; **aggressive session reuse (F9)** — never spawn a fresh session for follow-up prompts in the same cwd; explicit `--new-session` flag for users who want a clean break; regression test: 5 turns across 4 distinct models (haiku → sonnet → opus → sonnet → haiku) preserving context (R7); cost test confirming cache_creation_input_tokens drops to ~0 on turn 2+
- [ ] 13 — `wrapper/spawn.ts` + tests: build `claude --print` arg list from a Decision incl. `--model`, `--effort`, `--max-budget-usd`, `--session-id`, `--resume`, `--output-format json`, **`--bare` when `bare_safe` diagnostic present AND profile permits AND override is not `@fast+context` (S6)**, **`--exclude-dynamic-system-prompt-sections` when `userConfig.excludeDynamicSections` true (S7)**, **`--tools <list>` per profile (S8)**, **`--strict-mcp-config --mcp-config <json>` per profile (S9)**; spawn subprocess; capture exit code; honor AbortSignal; never throws on classification — only on actual Claude CLI failure
- [ ] 14 — `wrapper/stream.ts` + tests: pipe stdin → subprocess stdin, subprocess stdout → user stdout, subprocess stderr → user stderr; SIGINT propagates to subprocess; clean teardown
- [ ] 15 — `wrapper/passthrough.ts` + tests: detect `/model`, `/help`, `/clear`, `/cost`, all known Claude Code slash commands; pass through unmodified without classification; document the matched-prefix list
- [ ] 16 — `wrapper/output.ts` + tests: parse `--output-format json` to extract `usage.input_tokens`, `usage.output_tokens`, `usage.cache_read_input_tokens`, `usage.cache_creation_input_tokens`, `total_cost_usd`, `duration_ms`, `duration_api_ms`, `stop_reason`, `service_tier`, exact model variant from `modelUsage`; feed into telemetry as real numbers (replaces estimation). **Detects compaction signal: when `cache_creation_input_tokens` per turn exceeds `userConfig.autoCompactThresholdTokens` (default 8000), emit `info.compact_recommended` diagnostic — module 14 (`stream.ts`) prints the one-line hint to stderr (S10).**

### Phase 2 spike (must happen during module 11/12 development)
- [ ] R8 verification: run `echo "write a 1000-word essay" | claude --print --max-budget-usd 0.01 --output-format json`. Document observed behavior in `docs/router-observations.md`: does it truncate? error? warn? Adjust profile defaults if needed.

### Phase 2 gate
- [ ] All verification gates per `<workflow>`
- [ ] `pnpm eval` no >2% regression vs `v0.0.1-core` baseline
- [ ] Manual smoke: `echo "rename this variable to camelCase" | maestro --print` returns a routed response; decision logged to `~/.maestro/decisions.jsonl` with `class: "trivial"`, `model: "haiku"`
- [ ] Manual smoke: multi-turn session — first prompt classified as `standard` on Sonnet, follow-up override `@deep` classified as `max` on Opus, context preserved
- [ ] Update `docs/session-state.md`
- [ ] Commit + `git tag v0.1.0-wrapper`

---

## Phase 3 · modules 17–24 · target tag `v0.2.0-cli`

CLI shell + commands + public API + tuning loop.

### CLI shell (modules 17–18)
- [ ] 17 — `cli/index.ts`: commander v12+, version from `package.json` via JSON import, shebang `#!/usr/bin/env node`, each command file exports `(program: Command) => void` that self-registers
- [ ] 18 — `cli/utils.ts`: `loadConfig()` (F2 layered discovery), `format(data, { json, quiet, color })`, `wrap(handler)` error boundary (exit 1 runtime, 2 usage)

### Subcommands (modules 19–23)
- [ ] 19 — `cli/telemetry-cmd.ts`: `telemetry status` (path, total events, last write), `telemetry show --limit 50`, `telemetry feedback <session-id> --rating 1-5` (F6)
- [ ] 20 — `cli/stats.ts`: `maestro stats` — 7d rolling cost vs Opus-everywhere, cache hit %, per-class distribution, per-class override rate (C7); identifies "patterns you keep overriding" as actionable suggestions; **separates session-start cost (cache_creation) from in-session turn cost (cache_read) per F9** so users see realistic per-turn numbers, not misleading averages dominated by session bootstrap. **Breaks down cache cost: cache_creation_tokens × $/token vs cache_read_tokens × $/token vs net new input tokens — surfaces whether the user is paying mostly for bootstrap, context growth, or actual prompts (S11).**
- [ ] 21 — `cli/tune.ts`: `tune` (dry-run analysis), `tune --apply` (writes to overrides + heuristics), `tune --learn` (focused on heuristic mining from override patterns, F3); `--apply` requires `bench --propose` first (F5) — rollback if eval regression >2%. **Detects `--bare` misclassification pattern (S6 safety): if user overrode within N seconds of a `bare_safe: true` decision, flag the matched pattern as "needs context" and suggest narrowing the C3 regex.** Detects `info.compact_recommended` events (S10) and surfaces "your sessions grow long; consider lowering `autoCompactThresholdTokens` or enabling `autoCompact: true`".
- [ ] 22 — `cli/replay.ts`: `replay <log>` re-routes JSONL log against current pipeline; emits unified-diff of divergences
- [ ] 23 — `cli/bench.ts`: standard mode (accuracy + confusion + real token costs from C5); `--propose <overrides-file>` to validate proposed changes (F5); `--tournament` single-axis model-tier downgrade (C6 v0.2); **all cost comparisons subtract session-bootstrap cost (cache_creation on first turn) per S11 so short sessions aren't artificially expensive vs long sessions**; cost estimate + `--confirm` if estimate >$5

### Public API + release prep (module 24)
- [ ] 24 — `src/index.ts`: named exports per `<api_conventions>`; `internal-index.ts` files for classifiers + profiles (G5); the wrapper subpath is internal-only (Maestro is consumed via CLI, not as a library)
- [ ] Update README:
  - Install
  - Prerequisites (Node 20+, Claude Code, `claude auth status` working)
  - VSCode panel setup (`claudeCode.claudeProcessWrapper`)
  - Terminal setup (alias claude=maestro, or run `maestro` directly)
  - Three usage examples: standalone prompt, multi-turn session, custom heuristic
  - Fine-tuning quickstart (`maestro stats` → `maestro tune` → `maestro tune --apply`)
  - Configuration files reference (config.json / profile-overrides.json / heuristics.json with schemas)
  - Backlog (link to docs/future-ideas.md)
  - Apache 2.0 badge

### Phase 3 gate
- [ ] `pnpm typecheck lint test eval verify` all clean (`verify` = publint + arethetypeswrong)
- [ ] `package.json` `exports` field declares all subpaths
- [ ] `pnpm pack`: only `dist/`, `README.md`, `LICENSE`, `NOTICE`, `package.json`
- [ ] `bin` field → `dist/cli/index.js`, shebang present, `postbuild` script runs `chmod +x`
- [ ] Smoke: install packed tarball in clean dir, run `maestro --help`, confirm help renders
- [ ] Smoke: `maestro stats` runs against empty telemetry without errors (returns "no data yet")
- [ ] Smoke: `maestro tune` runs against empty telemetry, suggests nothing, exits 0
- [ ] Smoke: `maestro bench` runs eval suite, produces baseline
- [ ] Smoke: `maestro bench --tournament` runs single-axis tournament on 10-prompt subset
- [ ] Update `docs/session-state.md`
- [ ] Commit + `git tag v0.2.0-cli`
- [ ] **HOLD** for explicit publish go-ahead

### Post-tag (only on go-ahead)
- [ ] `pnpm publish --dry-run`, review file list
- [ ] `pnpm publish --access public`
- [ ] `git push origin v0.2.0-cli` and `git push origin main`
- [ ] Draft GitHub release notes from CHANGELOG

---

## Verification policy (per module)

- `pnpm typecheck` clean
- `pnpm lint` clean
- `pnpm test` green
- `pnpm dlx publint` clean at release tags
- `pnpm eval` after modules 6, 9, 10, 21 (no >2% regression)
- Example in `examples/` runs where module is user-facing
- One commit per module, imperative one-line message

**Stop-loss:** 3 test failures on the same module → stop and report. Want a feature not in spec → log to `docs/future-ideas.md`, continue. Spec looks wrong → stop and ask.

---

## Backlog — valuable ideas not built in v0.2 (kept for future reference)

### Deferred to v0.3 (specified, will revisit)

- **Remote PostHog telemetry (S1)** — opt-in anonymous usage data to improve routing across users. Includes `core/telemetry-remote.ts`, consent flow, CLI `off`/`forget` subcommands, ADR-0005, dashboards. v0.2 ships local-only.
- **Embedding classifier (S2)** — `@xenova/transformers` peer, ONNX local embedding, `Xenova/all-MiniLM-L6-v2`, build-time `pnpm embed`, `exemplars.json` + `seeds.checksum`. v0.2 relies on override + turn-type + heuristic only.
- **LLM classifier (was module 13 in original spec)** — Haiku-as-classifier for ambiguous prompts. Requires API access to Anthropic/Bedrock for the classifier call; deferred until we add an API mode. v0.2 relies on cheap classifiers + override.
- **Tournament matrix (S4, C6 expansion)** — model × effort axes per class. v0.2 ships model-tier downgrade only.
- **Per-tool profile overrides (C12)** — detect upcoming tool call in conversation and apply tool-specific class: Read/Grep/LS/Glob → trivial, Edit → simple, Bash → simple unless chained, Write → standard. v0.2 has no adapter layer to hook this; rebuild as a hook integration in v0.3.
- **Per-project config (F2 hook)** — `<cwd>/.maestro/config.json` discovered by walking up from cwd. Config loader has the hook in v0.2 but discovery is disabled until v0.3.
- **Interactive feedback Stop-hook (F7)** — automated 👍/👎/skip prompt after each response, recorded as feedback events. Hook script shipped in `hooks/` in v0.2 but not enabled by default.
- **`maestro init` and `maestro doctor` commands** — convention setup + env diagnostics. Manual setup works in v0.2.
- **CCR + adapters + providers + translator + gateway + Bedrock + Codex** — the entire API-routing path from the original spec. Out of scope for the wrapper-based approach. If/when an "API mode" is added (for users with API access who want lower per-prompt overhead than a subprocess spawn), this comes back.

### Deferred but specifically discovered via Claude-expert review

- **S12 — LLM classifier via `--json-schema` (no API needed)** — `claude --print --model haiku --json-schema '{...}'` returns structured JSON. This brings back the original LLM classifier without requiring API access — just spawn Haiku via CLI for ambiguous prompts. Adds ~$0.001 per classifier call (Haiku via subscription). Worth re-introducing in v0.3 when v0.2 telemetry shows where heuristic + turn-type + override leave gaps.
- **S13 — Verify `--fast-mode` cost profile** — spike 2 output included `"fast_mode_state": "off"`. Anthropic's fast mode may be a speed-only tier or may have a separate cost dimension. One quick spike to clarify before deciding whether to expose per-class. v0.3 investigation.

### Considered but not pursued (rationale captured)

- **Speculative parallel routing** — minimizes latency by burning tokens. Wrong direction for cost-minimization. Re-consider if/when latency becomes the binding constraint.
- **Dynamic prompt rewriting** — strip non-essential context for low-class actions. Semantic risk: could change behavior unpredictably. Re-consider only if a safe extraction heuristic emerges.
- **Sub-prompt decomposition** — split multi-action prompts and route each. Requires an LLM call to save LLM calls — net benefit unclear. Re-consider if cheap heuristic decomposer becomes feasible.
- **Single-profile distribution (S5)** — ship only `balanced`. Minor file-count reduction; presets are nearly free. Three profiles retained.
- **Upgrade-tournament evals** — test upgrading classes to detect quality regression from downgrades. Valuable safety net but adds bench complexity. Defer until v0.2 telemetry surfaces a quality issue.
- **Embedding model lazy-load + RAM cap** — only relevant after S2 reversed.
- **Self-correction loop sub-detector** — folded partially into C10 turn-type (`error_recovery`). A richer sub-detector (counts consecutive failures, distinguishes test-failure from lint-failure) could refine upgrade decisions in v0.3.
- **Prefill optimization for structured outputs** — N/A without an LLM classifier (deferred with it).
- **Output length prediction** — heuristic predicting output length to set `--max-budget-usd` dynamically. The static per-class caps get most of the benefit.
- **PTY-based interactive intercept** — wrap interactive `claude` sessions (without `--print`) by pseudo-terminal multiplexing. Significantly more complex; `--print` mode covers single-turn well enough for v0.2. Re-consider if users demand mid-session intervention beyond pre-prompt classification.
- **API mode adapters (CCR / SDK middleware)** — for users with API access who want lower per-prompt latency. The wrapper has ~50ms subprocess startup overhead per turn; direct API call has none. Worth adding as an alternative mode in v0.3 once the wrapper is proven.

### Activation milestones

- v0.2.1 — bugfixes, hardening, expanded built-in heuristics based on real telemetry
- v0.3 — pull deferred items above based on user demand + v0.2 telemetry signals

---

## Review log (filled during execution)

_(empty until Phase 1 starts)_
