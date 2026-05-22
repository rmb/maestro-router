# maestro-router

**Automatic per-prompt model routing for Claude Code — cut AI costs 60–80% without changing how you work.**

Routes every Claude Code prompt to the cheapest model+thinking budget that will produce the right answer: `git status` goes to Haiku ($0.0003), a production incident goes to Opus ($0.05). No API key needed — works on **Claude Pro/Team subscriptions**.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](https://www.typescriptlang.org/)
[![Node ≥ 20](https://img.shields.io/badge/Node-%E2%89%A520-green)](https://nodejs.org/)

Status: **v0.2.2** — per-turn VSCode panel routing via SDK proxy, 5-stage classifier pipeline, tournament evaluator. Not yet on npm; install from source.

---

## Install

```bash
bash scripts/install.sh
```

Builds, packs, installs globally, wires `claudeCode.claudeProcessWrapper` in VSCode. Then reload VSCode: `Cmd+Shift+P` → "Developer: Reload Window".

To verify: type any prompt in the Claude Code panel, then:

```bash
tail -1 ~/.maestro/decisions.jsonl | python3 -c "import json,sys; e=json.loads(sys.stdin.read()); print(e['decision']['class'], e.get('prompt','')[:60])"
```

To remove: `bash scripts/install.sh --uninstall`.

---

## How it works

For every prompt in the VSCode panel or terminal:

1. Classifies complexity through a 5-stage pipeline: **override** → **turn-type** → **tool-override** → **heuristic** → **embedding** → **LLM**
2. Picks `--model`, `--effort`, `--max-budget-usd` from a profile (6 classes: trivial / simple / standard / hard / reasoning / max)
3. Injects a `set_model` control frame before each SDK turn — no session restart needed
4. Logs exact cost + token counts to `~/.maestro/decisions.jsonl`

Pipeline stages:
- **override** — `@fast`/`@deep`/`@think` hint at start of prompt, conf=1.0
- **turn-type** — detects tool_result, error_recovery, continuation turns
- **tool-override** — routes Read/Grep/LS → trivial, Edit/Bash → simple, Task/WebFetch → standard at conf=1.0
- **heuristic** — 45+ regex rules (git ops, version bumps, refactors, debug questions) + `~/.maestro/heuristics.json`
- **embedding** — ONNX cosine similarity vs ~60 frozen exemplars (optional peer)
- **LLM** — Haiku via `--json-schema` for ambiguous prompts (~$0.001/call, off by default in wrapper)

First stage to reach confidence ≥ 0.55 short-circuits. Otherwise weighted vote. No match → `standard`.

---

## Commands

### Routing & session

```bash
maestro run "rename foo to bar"           # classify and route a single prompt
maestro run --new-session "fresh start"   # force a new session
```

### Stats & tuning

```bash
maestro stats                             # savings vs Opus-everywhere baseline
maestro stats --since 30                  # last 30 days
maestro tune                              # show suggested heuristic patterns
maestro tune --apply                      # write learned patterns to heuristics.json
```

### Eval

```bash
maestro bench                             # accuracy on 137 labeled prompts, regression gate
maestro bench --propose overrides.json    # validate a profile change before applying
maestro bench --tournament --confirm-cost # spend ~$1–5 to find durable downgrades
```

### Setup

```bash
maestro install-vscode                    # wire claudeProcessWrapper
maestro install-hook                      # enable Stop-hook feedback
maestro install-commands                  # install /maestro-stats etc. slash commands
```

---

## Override hints

Force a class inline — Maestro strips the hint before forwarding:

| hint | class | model |
|---|---|---|
| `@fast`, `@haiku` | trivial | Haiku |
| `@fast+context` | trivial | Haiku + full context (no `--bare`) |
| `@sonnet` | standard | Sonnet |
| `@think` | reasoning | Opus high |
| `@deep`, `@opus` | max | Opus high |

---

## Configuration

```
~/.maestro/config.json              # global preferences
~/.maestro/profile-overrides.json   # per-class model/effort/budget tweaks
~/.maestro/heuristics.json          # custom regex rules (auto-written by tune --apply)
<cwd>/.maestro/config.json          # per-project overrides (profile, excludeDynamicSections, useEmbeddingClassifier)
```

Example `~/.maestro/config.json`:

```json
{
  "profile": "balanced",
  "feedbackPrompts": "occasional",
  "feedbackSampleRate": 0.2,
  "excludeDynamicSections": true,
  "useEmbeddingClassifier": true
}
```

Built-in profiles: `balanced` (default), `cheap` (Haiku-biased), `quality` (Opus-biased).

---

## Troubleshooting

**VSCode panel not routing.** Did you reload the window? Verify the setting:
```bash
grep claudeProcessWrapper "$HOME/Library/Application Support/Code/User/settings.json"
```
If missing: `maestro install-vscode` then reload.

**`maestro --version` broken.** Reinstall: `bash scripts/install.sh`.

**`pnpm install` fails with `ERR_PNPM_IGNORED_BUILDS`.** Pass `--ignore-scripts`. The install script does this automatically.

**`pnpm build` fails with "Run pnpm embed first".** Skip the gate: `MAESTRO_SKIP_EMBED_CHECK=1 pnpm build`. `install.sh` sets this automatically.

---

## Roadmap

| Version | Status |
|---|---|
| v0.2.2 | Per-turn panel routing via SDK proxy |
| **v0.3.0** | Per-tool routing (Read/Grep → Haiku automatically) |
| v0.3.1 | Tournament matrix (model × effort) |
| v0.3.2 | Per-project config field restrictions |
| v0.3.3 | `maestro init` / `maestro doctor` |

---

## More reading

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — data flow, module layout, config layers
- [docs/future-ideas.md](docs/future-ideas.md) — deferred features
- [docs/router-observations.md](docs/router-observations.md) — verification spikes

## License

Apache 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
