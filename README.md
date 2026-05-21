# maestro-router

A CLI wrapper that classifies each Claude Code prompt and routes it to the
optimal model + thinking budget. **Works on Claude Pro/Team subscriptions — no
API key required.**

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

Status: **v0.2.0-cli** — full CLI shipped, not yet on npm. Install from source
or local tarball (see below).

## What it does

For every prompt you send to Claude Code, Maestro:

1. Detects turn type (new prompt vs tool result vs error recovery)
2. Classifies complexity (override → turn-type → heuristic → LLM, short-circuit at 0.6 confidence). The LLM stage is a `claude --print --json-schema` call to Haiku (~$0.001 per uncertain prompt). Opt out with `useLlmClassifier: false` in `~/.maestro/config.json`.
3. Picks the right `--model`, `--effort`, and `--max-budget-usd` from your profile
4. Applies Claude-specific savings: `--exclude-dynamic-system-prompt-sections` (cache reuse), per-class `--tools` and `--mcp-config` restriction for low-class prompts, and `--bare` for definite-trivial patterns *when authenticated by `ANTHROPIC_API_KEY`* (Pro/Team OAuth skips `--bare` because Claude CLI doesn't read keychain credentials in bare mode)
5. Spawns `claude --print --session-id <uuid> --resume ...` so conversation continuity is preserved across model swaps
6. Logs exact cost + token counts from `--output-format json` to `~/.maestro/decisions.jsonl`

Realized savings depend on workload. A trivial `git status` prompt measured
~58% cheaper than vanilla Claude Code (cache_creation 14,429 vs 37,863) on the
verification spike. Mixed-class workloads with prompt-cache reuse across many
turns should land in the 60–80% range.

## Install

### One-shot (recommended)

From a clone of this repo:

```bash
bash scripts/install.sh
```

That runs `pnpm install` → `pnpm build` → `pnpm pack` → `npm install -g <tarball>`
→ `maestro install-vscode` (which writes `claudeCode.claudeProcessWrapper`
into VSCode's `settings.json` so every panel-UI prompt auto-routes through
Maestro). Then reload your VSCode window: `Cmd+Shift+P` → "Developer: Reload
Window".

To remove later: `bash scripts/install.sh --uninstall`.

### Manual

```bash
# 1. Prerequisites
node --version             # ≥ 20
claude --version           # ≥ 2.1.0
claude auth status         # loggedIn: true (Pro/Team subscription works)

# 2. Build from source
pnpm install --ignore-scripts
pnpm build
pnpm pack

# 3. Install the tarball globally
npm install -g ./maestro-router-0.2.0.tgz

# 4. (Optional) Wire VSCode to auto-route panel prompts
maestro install-vscode      # --dry-run to preview, --uninstall to remove
```

> `--ignore-scripts` is required because pnpm 11 gates esbuild's postinstall
> behind interactive approval. Vitest works without it.

## How to use it

### From the VSCode Claude Code panel

After `maestro install-vscode` and a window reload, **nothing changes in your
workflow** — type prompts as normal. Maestro classifies each one before it
reaches Claude and overrides `--model`/`--effort`/`--max-budget-usd` based on
the prompt's complexity. Check what happened:

```bash
maestro stats                  # cost summary, savings vs Opus-everywhere, cache hit %
maestro telemetry show --limit 20    # raw decision events
```

### From the terminal (without panel integration)

```bash
maestro run "rename foo to bar"          # explicit prompt
echo "design a caching layer" | maestro run    # from stdin
```

### Tuning

```bash
maestro tune                  # dry-run: analyze override patterns, suggest heuristics
maestro tune --learn          # focus on heuristic mining from override events
maestro tune --apply          # write learned patterns to ~/.maestro/heuristics.json
maestro bench                 # run the eval suite against your current pipeline
maestro bench --propose <file>    # validate a proposed overrides file (rejects on >2% regression)
```

## Override hints (inline)

Type any of these at the start of a prompt to force a class:

| hint                  | class     | model used                    |
|-----------------------|-----------|-------------------------------|
| `@fast`, `@haiku`     | trivial   | claude-haiku-4-5              |
| `@fast+context`       | trivial   | haiku, full context (suppresses `--bare`) |
| `@sonnet`             | standard  | claude-sonnet-4-6             |
| `@think`              | reasoning | claude-opus-4-7               |
| `@deep`, `@opus`      | max       | claude-opus-4-7 @ max effort  |

Example: `@deep find the root cause of the flaky test in worker_pool_test.go`.
The override fires before the heuristic, so the rest of the prompt is
treated as the actual question to route.

## Configuration (all optional)

Three files in `~/.maestro/` control behavior. None are required:

```
~/.maestro/config.json              # global preferences (profile, daily cap, autoLearn, ...)
~/.maestro/profile-overrides.json   # per-class model/effort/budget tweaks (edit manually)
~/.maestro/heuristics.json          # custom regex patterns → classes (auto-written by `tune --apply`, also editable)
```

Example `config.json`:

```json
{
  "profile": "balanced",
  "aggressiveness": "balanced",
  "dailyCostCapUsd": 5.00,
  "autoLearn": true,
  "excludeDynamicSections": true
}
```

Built-in profiles: `balanced` (default), `cheap`, `quality`. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full spec.

## Troubleshooting

**`maestro --version` prints nothing.** Run `which maestro` — if it points
into `node_modules` via a symlink, the `realpathSync` bin-entry check is
working (≥ v0.2.0). If it still fails, reinstall: `bash scripts/install.sh`.

**"Not logged in" from a prompt that classified as trivial.** Indicates an
older build where `--bare` was emitted on OAuth auth. Rebuild and reinstall;
v0.2.0 detects OAuth via `claude auth status` and suppresses `--bare`.

**VSCode panel didn't pick up the wrapper.** Did you reload the window?
`Cmd+Shift+P` → "Developer: Reload Window". Verify the setting is present:
`grep claudeProcessWrapper "$HOME/Library/Application Support/Code/User/settings.json"`
on macOS.

**`pnpm install` fails with `ERR_PNPM_IGNORED_BUILDS`.** pnpm 11 quirk —
pass `--ignore-scripts` (see lessons.md).

## Status & next

- **v0.0.1-core** — core machinery + classifiers + eval seed
- **v0.1.0-wrapper** — Claude CLI subprocess wrapper + session manager
- **v0.2.0-cli** — full CLI + public API + `claudeProcessWrapper` wire-compat (current)
- v0.2.1 (planned) — better replay (telemetry prompt hash), `bench --tournament` with real Claude

Backlog of considered-but-deferred ideas (remote telemetry, embedding
classifier, per-tool profile overrides, Bedrock/Codex compatibility) lives in
[docs/future-ideas.md](docs/future-ideas.md).

## More reading

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — per-prompt data flow, module
  layout, config layers, fine-tuning loop, decision register
- [tasks/todo.md](tasks/todo.md) — full build plan with every G/C/F/R/S
  decision tagged
- [docs/router-observations.md](docs/router-observations.md) — findings from
  the verification spikes (session continuity across model swap,
  `--output-format json` exact cost, `--max-budget-usd` soft-cap behavior,
  `--bare` auth incompatibility)
- [docs/lessons.md](docs/lessons.md) — gotchas hit during the build

## License

Apache 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
