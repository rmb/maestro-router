# Changelog

## v0.2.2 — 2026-05-26 · Session boot fix

**Problem:** `maestro stats` reported 100% of spend as "session boot" and cost was dominated by `cache_creation_input_tokens`, not actual model work. Root causes were fingerprint fragmentation (separate Claude sessions per routing class) and a broken cross-model prewarm that spent money on sessions with wrong fingerprints.

### What changed

**`stats`: accurate `cacheCreationCostUsd` reporting** (`src/cli/stats.ts`)

Previously, the full turn cost was attributed to `cacheCreationCostUsd` whenever any `cache_creation_input_tokens > 0` — making session boot appear to be 100% of spend on almost every turn. Now computes actual write cost from `tokens × per-model rate` (Haiku $1.25/MTok, Sonnet $3.75/MTok, Opus $18.75/MTok, Opus-1M $37.5/MTok).

Warning updated: removes false "Track Z should fix this — run `maestro health`" message (Track Z has been live since v0.2.1). Replaced with actionable fingerprint fragmentation diagnosis.

**`profile`: `simple` class `tools → "default"`** (`src/core/profile.ts`)

`simple` used `tools: "Read,Edit"` while `standard`/`hard` used `tools: "default"`. Both route to Sonnet but produced different system-prompt fingerprints → separate session per class → cold boot on every class swap. With `simple` using `tools: "default"`, all Sonnet-class prompts (simple/standard/hard) share one session fingerprint per cwd.

Reduces unique fingerprints from 4 → 3 per cwd (haiku, sonnet, opus). Expected savings: eliminates the most common cold-boot event (simple↔standard switching).

Applied to all three built-in profiles: `balanced`, `cheap`, `quality`.

**`run-cmd`: effective bare in fingerprint** (`src/cli/run-cmd.ts`)

`trivial` class has `bare: true` in its spec, but `--bare` is never emitted on OAuth (Team/Pro) because `bareSupported = false`. The fingerprint was computed from `spec.bare` (always `true` for trivial) rather than the effective value — creating a "bare" fingerprint that diverged from the actual system prompt on OAuth users. Now uses `effectiveBare = pre.bareSupported && spec.bare`.

**`run-cmd`: remove broken cross-model prewarm** (`src/cli/run-cmd.ts`)

The per-turn prewarm spawned 2 background `claude --print` processes to warm adjacent model tiers. However, prewarm computed fingerprints using the current turn's `tools`/`mcpConfig` for all target models — incorrect because per-model fingerprints differ (`reasoning`/`max` keep MCP access; `trivial`/`simple`/`standard`/`hard` strip it). Prewarmed sessions were unreachable (wrong fingerprints) and wasted real money. Removed; sessions warm naturally on first use.

### Upgrade

```sh
npm install -g maestro-router@0.2.2
# or
pnpm add -g maestro-router@0.2.2
```

No configuration changes required. Existing `~/.maestro/sessions.json` entries with old fingerprints will be ignored (TTL expires after 24h) and replaced on next use.

---

## v0.2.1 — 2026-05-21 · Pipeline + panel + tournament

- Pipeline stabilisation across Phases 1–2
- VSCode panel integration via `claudeProcessWrapper`
- Tournament mode (`bench --tournament`)
- Slash command support in panel mode
- Per-class brevity hints moved behind `restorePerClassBrevity` flag (default: off) to stabilise fingerprints
- Prewarm module (Track Z) for fingerprint-keyed session reuse
- First-turn Opus guard (downgrade to Sonnet on cold boot)

## v0.2.0-cli — 2026-05-16

- Full CLI: `maestro run`, `maestro stats`, `maestro health`, `maestro bench`, `maestro tune`
- Phase 3 complete

## v0.1.0-wrapper — 2026-05-13

- Wrapper pipeline complete (Phases 1–2)
- Session store, spawn, stream, output parser

## v0.0.1-core — 2026-05-10

- Core types, classifiers, pipeline
- Eval seed
