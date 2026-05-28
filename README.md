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

Your VSCode panel, `maestro run`, and `maestro shell` work the same. Maestro routes every turn before Claude sees it.

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

**Optional: embedding classifier (~400 MB, recommended for heavy users)**

Maestro ships a semantic embedding stage that catches prompts heuristics miss without burning an LLM call. It's an optional peer to avoid forcing 400 MB on every install. If you use Maestro heavily (50+ prompts/day), install it:

```bash
npm install -g @xenova/transformers
```

Without it, the pipeline falls through to the LLM classifier for uncertain prompts (~$0.001/call instead of local inference). You'll see `info.fallback.embedding_unavailable` in the routing log. With it, that warning disappears and the embedding stage runs instead.

---

## How it works — step by step

Here's exactly what happens between you pressing Enter and Claude responding.

**Step 1 — Your prompt is intercepted.**
You type a message in the VSCode Claude panel, run `maestro run "…"`, or start `maestro shell`. In all three modes, every prompt lands in Maestro first; Claude never sees it until Maestro decides what to do with it.

**Step 2 — Slash commands are passed through unchanged.**
`/clear`, `/model`, `/help`, `/cost`, `/compact` are detected by `wrapper/passthrough.ts` and forwarded to Claude as-is. No classification, no routing decision, no cost.

**Step 3 — The classifier pipeline runs.**
For all other prompts, Maestro runs up to 8 classifiers in cheapest-first order. Each returns a class (trivial / simple / standard / hard / reasoning / max) and a confidence score, or null if it has no signal. The pipeline short-circuits the moment any stage returns confidence ≥ 0.55:

| Stage | What it checks | Cost per call |
|---|---|---|
| Override | `@fast`, `@deep`, `@think`, etc. at start of prompt | $0 |
| Turn-type | Is this a tool result? Error recovery? Continuation? | $0 |
| Tool-result-content | Content patterns inside tool outputs (errors, large reads) | $0 |
| Tool-override | Model hints embedded in tool names or outputs | $0 |
| Markov | Recent session class history (prior 5 turns) | $0 |
| Heuristic | 45+ compiled regexes (git ops, renames, incidents, design vocab) | $0 |
| Embedding | ONNX cosine similarity vs. ~60 labeled examples (optional) | ~$0 CPU |
| LLM | Haiku via `--json-schema` for genuinely ambiguous prompts | ~$0.001 |

If no stage clears the threshold, a weighted vote runs across all sub-threshold results. If that still produces no winner, the prompt defaults to `standard`. The fallback is tracked separately in telemetry so you can see classifier coverage gaps in `maestro stats`.

**Step 4 — The class is mapped to a model profile.**
`core/profile.ts` converts the class into concrete CLI flags:

| Class | Model | Effort | Budget cap |
|---|---|---|---|
| trivial | Haiku | low | $0.005 |
| simple | Haiku | low | $0.01 |
| standard | Sonnet | low | $0.05 |
| hard | Opus | medium | $0.15 |
| reasoning | Opus | high | $0.30 |
| max | Opus | max | $0.50 |

**Step 5 — Session reuse is checked.**
Maestro hashes all system-prompt-affecting flags (`model`, `tools`, `--bare`, `--mcp-config`, etc.) into a 16-char fingerprint. If a session for this `cwd` with this fingerprint already exists and is less than 24 hours old, Maestro reuses it with `--session-id` + `--resume`. This is the single biggest cost lever: Anthropic's system prompt cache (~37k tokens) costs ~$0.035 per cold boot. Reusing a session brings that to ~$0.001.

**Step 6 — `claude --print` is spawned with the right flags.**
`wrapper/spawn.ts` builds the final command:
```
claude --print --output-format json
  --session-id <uuid> --resume
  --model claude-haiku-4-5 --effort low --max-budget-usd 0.005
  [--append-system-prompt "Output only the answer."]
```
stdout is piped live to your terminal so you see tokens stream in real time.

**Step 7 — Cost and routing are logged.**
After the response completes, `wrapper/output.ts` parses the JSON envelope from Claude for exact token counts. Cost is derived from those volumes via the same rate table that backs `maestro stats` — `total_cost_usd` is fabricated on Pro/Team subscriptions and is not used. The decision is appended to `~/.maestro/decisions.jsonl`.

---

### Why this saves money in practice

Most coding sessions are 80–90% simple prompts (git ops, small edits, quick lookups) mixed with a handful of genuinely complex ones. Without routing, every single prompt pays Opus pricing. With Maestro, only the hard ones do. On a typical day of active coding, savings run 60–80%.

The other big lever is session reuse. Before Track Z (fingerprint-based session sharing), every class transition paid a $0.035 boot cost. Now, adjacent classes share sessions when their flag sets match, so a session started by a trivial git-status check is reused by the next standard coding prompt — you pay the boot cost once, not once per prompt.

---

## How it works — technical pipeline

For every prompt, Maestro runs an 8-stage classifier pipeline — cheapest stages first, short-circuiting as soon as any stage reaches 55% confidence:

1. **Override** — explicit hints like `@fast` or `@deep` in the prompt (confidence 1.0)
2. **Turn-type** — detects tool results, error recovery, and continuation turns
3. **Tool-result-content** — patterns in the content of tool outputs (errors, large reads)
4. **Tool-override** — model hints embedded in tool names or outputs
5. **Markov** — recent session class history biases toward the session's dominant class
6. **Heuristic** — 45+ regex rules for common patterns (git ops, refactors, debug questions) plus your own learned rules
7. **Embedding** — ONNX cosine similarity against ~60 labeled examples (optional)
8. **LLM** — Haiku via `--json-schema` for genuinely ambiguous prompts (~$0.001/call, off by default)

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
maestro shell                             # interactive REPL with per-turn routing (terminal)
maestro shell --new                       # fresh session, skip Markov seeding from prior history

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
maestro bench --eval [path]               # run eval set (defaults to bundled evals/labeled.jsonl)
maestro bench --propose overrides.json    # validate a profile change before applying
maestro bench --tournament --confirm-cost # empirically find safe model downgrades (see below)

# Export and fine-tuning
maestro export-prompts                    # export classified prompts as relabel-ready JSONL
maestro export-prompts --fallbacks        # export forced-standard corpus from ~/.maestro/fallbacks.jsonl
maestro export-prompts --setfit           # export SetFit training format {text, label}
maestro export-corrections                # export override corrections as classifier training signal
                                          # (pipe output to scripts/dspy-optimize.py for LLM tuning)

# Telemetry
maestro telemetry status                  # event count, last-write timestamp, file path
maestro telemetry show [--limit <n>]      # print recent events as JSONL
maestro telemetry feedback <sessionId> --rating <1-5>   # record quality rating
maestro telemetry langfuse --public-key <key> --secret-key <key>   # configure Langfuse
maestro telemetry langfuse --remove       # remove Langfuse keys from config
maestro telemetry off                     # disable remote (PostHog) event reporting
maestro telemetry forget --confirm        # delete all local telemetry events

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
  "embeddingModel": "Xenova/all-MiniLM-L6-v2",
  "autoCompact": true,
  "autoCompactThresholdTokens": 300000,
  "feedbackPrompts": "occasional"
}
```

Built-in profiles: `balanced` (default), `cheap` (Haiku-biased), `quality` (Opus-biased).

**`autoCompact`** — when `true`, Maestro injects `/compact` into the VSCode panel conversation before the next user message whenever `cache_read_input_tokens` exceeds `autoCompactThresholdTokens` (default 300k). This keeps context windows manageable without manual intervention. Fires only once per threshold crossing; resets if you manually send `/compact`. The `maestro stats` output includes a "compact hints" counter showing how often the advisory fired.

**`embeddingModel`** — override the ONNX model used by the embedding classifier. Defaults to `Xenova/all-MiniLM-L6-v2` when `@xenova/transformers` is installed.

### Per-project config

Drop a `.maestro/` directory anywhere in your repo. Maestro walks up from `cwd` and loads the nearest one, layered on top of your global config. Useful for repos that need a different profile or extra heuristic rules without affecting your other projects.

Allowed per-project fields: `profile`, `excludeDynamicSections`, `useEmbeddingClassifier`. Fields like `telemetryPath` and billing caps are global-only so a committed `.maestro/config.json` can't silently affect teammates.

---

## Community tuning

Maestro improves its routing over time. Once a week, a GitHub Actions workflow mines anonymized override patterns from PostHog (prompts where users used `@deep` or `@fast` to correct the auto-routing) and publishes updated heuristics to `community/heuristics.json`. On your next spawn, Maestro silently fetches and merges any new patterns into your local `~/.maestro/heuristics.json`.

To opt into contributing your own override patterns, set `posthogApiKey` in `~/.maestro/config.json` with the project key. No prompt text is sent unless you also set `sendPromptText: true`.

---

## Pairing with RTK

[RTK](https://github.com/rtk-ai/rtk) is a complementary CLI proxy that compresses Claude's tool outputs before they reach the context window — stripping line-number prefixes, collapsing repetitive diffs, and trimming redundant whitespace (60–90% token reduction on typical Read/Grep output).

Maestro and RTK target different surfaces:

| | Maestro | RTK |
|--|--|--|
| What it reduces | **output tokens** — routes each prompt to the cheapest model | **input tokens** — filters noise out of tool results |
| Where it runs | wraps `claude --print` at the routing layer | wraps the Claude CLI at the I/O layer |
| Config | `~/.maestro/config.json` | RTK config file |

When RTK is detected on `PATH`, Maestro automatically skips its own line-number stripping (I1) to avoid double-processing. No configuration required — the two tools compose transparently.

To use both, install RTK first (see its README), then point `claudeProcessWrapper` at Maestro. RTK runs as Claude's I/O layer; Maestro runs above it as the routing layer.

---

## Langfuse integration

Maestro can stream every routing decision, outcome, and correction event to Langfuse as traces — useful for debugging classifier behavior across a team or auditing cost attribution.

```bash
maestro telemetry langfuse \
  --public-key pk-lf-… \
  --secret-key sk-lf-… \
  [--host https://your-langfuse.example.com]   # omit to use cloud.langfuse.com
```

This writes the three keys to `~/.maestro/config.json`. From that point, every `maestro run` / `maestro shell` / VSCode panel turn emits traces. The Langfuse peer (`langfuse` npm package) is dynamically imported — if the package isn't installed, the integration silently no-ops. The `scripts/install.sh` installer prompts interactively.

To remove: `maestro telemetry langfuse --remove`.

---

## SQLite telemetry backend

On Node 22.5+, Maestro automatically maintains a SQLite database (`~/.maestro/maestro.db`) alongside the existing JSONL append log. The database is built on Node's built-in `node:sqlite` module — no new runtime dependency. On first open, existing JSONL events are migrated in.

The database enables indexed queries (by `ts`, `type`, `session_id`, `class`, `classifier`) so `maestro stats --since 30` and `maestro export-prompts` scan only the relevant rows instead of reading the full JSONL. On Node < 22.5, the backend falls back to JSONL-only — no configuration needed.

---

## Troubleshooting

**VSCode panel not routing.**
```bash
grep claudeProcessWrapper "$HOME/Library/Application Support/Code/User/settings.json"
```
If missing: `maestro install-vscode` then reload the window.

**`~/.maestro/config.json` silently ignored.** Maestro validates config with Zod on load. If a field has the wrong type or an invalid enum value (e.g. `"aggressiveness": "medium"` instead of `"conservative" | "balanced" | "aggressive"`), it throws a `ConfigValidationError` with a human-readable message listing every bad field. Run `maestro telemetry status` to force a config load and surface any errors.

**`pnpm install` fails with `ERR_PNPM_IGNORED_BUILDS`.** Pass `--ignore-scripts`. The install script handles this automatically.

**`pnpm build` fails with "Run pnpm embed first".** Run `MAESTRO_SKIP_EMBED_CHECK=1 pnpm build`. The install script sets this automatically.

---

## FAQ

**Q: I installed Maestro but my prompts are still hitting Opus. How do I verify routing is working?**

After running `bash scripts/install.sh`, reload VSCode (`Cmd+Shift+P` → "Developer: Reload Window"). Routing is only active when the panel extension uses Maestro as its wrapper. Verify with:
```bash
tail -1 ~/.maestro/decisions.jsonl | python3 -c "import json,sys; e=json.loads(sys.stdin.read()); print(e['decision']['class'], e.get('prompt','')[:60])"
```
If the file is empty, the `claudeCode.claudeProcessWrapper` setting was not applied — run the installer again and confirm VSCode reloaded.

---

**Q: My first prompt costs as much as before. Why isn't Maestro saving money?**

The first turn of any new session pays a cold-start cost of ~$0.035 due to Claude Code's 37k-token system prompt being written to cache. This is expected. Savings accumulate from the second turn onward when Maestro reuses the session (`--session-id` + `--resume`). Never open a new terminal window mid-task — Maestro reuses sessions by `cwd`, so staying in the same directory is the single biggest cost lever. Check `maestro stats` after a full work session to see real savings.

---

**Q: Maestro routed a complex task to Haiku and the answer was wrong. How do I fix this?**

Use an override prefix to force a higher model for that prompt:
- `@think <prompt>` → Opus with high effort
- `@deep <prompt>` → Opus max
- `@fast <prompt>` → Haiku (explicitly cheap)

For systematic misrouting of a prompt pattern, run `maestro tune` — it analyzes recent decisions and suggests heuristic rules to add to `heuristics.json` so the fix applies automatically going forward.

---

**Q: `pnpm install` fails with a build script error. How do I install?**

pnpm 11 blocks packages with unapproved build scripts (esbuild's `postinstall` is a common trigger). Run:
```bash
pnpm install --ignore-scripts
```
Vitest bundles its own runtime and works without esbuild's prebuilt binary, so `--ignore-scripts` is safe here. If `pnpm-workspace.yaml` `onlyBuiltDependencies` doesn't take effect, `.npmrc` also won't help — the `--ignore-scripts` flag is the only reliable workaround on pnpm 11.

---

**Q: `--max-budget-usd` terminated my prompt early but charged me 6× the cap. Is this a bug?**

No — the cap is a soft backstop, not a hard limit. The Claude CLI honors it at a coarse checkpoint, meaning the actual cost can overshoot by several multiples (observed up to 6.3×). Maestro accounts for this: profile budget caps are set ~50% above expected cost to avoid normal completions triggering it. If a prompt is regularly hitting the cap and truncating, the prompt class is too low — use `@think` or `@deep` to route it to a higher profile with a larger budget.

---

**Q: When should I use `maestro stats` vs `maestro bench` vs `maestro bench --tournament`?**

They answer different questions:

- **`maestro stats`** — use this daily/weekly to see how much money you've saved vs. the Opus-everywhere baseline and spot trends. It reads your local `~/.maestro/decisions.jsonl` instantly (no API calls, no cost). Add `--since 30` for a 30-day window. Start here every time you want a pulse check.

- **`maestro bench`** — use this after touching the classifier pipeline (heuristics, embeddings, or LLM stage). It runs the labeled eval set locally and reports accuracy. Required gate: no >2% regression vs. the locked baseline. Zero API cost because it excludes the LLM classifier by default.

- **`maestro bench --tournament --confirm-cost`** — use this when you want to empirically verify that a specific prompt class can safely be downgraded to a cheaper model without quality loss. It runs real Claude calls (costs $1–5 depending on sample size), so `--confirm-cost` is required as a deliberate gate. Run it before committing a profile change that lowers a model tier, or after `maestro tune --apply` to validate the new heuristics under real conditions. Not something you run daily — treat it like a load test: run it intentionally, not habitually.

---

**Q: When should I use `maestro tune` and what's the difference between its modes?**

`maestro tune` is how you teach Maestro to stop misrouting a prompt pattern you keep seeing. There are three workflows:

- **`maestro tune`** (no flags) — shows suggested regex rules inferred from your recent telemetry where the LLM classifier overrode the heuristic classifier. Run this when `maestro stats` reports a high LLM-fallback rate or you notice repeated misroutes. It doesn't change anything yet — review the suggestions first.

- **`maestro tune --apply`** — writes the approved rules to `~/.maestro/heuristics.json`. Run this only after reviewing the suggestions from the plain `tune` run and after `maestro bench` confirms no regression. These rules take effect immediately on the next prompt — no restart needed.

- **`maestro tune --learn`** — more aggressive: mines LLM-overrides from telemetry and folds patterns directly into heuristics. `maestro stats` will prompt you to run this when it detects coverage gaps. Follow that prompt rather than running it speculatively.

The rough workflow is: `stats` surfaces the gap → `tune` proposes the fix → `bench` validates it → `tune --apply` ships it.

---

## More reading

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — data flow, module layout, design decisions
- [docs/router-observations.md](docs/router-observations.md) — spike results and verified behaviors

## License

Apache 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
