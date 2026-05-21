# maestro-router

A CLI wrapper that classifies each Claude Code prompt and routes it to the
optimal model + thinking budget. **Works on Claude Pro/Team subscriptions — no
API key required.**

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

Status: **Pre-release.** v0.0.1-core in progress. Plan: [tasks/todo.md](tasks/todo.md).

## What it does

For every prompt you type in Claude Code, Maestro:

1. Detects turn type (new prompt vs tool result vs error recovery)
2. Classifies complexity (override → turn-type → heuristic, short-circuit at 0.6 confidence)
3. Picks the right `--model`, `--effort`, and `--max-budget-usd` from your profile
4. Adds Claude-specific savings (`--bare` for trivial, `--exclude-dynamic-system-prompt-sections` for cache reuse, per-class tool restriction)
5. Spawns `claude --print --session-id <uuid> --resume ...` so conversation continuity is preserved across model swaps
6. Logs the exact cost + token counts from `--output-format json` to `~/.maestro/decisions.jsonl`

Expected savings vs default Claude Code: 70–80%.

## Status

Built in three phases:

- **v0.0.1-core** — core machinery + classifiers + eval seed (Phase 1, in progress)
- **v0.1.0-wrapper** — Claude CLI subprocess wrapper + session manager (Phase 2)
- **v0.2.0-cli** — full CLI (`maestro stats`, `tune`, `replay`, `bench`) + public API (Phase 3)

## Prerequisites (once published)

- Node.js ≥ 20
- Claude Code installed (`claude --version`)
- Authenticated: `claude auth status` shows `loggedIn: true`

## License

Apache 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
