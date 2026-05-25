# Thinking Token Reduction — Revised Plan v3

*2026-05-25 · replaces v2*

## Audit of v2 (blind spots)

Re-reading the code instead of the prior spec surfaces five issues:

**1. B1 is already shipped.** [src/wrapper/spawn.ts:65](src/wrapper/spawn.ts#L65) emits `--append-system-prompt "Be concise. Avoid preambles and trailing summaries — the user can read the diff."` on **every** turn, globally. v2's Track B1 treats this as new work. It is not — it has been live since the first wrapper module. Whatever savings the brevity hint provides are already in `maestro stats`. v3 retires B1 and replaces it with **class-specific brevity tuning** (more aggressive on trivial/simple, lighter on hard/reasoning where suppression risks omitting load-bearing steps).

**2. The 60–70% volume bucket is unhacked.** [src/core/profile.ts:53](src/core/profile.ts#L53) sets standard class to `tools: "default"` and *omits* `mcpConfig`. That means every standard turn carries the full Claude Code tool definitions in its system prompt (~5–8k tokens of tool schemas) plus whatever the user has in `.mcp.json`. Trivial and simple already restrict to `Read,Edit` with empty MCP — but standard is where the volume is. This is the single largest unhacked cache_creation vector.

**3. E2 (hard → Opus+medium) ignores the cache_read multiplier.** Opus input is ~5× Sonnet. On long-context sessions (5k+ cache_read tokens per turn), moving hard class from Sonnet+high to Opus+medium can *increase* per-turn cost despite reducing thinking tokens. v2's cost analysis treats one turn as the unit — but hard class sessions tend to be long. Need a context-length-aware fallback.

**4. D1's git HEAD invalidation has a hole.** Working-tree edits don't change HEAD. The "4h backstop TTL" is arbitrary and reintroduces the staleness problem D1 was designed to solve. Better: hash the `git diff` output as a secondary key. Cheap (~5ms), and changes the moment any file changes.

**5. No prompt compression at all.** v2 attacks output tokens (B1) and system prompt tokens (A1) but leaves the user's prompt itself untouched. A typical Claude Code prompt is 50–500 tokens of natural language with significant redundancy. Client-side compression of the user's prompt is a 20–40% input token win on long prompts, with measurable quality preservation possible via a quality-eval gate.

---

## Track E — --effort optimization (refined)

### E1 — Standard class: medium → low (with subagent exception)

Add an exception: when the prompt heuristic detects task-tool likelihood (phrases like "delegate", "use a subagent", "spawn", "run in parallel", or detection of multi-file scope where Task is likely), keep `effort=medium`. Without this exception, prompts that internally fan out via Task tool would lose the thinking budget the subagent dispatcher needs.

Detection rule (heuristic.ts addition): `/(?:delegate|subagent|spawn|in parallel|across (?:the |all )?files?)\b/i` → emit `heuristic.task_tool_likely` diagnostic. Pipeline: if class=standard AND diagnostic present, override effort=medium.

### E2 — Hard class: context-length-aware

Replace v2's static `opus + effort=medium` with a routing rule:

- If session's last-turn `cacheReadInputTokens < 20k` → `opus + effort=medium` (quality wins)
- If session's last-turn `cacheReadInputTokens ≥ 20k` → `sonnet + effort=medium` (avoid 5× Opus cache_read tax on long sessions; effort drops from high → medium for thinking savings, model stays Sonnet)

The crossover is the point where Opus's cache_read multiplier (~5×) erases the thinking-budget savings. 20k is the conservative break-even — refine with telemetry after Sprint 0 (C5 measures cache_read distribution per class).

### E3 — Reasoning class signal escalation (unchanged from v2)

### E4 — Max class xhigh escalation (unchanged from v2)

---

## Track F — Cache_creation aggressive attack (NEW)

### F1 — Tool whitelist on standard class

Current: `tools: "default"` (~15 tools in Claude Code default set).
Proposed: `tools: "Read,Write,Edit,Bash,Grep,Glob"` for standard class.

Removed tools (WebFetch, WebSearch, Task, NotebookEdit, TodoWrite, ExitPlanMode, EnterPlanMode, ListMcpResourcesTool, ReadMcpResourceTool) are rarely used in standard dev turns. Each tool definition is ~300–800 tokens of system prompt. Conservative estimate: ~3–4k tokens removed from system prompt → ~3–4k tokens off cache_creation per fresh session, ~3–4k tokens off cache_read on every session-resume turn.

**Risk:** standard turn occasionally needs Task or WebSearch. Mitigation: when override hint `@think` or `@deep` is used (signals deep work), use full tool set. When standard class lacks the override but heuristic detects `heuristic.task_tool_likely`, also use full tool set. Otherwise restrict.

**Gate:** bench --propose against locked baseline + add 10 eval cases that are standard-class but require Task/WebSearch — confirm pipeline upgrades them out of standard via the override or heuristic signals.

### F2 — MCP isolation on standard class

Current: `mcpConfig: undefined` for standard (so all user MCPs load).
Proposed: `mcpConfig: '{"mcpServers":{}}'` for standard class.

Most standard dev turns don't need MCP (file ops, tests, refactors). Users with heavy MCP setups (10+ servers) pay 10–30k tokens of MCP tool definitions per turn for tools that won't be invoked.

**Risk:** user expects MCP tool X to be available on a standard turn. Mitigation: heuristic patterns for known MCP invocations (e.g., `/atlassian|jira|confluence|figma|notion/i` → mark as needing MCP, override to full MCP). User can also use `@think` to force full MCP via class upgrade.

**Gate:** eval set of 10 prompts that genuinely need MCP — confirm they upgrade out of standard.

### F3 — Class-specific brevity hint (replaces v2's B1)

Current: one global `--append-system-prompt` for all classes.
Proposed: class-specific `appendSystemPrompt` field on ClassSpec, with class-tuned strings:

- trivial: `"Output only the answer. No explanation. No formatting."`
- simple: `"Be concise. Skip preamble."`
- standard: existing global hint (already shipped) — no change
- hard: `""` (empty — don't constrain thinking on hard problems)
- reasoning: `""` (empty)
- max: `""` (empty)

For trivial/simple, the more aggressive hint can save 30–60% of output tokens versus the current global hint. For hard/reasoning/max, removing the brevity hint may actually *improve* quality (the current global hint can suppress useful step-by-step reasoning on complex problems).

**Risk:** hard/reasoning verbosity creep. Mitigation: telemetry from Sprint 0 (C5) tracks output token p90 per class — alert if hard class outputs exceed pre-change baseline by >30%.

### F4 — Aggressive bare detection

Currently `--bare` is gated on `heuristic.bare_safe` which only fires for a narrow set of patterns. Expand `bare_safe` detection to:

- Prompts ≤ 50 chars with no question/file reference: bare safe
- Prompts matching `^(format|prettify|lint|run|exec) ` with single arg: bare safe
- Prompts that are pure echo/repeat ("what did you just say", "repeat that"): bare safe

The bare flag strips Claude Code's full system prompt — saves ~37k tokens of cache_creation. Pushing the bare-safe rate from current ~5% of trivial → ~25% of trivial class is a step-function win for cache_creation cost.

**Risk:** Claude bare mode lacks tool access. Mitigation: bare path is only chosen for trivial class which already restricts to Read/Edit anyway — these prompts rarely use tools.

### F5 — Ablation eval for `--exclude-dynamic-system-prompt-sections`

This flag is default-on globally [src/wrapper/spawn.ts:45](src/wrapper/spawn.ts#L45). It's assumed safe but never proven safe by eval. Run a 100-prompt ablation eval (50 with flag, 50 without) comparing answer correctness. If the flag causes quality regression on a measurable class, narrow it to specific classes (e.g., off for hard/reasoning).

**Why this matters:** if the flag is harming hard-class quality, every other token-saving change compounds the problem. This is a safety check, not a savings hack — but it must precede or accompany Sprint 0.

---

## Track G — Prompt compression (NEW)

### G1 — Client-side prompt rewriter for prompts > 300 chars

Pre-process the user's prompt before it reaches Claude. Apply rule-based compression:

- Remove politeness markers: "please", "could you", "can you", "I'd like to", "if possible"
- Collapse redundant context: "the file foo.ts which is in the src folder" → "src/foo.ts"
- Strip stop-words from imperative chains: "look at the file and then tell me what" → "in file, what"
- Preserve all technical content (code blocks, file paths, function names, error messages)
- Preserve all override hints (`@fast`, `@think`, `@deep`)

Implementation: pure regex pipeline in [src/wrapper/prompt-compress.ts](src/wrapper/prompt-compress.ts) (new module). No LLM. ~5ms latency. Runs after override stripping, before classifier pipeline.

**Quality gate:** establish eval set of 30 prompts with their compressed forms manually verified for meaning preservation. Run both forms through Claude — answers must score ≥95% semantic equivalence (or use bench --propose with the labeled set). If gate passes, ship. If not, narrow compression scope.

**Savings:** 20–40% input token reduction on prompts >300 chars. These prompts are ~30% of standard class volume.

### G2 — maxOutputTokens cap on hard/reasoning

Current: hard, reasoning, max have no `maxOutputTokens` cap (uncapped).
Proposed:

- hard: `maxOutputTokens: 4000`
- reasoning: `maxOutputTokens: 6000`
- max: `maxOutputTokens: 8000`

These caps don't constrain thinking tokens (those are internal). They cap the FINAL output. Most hard/reasoning responses fit in 4k tokens. Pathological cases (long file rewrites, lengthy architectural docs) will hit the cap and stop — those are usually cases where the response should have been split into multiple turns anyway.

**Risk:** legitimate long responses get truncated. Mitigation: the user can issue `@deep continue from where you stopped` to chain. The cap protects against runaway generation, doesn't break iterative workflow.

---

## Track H — Predictive session warmup (NEW)

### H1 — Background prewarming on tier prediction

After every turn, we know:
- The Markov prior (last 3-5 classes for this cwd)
- The user's working pattern

If Markov prior predicts the next turn likely needs a different model tier than the current session, spawn a background `claude --print --session-id <new> --resume` with a 1-token throwaway prompt. This establishes the cache for the predicted tier before the user types.

When the user's actual next prompt arrives, if the prediction was right, the session is warm — cache_read hits, no cache_creation tax.

**Cost:** the prewarming spawn pays cache_creation it would have paid anyway. Slight increase from "wasted" prewarming when prediction is wrong. Mitigation: only prewarm when Markov prior confidence > 0.7 (3+ consecutive same-tier turns).

**Savings:** moves the cache_creation cost from user-perceived latency to background. Doesn't reduce dollars, reduces TTFB. Real economic win: avoids the "user impatiently retries the same prompt because TTFB was slow" cost.

**Implementation:** [src/wrapper/session.ts](src/wrapper/session.ts) adds `prewarmIfPredictable(cwd)`. Called fire-and-forget from `run-cmd.ts` after the user's turn completes.

### H2 — Per-tier session pool

Currently sessions are keyed by `(cwd, modelTier)` after Task 1's model-affinity sessions. But pool size is implicitly 1 per tier — when you swap models, you swap sessions.

Proposed: explicit pool of warm sessions, ~3 entries per cwd (one per tier: Haiku, Sonnet, Opus). Keep all three resumable. The "current" session is whichever tier the last turn used.

**Why this matters:** without a pool, alternating standard ↔ hard ↔ standard creates session churn — each swap is a session resume + cache_read on a session that may have been idle. With a pool, the Sonnet session stays warm while you do Opus work, and vice versa.

**Risk:** more disk space for session metadata (~1MB extra per cwd). Negligible.

**Savings:** indirect — reduces cache_read tax on session resumption after long gaps. Most useful for users who do interleaved work.

---

## Track A — Context compression (refined)

A1: keep as v2 — already validated approach. Expand scope to standard class (was trivial/simple only).
A2: deprioritize as v2 — gated on telemetry data from C5.
A3: removed as v2 — explicit opt-in only.

---

## Track C — Telemetry (unchanged from v2)

C1–C5 stand. C5 is now load-bearing for E2's context-length cutover (need cache_read distribution data) and F-track validation.

---

## Track D — Output cache (corrected)

D1 invalidation key: `sha256(prompt + git_head_ref + git_diff_hash)`. The `git_diff_hash` is `sha256(execSync('git diff'))` — cached for 60 seconds to avoid re-running on every cache lookup.

This eliminates the 4h TTL backstop entirely. Working-tree edits invalidate immediately. The 60-second cache on the diff-hash itself is fine — that's the maximum staleness window, and a 60-second-stale cache hit is acceptable for development workflows.

---

## Revised sprint order

**Sprint 0 (this week) — observability + safety + biggest wins:**
- F5: Ablation eval for `--exclude-dynamic-system-prompt-sections` (safety check — must pass before any other change ships)
- C1–C5: Telemetry instrumentation
- F1: Tool whitelist on standard class (largest unhacked vector)
- F2: MCP isolation on standard class
- E1: Standard class effort=low (with subagent exception)

**Sprint 1 (next week) — structural wins, quality-safe:**
- F3: Class-specific brevity hint
- F4: Aggressive bare detection
- G2: maxOutputTokens cap on hard/reasoning
- E2: Hard class context-length-aware routing
- E3: Reasoning class effort escalation (signal-gated)
- A1: Closed-form system prompt rewriting (expanded to standard class)

**Sprint 2 (after Sprint 0+1 telemetry validates):**
- G1: Client-side prompt compression (quality eval gate)
- E4: Max class xhigh escalation
- H1: Background session prewarming
- D1: Output cache with git-aware invalidation

**Sprint 3 (conditional):**
- A2: Context peeling (only if C5 shows >20% redundant input tokens on standard class)
- H2: Per-tier session pool
- B2: Schema output (user opt-in)

**Removed:**
- B1: Already shipped, retired from this plan
- A3: Explicit opt-in only

---

## Expected savings table (revised)

| Track | Change | Reduction | Confidence |
|-------|--------|-----------|------------|
| F1 | Tool whitelist on standard | ~3–4k tokens / turn on cache_creation+cache_read | High |
| F2 | MCP isolation on standard | 5–30k tokens / turn (depends on user MCP count) | High |
| F3 | Class-specific brevity | 30–60% output tokens on trivial/simple | High |
| F4 | Aggressive bare detection | 37k tokens off cache_creation when triggered, 5× more triggers | High |
| F5 | Ablation eval | Safety check, not savings | N/A |
| E1 | Standard effort=low | 60–80% thinking tokens on standard | High |
| E2 | Hard context-aware | Quality + small cost win on long sessions | Medium |
| E3 | Reasoning signal escalation | 30–50% thinking on reasoning | Medium |
| E4 | Max xhigh escalation | Quality (no cost change) | Medium |
| G1 | Prompt compression | 20–40% input tokens on prompts >300 chars | Medium (gate-dependent) |
| G2 | Output cap on hard/reasoning | 10–20% output tokens on pathological cases | High |
| A1 | System prompt trim | 30–60% cache_creation on trivial/simple/standard | High |
| H1 | Background prewarming | Latency win, not cost | Medium |
| D1 | Response cache (corrected) | 100% on cache hits | Medium (hit rate TBD) |

**Stacked Sprint 0 savings projection** (compounding):
- F1 + F2 + E1 + A1 on a standard-class turn: cache_creation drops from ~37k → ~22k tokens, output drops from ~3k → ~1.2k tokens, thinking drops from ~6k → ~600 tokens.
- Per-turn cost (Sonnet pricing): roughly **$0.018 → $0.006**, a 67% reduction.
- Across 200 turns/day × 65% standard class = 130 standard turns × $0.012 savings = **$1.56/day = ~$47/month** from Sprint 0 alone.

**Stacked Sprint 1 savings** (on top of Sprint 0):
- F3 + F4 + E2 + A1 expanded: additional ~30% on trivial/simple (small bucket), ~10% on hard class.
- Additional ~$15–20/month.

**Stacked Sprint 2 savings** (on top of Sprint 0+1):
- G1 + D1: additional 15–25% on standard class (~$15–25/month).

**Total projected monthly savings for an active developer: $77–92/month.**

---

## Hack ranking by ROI

1. **F1 + F2 (tool/MCP isolation on standard)** — one-line profile changes, immediate ~25% cache_creation reduction on the volume bucket. Ship Sprint 0 day 1.
2. **F4 (aggressive bare detection)** — expanding bare-safe rules takes hours, saves 37k cache_creation per trigger, can 5× the trigger rate.
3. **E1 (standard effort=low)** — already in v2, the established big win.
4. **F3 (class-specific brevity)** — surgical replacement of v2's misidentified B1.
5. **G1 (prompt compression)** — biggest unhacked vector but requires quality eval, so Sprint 2.

The lesson from this audit: the Maestro code already does more than the v1/v2 plans assumed. The remaining wins are in (a) extending existing mechanisms to the standard class where the volume is, and (b) attacking cache_creation directly via tool/MCP isolation rather than via system prompt trimming.
