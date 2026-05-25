# maestro-router

**Automatic per-prompt model routing for Claude Code — cut AI costs 60–80% without changing how you work.**

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](https://www.typescriptlang.org/)
[![Node ≥ 20](https://img.shields.io/badge/Node-%E2%89%A520-green)](https://nodejs.org/)

---

## What this is and why you need it

Claude Code uses the same model for every prompt. `git status`, a one-line rename, and "design a distributed cache" all hit Opus at the same cost — even though Haiku handles the first two just as well and costs 50× less.

Maestro sits between you and Claude Code and fixes that. Every prompt is classified by complexity and routed to the cheapest model that will produce the right answer:

| Prompt | Class | Model | Cost |
|---|---|---|---|
| `git status` | trivial | Haiku | ~$0.0003 |
| Rename a variable | simple | Haiku | ~$0.001 |
| Add a feature | standard | Sonnet | ~$0.01 |
| Debug a production incident | hard | Opus | ~$0.05 |
| Architect a system | max | Opus max | ~$0.10 |

You don't change anything. Same Claude Code interface, same commands, same VSCode panel. Maestro handles the routing invisibly.

**No API key needed.** Works on Claude Pro/Team subscriptions via the standard CLI OAuth flow.

---

## Install

```bash
bash scripts/install.sh
```

Builds, installs globally, and wires `claudeCode.claudeProcessWrapper` in VSCode. Then reload VSCode: `Cmd+Shift+P` → "Developer: Reload Window".

Verify it's working — type any prompt in the Claude Code panel, then:

```bash
tail -1 ~/.maestro/decisions.jsonl | python3 -c "import json,sys; e=json.loads(sys.stdin.read()); print(e['decision']['class'], e.get('prompt','')[:60])"
```

To remove: `bash scripts/install.sh --uninstall`.

---

## How it works

For every prompt, Maestro runs a 5-stage classifier pipeline — cheapest stages first, short-circuiting as soon as any stage reaches 55% confidence:

1. **Override** — explicit hints like `@fast` or `@deep` in the prompt (confidence 1.0)
2. **Turn-type** — detects tool results, error recovery, and continuation turns
3. **Heuristic** — 45+ regex rules for common patterns (git ops, refactors, debug questions) plus your own learned rules
4. **Embedding** — ONNX cosine similarity against ~60 labeled examples (optional)
5. **LLM** — Haiku via `--json-schema` for genuinely ambiguous prompts (~$0.001/call, off by default)

The winner maps to one of six classes: **trivial → simple → standard → hard → reasoning → max**, each with a configured model, effort level, and cost ceiling. No match defaults to `standard`.

### Session fingerprinting (Track Z)

Anthropic's prompt cache is keyed by the exact system-prompt prefix — any flag change (`--tools`, `--bare`, `--append-system-prompt`, `--mcp-config`) creates a new cache entry and pays the full `cache_creation` cost (~$0.035 per session start). Maestro fingerprints each session by hashing all system-prompt-affecting flags together: `sha256([model, tools, mcpConfig, bare, excludeDynamic, appendSystemPrompt])`. Sessions with an identical fingerprint reuse the same `--session-id` even across class transitions, keeping the cache prefix stable. Sessions with different fingerprints (e.g. trivial's `--bare` vs standard's full tool set) get separate IDs so they never cross-contaminate.

This is the single largest cost lever. A session boot (`cache_creation`) typically dominates 80–99% of first-turn cost. Track Z eliminates redundant boots across the most common class transitions.

### Cost-reduction layers applied per turn

- **E1** — `standard` class runs at `effort: low` (was `medium`), cutting thinking tokens 60–80% for the highest-volume class without measurable accuracy loss on typical dev tasks.
- **X** — Hard output caps: standard → 8000 tokens, hard → 4000, reasoning → 6000. Brevity hints appended to system prompt for trivial/simple classes.
- **K1** — In-process classifier cache: `sha256(prompt) → class`. Max-tokens outcomes invalidate the entry so a truncated response forces re-classification upward.
- **M1** — Continuation detection requires two signals (linguistic match + prior `max_tokens` stop) before injecting a "resume" hint. Single-signal matches no longer downgrade to simple.
- **K2** — Markov lock-in escape: if the prompt is >2.5× the session rolling average length, contains escalation keywords, or follows a `max_tokens` stop, Maestro ignores the cached class and re-classifies.

---

## Commands

```bash
# Routing
maestro run "rename foo to bar"           # classify and route a single prompt
maestro run --new-session "fresh start"   # force a new session

# Cost and savings
maestro stats                             # savings vs Opus-everywhere baseline
maestro stats --since 30                  # last 30 days
maestro health                            # compare current metrics against saved baseline
maestro health --set-baseline             # save current state as the new health baseline

# Oracle evaluation
maestro oracle                            # full offline audit — tool, telemetry, tokens
maestro oracle --dimension tool           # single-dimension run
maestro oracle --dimension tokens --since 30
maestro oracle --dimension quality --confirm-cost   # live quality probes (costs money)
maestro oracle --json                     # machine-readable output for CI

# Tuning
maestro tune                              # show suggested heuristic improvements
maestro tune --apply                      # write learned patterns to heuristics.json
maestro tune --posthog                    # mine cross-user patterns from PostHog

# Evaluation
maestro bench                             # accuracy on labeled eval set
maestro bench --propose overrides.json    # validate a profile change before applying
maestro bench --tournament --confirm-cost # empirically find safe model downgrades (see below)

# Setup
maestro install-vscode                    # wire claudeProcessWrapper in VSCode
maestro install-hook                      # enable Stop-hook feedback collection
```

---

## Tournament — empirically validate downgrades

Maestro's routing is conservative by default. The tournament lets you verify which downgrades are actually safe for your workload before applying them.

For each sampled prompt it runs three spawns:
1. **A** — current assigned class (e.g. standard → Sonnet)
2. **B** — one tier cheaper (e.g. simple → Haiku)
3. **Judge** — Sonnet compares both responses and returns `winner: A | B | tie`

When B wins or ties, that prompt is a safe downgrade candidate. Maestro mines the winning prompts for common patterns and proposes new heuristic rules.

```bash
maestro bench --tournament --confirm-cost    # runs tournament, requires explicit cost approval
maestro bench --propose results.json         # validate mined rules against eval baseline before applying
maestro tune --apply                         # write approved rules to ~/.maestro/heuristics.json
```

The `--confirm-cost` flag is required — a full tournament run costs $1–5 depending on sample size. Without it, the command prints an estimate and exits.

---

## Override hints

Force a specific class inline — Maestro strips the hint before forwarding to Claude:

| Hint | Class | Model |
|---|---|---|
| `@fast`, `@haiku` | trivial | Haiku |
| `@sonnet` | standard | Sonnet |
| `@think` | reasoning | Opus high |
| `@deep`, `@opus` | max | Opus max |

Example: `@fast format this file` or `@deep find the root cause of this race condition`.

---

## Configuration

```
~/.maestro/config.json              # global preferences
~/.maestro/profile-overrides.json   # per-class model/effort/budget tweaks
~/.maestro/heuristics.json          # custom regex rules (managed by tune --apply)
<repo>/.maestro/config.json         # per-project routing preferences
```

Example `~/.maestro/config.json`:

```json
{
  "profile": "balanced",
  "excludeDynamicSections": true,
  "useEmbeddingClassifier": true,
  "feedbackPrompts": "occasional"
}
```

Built-in profiles: `balanced` (default), `cheap` (Haiku-biased), `quality` (Opus-biased).

### Per-project config

Drop a `.maestro/` directory anywhere in your repo. Maestro walks up from `cwd` and loads the nearest one, layered on top of your global config. Useful for repos that need a different profile or extra heuristic rules without affecting your other projects.

Allowed per-project fields: `profile`, `excludeDynamicSections`, `useEmbeddingClassifier`. Fields like `telemetryPath` and billing caps are global-only so a committed `.maestro/config.json` can't silently affect teammates.

---

## Community tuning

Maestro improves its routing over time. Once a week, a GitHub Actions workflow mines anonymized override patterns from PostHog (prompts where users used `@deep` or `@fast` to correct the auto-routing) and publishes updated heuristics to `community/heuristics.json`. On your next spawn, Maestro silently fetches and merges any new patterns into your local `~/.maestro/heuristics.json`.

To opt into contributing your own override patterns, set `posthogApiKey` in `~/.maestro/config.json` with the project key. No prompt text is sent unless you also set `sendPromptText: true`.

---

## Troubleshooting

**VSCode panel not routing.**
```bash
grep claudeProcessWrapper "$HOME/Library/Application Support/Code/User/settings.json"
```
If missing: `maestro install-vscode` then reload the window.

**`pnpm install` fails with `ERR_PNPM_IGNORED_BUILDS`.** Pass `--ignore-scripts`. The install script handles this automatically.

**`pnpm build` fails with "Run pnpm embed first".** Run `MAESTRO_SKIP_EMBED_CHECK=1 pnpm build`. The install script sets this automatically.

---

## More reading

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — data flow, module layout, design decisions
- [docs/router-observations.md](docs/router-observations.md) — spike results and verified behaviors

## License

Apache 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
