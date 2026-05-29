# Changelog

## v0.5.0 — 2026-05-29 · Fallback-rate reduction: model swapping, tunable threshold, SetFit head

**Problem:** The embedding classifier was locked to a single ONNX model with a fixed confidence floor and a single nearest-exemplar strategy. Prompts that didn't resemble the 76 seed exemplars fell through to the LLM stage or the forced-`standard` default, inflating the fallback rate. There was no supported path to swap in a stronger embedding model, tune the confidence floor to a real workload, or replace cosine-nearest with a calibrated classifier head.

### What changed

**`embed`: model swapping with query-prefix handling** (`scripts/embed.ts`, `src/classifiers/embedding.ts`)

`pnpm embed` now honors the `MAESTRO_EMBED_MODEL` env var, so exemplars can be rebuilt with a different ONNX model (e.g. `Xenova/bge-small-en-v1.5`). bge and e5 model families require a `query:` prefix, applied automatically at both embed-time and runtime via a `needsQueryPrefix` rule. A runtime guard rejects a model/exemplar mismatch with the `fallback.embedding_model_mismatch` diagnostic.

**`embeddingMinSimilarity`: tunable confidence floor** (config field, number in [0,1], default 0.4)

The embedding classifier's confidence floor. On the cosine path it is the minimum cosine similarity; on the SetFit head path it is the minimum calibrated probability. Below the floor the classifier abstains rather than emitting a low-confidence guess.

**`embeddingHeadPath`: optional SetFit logistic head** (config field, string)

Path to a SetFit logistic-head JSON. When set, the embedding classifier applies the head to the prompt embedding to produce calibrated per-class probabilities instead of cosine-nearest-exemplar (the exemplars file is then not consulted). Requires a matching `embeddingModel` — the embedding dimension must match the head, else `fallback.embedding_head_dim_mismatch` fires.

**Per-project scoping**: both `embeddingMinSimilarity` and `embeddingHeadPath` are in `PROJECT_CONFIG_ALLOWED_FIELDS`, so they can be set in a per-project `.maestro/config.json`.

**Tuning scripts** (`scripts/`)

`setfit-train.py --export-head-json PATH` exports the trained sklearn logistic head as JSON for `embeddingHeadPath` (only the default sklearn head, not a torch differentiable head). `cluster-fallbacks.py` clusters the `maestro export-prompts --fallbacks` corpus with UMAP+HDBSCAN to reveal missing exemplar classes — add seeds to `src/classifiers/exemplars-seeds.ts`, then run `pnpm embed`. `calibrate-threshold.py` analyzes logged `embedding.matched` similarities (and optional oracle labels) to recommend an `embeddingMinSimilarity` value.

**GitHub discoverability** (minor): `package.json` keywords, `.github/ISSUE_TEMPLATE/`, `PULL_REQUEST_TEMPLATE.md`, `CONTRIBUTING.md`, and a README hero rewrite.

### Configuration

```json
// ~/.maestro/config.json (or per-project .maestro/config.json)
{
  "embeddingModel": "Xenova/bge-small-en-v1.5",
  "embeddingMinSimilarity": 0.4,
  "embeddingHeadPath": "~/.maestro/maestro-head.json"
}
```

### Upgrade

```sh
npm install -g maestro-router@0.5.0
```

No configuration changes are required — the new fields are optional and default to the prior behavior (`all-MiniLM-L6-v2`, cosine-nearest, floor 0.4).

---

## v0.2.4 — 2026-05-26 · Auto-compact + paste condenser + race condition fix

**Problem:** Three issues prevented savings from recovering: (1) `lastCacheReadTokens` was never persisted due to a race condition between two concurrent fire-and-forget writes; (2) the compaction advisory was passive — it could warn but not act; (3) large structured-data pastes (analytics dumps, tabular data) were sent verbatim to Claude even when only the summary mattered.

### What changed

**`session`: fix race condition in post-turn writes** (`src/wrapper/session.ts`)

Two concurrent `void` read-modify-write operations on `sessions.json` — one for `lastStopReason`, one for `lastCacheReadTokens` — were overwriting each other. Last writer always won, so `lastCacheReadTokens` was never stored. Consolidated into a single `updatePostTurnData({ stopReason, lastCacheReadTokens })` awaited call. Compaction can now fire correctly.

**`run-cmd`: auto-compact when cache_read exceeds threshold** (`src/cli/run-cmd.ts`)

When `autoCompact: true` (new config key, default off), spawns `/compact` silently before the real prompt whenever the prior session's `cache_read_input_tokens` exceeds `autoCompactThresholdTokens` (default 300,000). Emits two stderr lines so the user sees the compaction. When `autoCompact: false`, falls back to the advisory message from v0.2.3.

**`paste`: rule-based paste condenser** (`src/wrapper/paste.ts`)

Detects structured-data-heavy prompts: length > 800 chars, ≥ 10 non-empty lines, < 5 code keywords, > 65% short lines (< 60 chars each). Truncates the middle, keeping 350 head + 150 tail chars plus a `[... N chars of structured data truncated ...]` marker. Enabled via `enablePasteCondenser: true` in `~/.maestro/config.json`.

**`install.sh`: fix bash 3.2 incompatibility** (`scripts/install.sh`)

macOS ships bash 3.2 which rejects `${var,,}` lowercase expansion. Replaced with explicit `[[ "$var" == "y" || "$var" == "Y" ]]` check. Also adds interactive prompt to install `@xenova/transformers` optional peer during `install.sh`.

### Configuration

```json
// ~/.maestro/config.json
{
  "autoCompact": true,
  "autoCompactThresholdTokens": 300000,
  "enablePasteCondenser": true
}
```

### Upgrade

```sh
npm install -g maestro-router@0.2.4
```

---

## v0.2.3 — 2026-05-26 · Classifier accuracy + compaction advisory

**Problem:** Savings were still negative (-6%) after v0.2.2. Three remaining leaks: bare affirmations short-circuiting the pipeline at 0.8 confidence (preventing Markov from routing "yes/ok/sure" to the prior session's class); common low-context prompts hitting the LLM classifier at <0.2 confidence instead of heuristics; no signal when session cached context grew large enough to dominate per-turn cost.

### What changed

**`heuristic`: lower affirmation confidence 0.8 → 0.5** (`src/classifiers/heuristic.ts`)

Bare affirmations ("yes", "ok", "sure", "correct", etc.) previously short-circuited at 0.8 — above the 0.6 pipeline threshold — so Markov had no chance to overrule. A "yes" approving a complex plan would land in `simple` and kick off a full agentic loop on Sonnet (observed: one such turn produced 35,969 output tokens, $2.88). At 0.5 the affirmation still votes `simple` but Markov wins when recent session classes were `standard`/`hard`.

**`session`: compaction advisory when cache_read exceeds 300k tokens** (`src/wrapper/session.ts`, `src/cli/run-cmd.ts`)

Adds `lastCacheReadTokens` to `SessionRecord`, persisted after every turn. When the prior session's cached context exceeds 300,000 tokens, emits a one-line stderr advisory suggesting `/compact`. Observed: two turns with 5M and 6.2M cached tokens costing $5.63 and $2.88 respectively — dominated by cache_read charges. At 300k the advisory would have fired ~15 turns before sessions reached that scale.

**User heuristics: 5 new rules for common fallback patterns** (`~/.maestro/heuristics.json`)

| Pattern | Class | Confidence |
|---------|-------|-----------|
| `fix`, `improve`, `implement` (bare verb) | standard | 0.5 |
| `fix what you can/found` | hard | 0.75 |
| `no, same issue` / `no, still broken` | hard | 0.75 |
| `and inside ... as well` / `also in ...` | standard | 0.4 |
| Single digit (`1`, `2.`) | standard | 0.4 |

### Upgrade

```sh
npm install -g maestro-router@0.2.3
# or
pnpm add -g maestro-router@0.2.3
```

No configuration changes required.

---

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
