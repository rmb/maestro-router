# maestro-router

**Automatic per-prompt model routing for Claude Code — cut AI costs 60–80%
without changing how you work.**

Routes every Claude Code prompt to the cheapest model+thinking budget that will
produce the right answer: `git status` goes to Haiku ($0.0003), a production
incident goes to Opus max ($0.05). No API key needed — works on **Claude
Pro/Team subscriptions** via OAuth.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](https://www.typescriptlang.org/)
[![Node ≥ 20](https://img.shields.io/badge/Node-%E2%89%A520-green)](https://nodejs.org/)

> **Keywords:** Claude Code cost optimization · LLM routing · model selection · Haiku Sonnet Opus · Claude Pro · Claude Team · AI cost reduction · prompt classification · VSCode Claude extension

Status: **v0.2.2** — five-stage classifier pipeline, per-turn model routing for
the VSCode panel, Stop-hook feedback, tournament evaluator. Not yet on npm;
install from source.

---

## What it does

For every prompt you send to Claude Code, Maestro:

1. **Detects turn type** (new user prompt vs tool result vs error recovery vs continuation)
2. **Classifies complexity** through a 5-stage pipeline (override → turn-type → heuristic → embedding → LLM), short-circuiting at confidence ≥ 0.55
3. **Picks the right `--model`, `--effort`, `--max-budget-usd`** from your profile (six classes: trivial / simple / standard / hard / reasoning / max)
4. **Applies Claude-specific savings**:
   - `--exclude-dynamic-system-prompt-sections` for cross-session cache reuse
   - Per-class `--tools` and `--mcp-config` restriction for low-class prompts (smaller cached system prompt)
   - `--bare` for definite-trivial patterns *when authenticated by `ANTHROPIC_API_KEY`* (suppressed on OAuth since Claude CLI doesn't read keychain in bare mode)
5. **Routes per-turn in the VSCode panel**: the `--input-format stream-json` channel is intercepted as a long-lived proxy; each user turn is classified independently and spawned as `claude --print --resume`, so a session that starts with `"what does this do?"` can escalate to `"redesign the cache layer"` on the right model mid-session. Session continuity is preserved via `--session-id` + `--resume` across all turns.
6. **Logs exact cost + token counts** from `--output-format json` to `~/.maestro/decisions.jsonl`

**Typical savings: 60–80% on mixed workloads.** A `git status` measured ~58%
cheaper; a writing session with frequent file-edit tool results saves more
because each write-confirmation turn now routes to Haiku instead of Sonnet.
`maestro stats` shows your actual realized savings.

### Why it exists

Claude Opus/Sonnet are overkill for the majority of prompts in a real coding
session: `git commit`, version bumps, "add a docstring", "remove unused
imports", tool-result acknowledgements. Routing these to Haiku costs ~$0.0003
instead of ~$0.015 for Sonnet. Maestro does this automatically — you keep
using Claude Code exactly as before.

If you've ever thought "this is wasting Opus on a rename", Maestro is the fix.

---

## Install

### One-shot (recommended)

```bash
bash scripts/install.sh
```

That runs `pnpm install` → `pnpm build` → `pnpm pack` → `npm install -g <tarball>`
→ `maestro install-vscode` (writes `claudeCode.claudeProcessWrapper` into
VSCode's `settings.json` so panel-UI prompts auto-route).

Reload VSCode: `Cmd+Shift+P` → "Developer: Reload Window".

Two optional extras:

```bash
maestro install-hook                                          # enable Stop-hook feedback prompts
npm install -g @xenova/transformers && pnpm embed && pnpm build   # enable the embedding classifier
```

To remove everything: `bash scripts/install.sh --uninstall`.

### Manual

```bash
# Prereqs
node --version             # ≥ 20
claude --version           # ≥ 2.1.0
claude auth status         # loggedIn: true (Pro/Team subscription works)

# Build
pnpm install --ignore-scripts
MAESTRO_SKIP_EMBED_CHECK=1 pnpm build     # bypass embed gate (peer is optional)
pnpm pack
npm install -g ./maestro-router-0.2.0.tgz

# Wire VSCode + (optionally) the Stop-hook
maestro install-vscode
maestro install-hook
```

`--ignore-scripts` is required because pnpm 11 gates esbuild's postinstall
behind interactive approval. Vitest works without it.

---

## Daily workflow

Once installed, the typical loop:

```
type prompts in Claude Code (panel or terminal) — Maestro auto-routes
       ↓
maestro stats                       # weekly: see savings
       ↓
maestro tune                        # see patterns you keep overriding
       ↓
maestro tune --apply                # commit the learned patterns
       ↓
maestro bench --propose <file>      # validate before applying anything risky
```

For the cost-conscious one-time deep tuning pass:

```
maestro bench --tournament --confirm-cost   # spend ~$5 to find durable downgrades
```

---

## Command reference

Every command supports `-h/--help`, `--json`, `-q/--quiet`, `-v/--verbose`,
`--config <path>`.

### `maestro run [prompt...]` — route one prompt explicitly

**Why use it:** When you want Maestro to classify and forward a prompt from
your terminal — outside the VSCode panel — and stream the result back. The
panel path goes through `install-vscode` and you never call `run` directly
there; `run` is for piping prompts into Maestro deliberately.

```bash
maestro run "rename foo to bar"                          # heuristic → trivial → haiku --bare (if API key) 
maestro run "design a caching layer for auth"            # heuristic+LLM → reasoning → opus high
echo "implement debounce in TypeScript" | maestro run    # from stdin
maestro run --new-session "fresh start"                  # force a new session id (no --resume)
```

After running, the decision is appended to `~/.maestro/decisions.jsonl` and
the realized cost is captured from `claude --output-format json`.

### `maestro install-vscode` — wire VSCode panel auto-routing

**Why use it:** Without it, the VSCode Claude Code extension calls `claude`
directly and bypasses Maestro entirely. With it, every panel-UI prompt is
auto-routed.

```bash
maestro install-vscode                # default install
maestro install-vscode --dry-run      # preview the settings.json edit
maestro install-vscode --uninstall    # remove only Maestro's entry
maestro install-vscode --path <p>     # custom settings.json (non-default VSCode location)
maestro install-vscode --wrapper <p>  # custom maestro binary path
```

The install is JSONC-aware — it preserves your comments and other settings.
Reload VSCode after running.

### `maestro install-hook` — enable Stop-hook feedback

**Why use it:** Lets Maestro occasionally ask "how was that response?" with a
1-5 rating after Claude finishes. Ratings feed `maestro tune` so routing
quality improves over time.

```bash
maestro install-hook                   # writes Stop hook to ~/.claude/settings.json
maestro install-hook --dry-run         # preview
maestro install-hook --uninstall       # remove only Maestro's entry
```

Configure sampling in `~/.maestro/config.json`:

```json
{
  "feedbackPrompts": "occasional",      // never | occasional | always
  "feedbackSampleRate": 0.2             // when "occasional": 1-in-5 (default)
}
```

The hook prompts via `/dev/tty` so it doesn't pollute Claude's stdout pipe.
Press 1-5 to record; any other key (including Enter) skips. Errors never
block the hook chain.

### `maestro telemetry` — inspect and audit local data

**Why use it:** Audit what Maestro has logged about your decisions, or
manually rate a session you remember being especially good/bad.

```bash
maestro telemetry status                              # event count, last write, file path
maestro telemetry show                                # last 50 events as JSONL
maestro telemetry show --limit 200                    # more
maestro telemetry feedback <sid> --rating 4          # manual rating (1-5)
maestro telemetry feedback <sid> --rating 5 --note "perfect for refactors"
```

Everything stays on disk in `~/.maestro/decisions.jsonl`. No upload, no
network. Auto-sampled feedback events carry `source: "auto"`; manual ones
carry `source: "manual"`.

### `maestro stats` — see realized savings

**Why use it:** This is the "is this thing actually working?" command. Run it
weekly.

```bash
maestro stats                # last 7 days, human-readable
maestro stats --since 30     # last 30 days
maestro stats --json         # machine-readable
```

Reports:
- Total spent vs estimated `Opus-everywhere` baseline
- Cache hit rate (% of prompts bypassing the pipeline entirely)
- Cache-creation cost (session bootstraps) vs in-session turn cost
- Per-class distribution (count, avg cost, override rate, P95 cache-creation tokens)
- Top override patterns — prompts you keep correcting with `@deep`/`@fast`. If you see the same pattern more than a few times, run `maestro tune --learn` to make it automatic.

### `maestro tune` — auto-learn from override patterns

**Why use it:** Maestro starts with built-in heuristics that work decently
out of the box. Your override behavior teaches it your specific patterns.
`tune` mines those overrides and proposes regex rules.

```bash
maestro tune                  # dry-run: show suggested patterns + classes with high override rate
maestro tune --learn          # focus on heuristic mining (≥5 same-token overrides → rule)
maestro tune --apply          # write learned patterns to ~/.maestro/heuristics.json
maestro tune --since 14       # analyze last 14 days (default 30)
```

`tune --apply` is reversible — open `~/.maestro/heuristics.json` and delete
or edit rules whenever. To validate a proposal before applying it system-wide,
use `bench --propose`.

### `maestro replay <log>` — re-route old logs against current pipeline

**Why use it:** A/B test pipeline changes. After `tune --apply`, replay your
decision log to see which past decisions would change.

```bash
maestro replay ~/.maestro/decisions.jsonl
maestro replay backup.jsonl --limit 500
```

Note: v0.2.1 telemetry doesn't yet log raw prompt text (only hashes), so
replay is class-only. A future version may add opt-in prompt logging.

### `maestro bench` — eval suite + regression gate

**Why use it:** Catch accidental accuracy drops from heuristic or profile
changes. The default run is fast and free (no live Claude calls).

```bash
maestro bench                                  # default: 137 labeled prompts, regression gate at 2%
maestro bench --propose <overrides.json>       # validate proposed change before apply
maestro bench --update-baseline                # accept current accuracy as the new baseline
maestro bench --gate 0.05                      # looser regression gate
```

Three opt-in modes that cost real money or time:

```bash
maestro bench --llm                            # include the LLM classifier (~$0.001 per uncertain prompt)
maestro bench --embedding                      # include the embedding classifier (needs @xenova/transformers + pnpm embed)
maestro bench --tournament --confirm-cost      # see Tournament below
```

### Tournament mode — empirically validate safe downgrades

**Why use it:** A one-time investment that finds durable wins. For each
sampled prompt, Maestro spawns `A` (current tier) and `B` (one tier cheaper)
through real Claude, then a Sonnet judge picks a winner. Where B wins or
ties, Maestro proposes a regex rule to make that downgrade automatic.

```bash
# Preview cost (no spend)
maestro bench --tournament

# Default run: 10 prompts × 3 calls ≈ $1.50, capped at $5
maestro bench --tournament --confirm-cost

# Larger run
maestro bench --tournament --confirm-cost --tournament-sample 30 --tournament-budget 15

# Save proposed overrides, validate before applying
maestro bench --tournament --confirm-cost --tournament-output proposed.json
maestro bench --propose proposed.json    # gate against the regression baseline
```

Sequential calls (ctrl-C is clean, budget cap is reliable). The judge gets
the prompt + both responses wrapped in `<RESPONSE_A>` / `<RESPONSE_B>` tags
and answers with JSON `{ winner: "A" | "B" | "tie", reason }`. Tournament
output is consumable by `bench --propose` so you can gate it through the
same regression check you use for `tune --apply`.

---

## Override hints (inline)

Type any of these at the start of a prompt to force a class. Maestro strips
the hint before forwarding to Claude.

| hint                  | class     | model used                    |
|-----------------------|-----------|-------------------------------|
| `@fast`, `@haiku`     | trivial   | claude-haiku-4-5              |
| `@fast+context`       | trivial   | haiku, full context (suppresses `--bare`) |
| `@sonnet`             | standard  | claude-sonnet-4-6             |
| `@think`              | reasoning | claude-opus-4-7               |
| `@deep`, `@opus`      | max       | claude-opus-4-7 @ max effort  |

`@fast+context` is the safety hatch — use it when the prompt is trivial but
you do need project context (e.g. "rename `foo` to `bar` everywhere it's
imported"). Without `+context`, `--bare` strips CLAUDE.md and plugins.

Example: `@deep find the root cause of the flaky test in worker_pool_test.go`.
The override matches first; the rest is the question to route.

---

## Configuration

Three optional files in `~/.maestro/` control behavior. Per-project overrides
in `<cwd>/.maestro/` stack on top (per-project wins per-key) — useful when
one repo wants quality defaults and another wants cheap.

```
~/.maestro/config.json              # global preferences
~/.maestro/profile-overrides.json   # per-class model/effort/budget tweaks
~/.maestro/heuristics.json          # custom regex patterns (auto-written by `tune --apply`)
```

Example `~/.maestro/config.json`:

```json
{
  "profile": "balanced",
  "aggressiveness": "balanced",
  "dailyCostCapUsd": 5.00,
  "feedbackPrompts": "occasional",
  "feedbackSampleRate": 0.2,
  "autoLearn": true,
  "excludeDynamicSections": true,
  "useLlmClassifier": true,
  "useEmbeddingClassifier": true
}
```

Built-in profiles: `balanced` (default), `cheap` (Haiku-biased), `quality`
(Opus-biased). See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full
profile spec.

Per-project example — `<your-repo>/.maestro/config.json`:

```json
{
  "profile": "quality",
  "useLlmClassifier": false
}
```

That repo's prompts use the `quality` profile and skip the LLM stage; every
other repo still uses your global defaults.

---

## Optional: enable the embedding classifier

The embedding classifier (S2) is a local ONNX feature-extraction stage that
catches prompts the regex heuristic misses but that are semantically close to
the frozen exemplar set. It runs between heuristic and LLM, so it can
short-circuit before paying the ~$0.001 LLM cost on ambiguous prompts.

```bash
npm install -g @xenova/transformers     # ~22MB ONNX model on first use
pnpm embed                              # generates src/classifiers/exemplars.json
pnpm build                              # the checksum gate verifies the file
```

Without the peer, the classifier returns null on every call and the pipeline
continues to LLM (or the weighted vote). No regression, just no uplift.
Disable explicitly via `useEmbeddingClassifier: false`.

---

## The classifier pipeline (at a glance)

```
prompt → override → turn-type → heuristic  → embedding → llm
          @fast?    tool_result? 45+ rules   similar?    haiku
          1.0       0.85         0.75–1.0    0.55–1.0   0.7–0.95
                                                       ↓
                                            vote (weighted) → cache → spawn claude
```

- **override (1.0)** — `@fast`/`@deep`/etc. wins instantly
- **turn-type (0.85)** — tool_result after Read/Grep/Write/Edit → trivial; error_recovery → hard
- **heuristic (0.75–1.0)** — 45+ built-in regex rules (git ops, version bumps, test writing, refactors, debug questions, trade-off analysis) + user `heuristics.json`
- **embedding (0.55–1.0)** — cosine similarity vs ~60 frozen exemplars (optional peer)
- **LLM (0.7–0.95)** — final fallback for ambiguous prompts via `claude --print --model haiku --json-schema`; ~$0.001/call

First classifier with confidence ≥ 0.55 short-circuits. Otherwise, all
sub-threshold results vote weighted. Empty pipeline → default `standard`.

Full data flow + module breakdown:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Troubleshooting

**`maestro --version` prints nothing.** Run `which maestro` — it should point
at `node_modules` via a symlink. If broken, reinstall: `bash scripts/install.sh`.

**"Not logged in" from a prompt that classified as trivial.** Older build
emitted `--bare` on OAuth auth. v0.2.0+ detects OAuth via `claude auth status`
and suppresses `--bare`. Reinstall.

**VSCode panel didn't pick up the wrapper.** Did you reload the window?
`Cmd+Shift+P` → "Developer: Reload Window". Verify the setting is present:

```bash
grep claudeProcessWrapper "$HOME/Library/Application Support/Code/User/settings.json"
```

**Pipeline always returns `class=standard, classifier=default` and stderr
shows `llm classifier timed out`.** The LLM classifier's cold Claude spawn
exceeded its timeout (cold start can take 3–5s while the system prompt is
cached). v0.2.1+ uses a 10s default. If still triggering, the session's
system prompt is enormous; subsequent turns on the same session will be
fast because of cache reuse.

**`pnpm install` fails with `ERR_PNPM_IGNORED_BUILDS`.** pnpm 11 quirk —
pass `--ignore-scripts`. The `install.sh` script already does this.

**`pnpm build` fails with "Run `pnpm embed` first".** The embedding peer
isn't installed. Either install it and embed, or skip the gate:

```bash
MAESTRO_SKIP_EMBED_CHECK=1 pnpm build
```

`install.sh` sets this automatically.

---

## Status & roadmap

| Version | What shipped |
|---|---|
| v0.0.1-core | Core machinery + classifiers + eval seed |
| v0.1.0-wrapper | Claude CLI subprocess wrapper + session manager |
| v0.2.0-cli | Full CLI + public API + `claudeProcessWrapper` wire-compat |
| v0.2.1 | LLM classifier (S12), F2 per-project config, S4 tournament, F7 Stop-hook, S2 embedding |
| **v0.2.2** | Per-turn panel routing: stream-json proxy intercepts each VSCode turn independently |
| v0.2.3 (next) | +15 heuristic rules (git ops, tests, debug, tradeoffs), lower short-circuit threshold, write-tool turns → trivial |

Backlog of considered-but-deferred ideas (remote anonymized telemetry,
Bedrock/Codex compatibility, etc.) lives in
[docs/future-ideas.md](docs/future-ideas.md).

## More reading

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — per-prompt data flow, module layout, config layers, fine-tuning loop, decision register
- [tasks/todo.md](tasks/todo.md) — full build plan with every G/C/F/R/S decision tagged
- [docs/router-observations.md](docs/router-observations.md) — verification spike findings (session continuity across model swap, `--output-format json` exact cost, `--max-budget-usd` soft-cap behavior, `--bare` auth incompatibility)
- [docs/lessons.md](docs/lessons.md) — gotchas hit during the build
- [docs/adr/](docs/adr/) — architecture decision records

## License

Apache 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
