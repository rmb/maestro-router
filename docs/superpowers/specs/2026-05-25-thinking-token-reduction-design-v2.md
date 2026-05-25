# Thinking Token Reduction — Revised Plan v2

*2026-05-25 · replaces 2026-05-25-thinking-token-reduction-design.md*

## What changed from v1

Track E (--effort selection) is new and is Sprint 0. It has higher ROI than any Track A or B item, zero quality risk, and ships as a one-line profile.ts change. Track A2 and A3 are deprioritized or removed. Track B is quality-gated. Track C is kept as mandatory Sprint 0 observability. Track D gets a correct cache invalidation model replacing the flawed TTL approach.

---

## Track E — --effort Selection Optimization (NEW)

The `--effort` flag is the direct control lever for thinking token volume. It is orthogonal to model selection. The two are currently conflated in `profile.ts`, producing waste.

### E1 — Standard class: medium → low

Current: `sonnet + effort=medium`
Proposed: `sonnet + effort=low`

Standard tasks are well-specified single-developer tasks: refactor a function, explain a pattern, write a test, fix a known bug. They do not require extended thinking. Extended thinking is useful when the problem has multiple branching solution paths that must be evaluated simultaneously — standard class prompts have one. The 4,000–8,000 thinking tokens currently spent on standard class are narration, not cognition.

**Savings:** 60–80% thinking token reduction on the highest-volume class (~60–70% of all routed prompts are standard or simple).

**Gate:** `bench --propose` against locked baseline must stay ≥98.68%. Add 5 eval cases that are standard class with quality-sensitive output (code reviews, summaries) to confirm no regression.

### E2 — Hard class: Sonnet+high → Opus+medium

Current: `sonnet + effort=high`
Proposed: `opus + effort=medium`

Sonnet at effort=high spends large thinking budget trying to reason at a depth it cannot structurally reach. Opus at effort=medium reaches a higher-quality result with less wasted thinking, because Opus's world model is richer — it does not need to compensate with extended thinking for knowledge it already has.

Cost shift is neutral: Sonnet thinking at effort=high ~15,000 tokens × $3/M = $0.045. Opus at effort=medium ~5,000 thinking tokens × $15/M = $0.075. Small base cost increase, large quality improvement. This is the right trade for the hard class definition.

**Implementation:** `profile.ts` hard class spec change. Session store already handles model-tier affinity per cwd, so session continuity is preserved through the tier upgrade.

### E3 — Reasoning class: Opus+high → Opus+medium default with signal escalation

Current: `opus + effort=high` always
Proposed: `opus + effort=medium` default; escalate to `effort=high` when:

1. Pipeline Shannon entropy H > 0.9 bits on the current routing decision (extreme classifier disagreement — the prompt is at the edge of the class boundary)
2. Three consecutive reasoning/max decisions in Markov prior (complexity cluster — the session is in a sustained hard-reasoning mode)
3. Last session turn for this cwd had `stopReason = "max_tokens"` within the past hour (prior turn hit the thinking budget ceiling)

Most "reasoning" class prompts are architectural discussions, design reviews, and system-level planning — they succeed at effort=medium. The effort=high budget is wasted on what becomes long structured output, not genuine branching search.

**Savings:** 30–50% thinking token reduction on reasoning class.

### E4 — Max class: add effort=xhigh escalation path

Current: `opus + effort=high` hardcoded
Proposed: `opus + effort=high` default; escalate to `effort=xhigh` when `stopReason = "max_tokens"` was observed in the prior turn within 1 hour.

When a prior max-class turn was truncated, the next turn is almost certainly a continuation of an unsolved problem. Give it the ceiling.

**Implementation:** `session.ts` stores `lastStopReason` per session. `run-cmd.ts` reads it when building the effort override for max class decisions.

---

## Track C — Telemetry (Sprint 0, parallel with E)

Keep C1–C4 exactly as designed in v1. These are prerequisite observability. No Track A or B item ships before C1–C4 are live, because the savings claimed by A and B cannot be validated without per-class thinking token measurements.

### C5 — Thinking fraction proxy per class (new)

Claude's JSON output does not separate thinking tokens from output tokens — they are combined in `outputTokens`. Estimate thinking fraction as:

```
thinking_fraction = (outputTokens - median_prose_tokens_for_class) / outputTokens
```

The median_prose baseline is computed from the first 10 sessions after shipping C5 (when effort=low is the floor, thinking is minimal and outputTokens approximate prose). Surface this in `maestro stats` as "est. thinking %" per class, updated rolling from telemetry.

This is the feedback signal that tells you whether E1–E4 are actually working.

---

## Track A — Context Compression (revised)

### A1 — Closed-form system prompt rewriting

**Keep, Sprint 1.** Compile-time table of known passthrough-safe prefixes to strip from the system prompt for trivial/simple class. Zero behavioral risk, 30–60% cache_creation reduction. No parser dependency.

### A2 — Context peeling (AST-based)

**Deprioritize to Sprint 3.** Gate: telemetry must show >20% of standard class input tokens are redundant file context (visible from cacheCreationInputTokens distribution after C1–C5 ship). If the gate is not met by Sprint 3, drop A2 entirely — it requires an AST parser dependency that adds maintenance surface for savings that may not exist at scale.

### A3 — Ephemeral sessions

**Remove from default pipeline.** Reclassify as explicit opt-in via `maestrorc: ephemeralSessionsForTrivial: true`.

Reason: session continuity is a user-visible contract. When Claude Code says "what did you just write?" and the prior trivial turn was ephemeral, the answer is gone. Silent session discontinuity breaks the conversational model in a way users experience as random amnesia. The cache_creation savings on trivial turns are real but the UX failure rate is too high to make this a default.

---

## Track B — Persona Injection (quality-gated)

### B1 — Cognitive mode injection (revised scope)

Instead of overriding the persona, inject a single suffix on standard class prompts:

> "Answer concisely. Omit reasoning narration. Show conclusions, not steps, unless steps are the deliverable."

This preserves analytical quality while reducing output token volume (which includes thinking narration and verbose explainers).

**Quality gate before shipping:** Establish a prose-quality eval set of 20 standard-class prompts with ground-truth expected quality (rated for correctness, completeness, and conciseness). Run against Sonnet+low with and without the B1 suffix. If quality is statistically equivalent (within 5 percentage points on correctness), ship. If not, narrow the injection to specific output types (summaries, documentation) where conciseness is unambiguous.

### B2 — Schema output forcing

**Default off, opt-in only** via `maestrorc: schemaOutputForced: true`. Structured output breaks the conversational prose UX of Claude Code. Do not ship as a default.

### B3 — File pre-injection

**Keep, Sprint 2.** Inject file content before the turn when the prompt references a specific file, so Claude spends less first-byte time re-reading context. No behavioral change, purely input optimization.

Detection heuristic: `[A-Za-z_/]+\.[a-z]{1,5}` present in prompt and file exists in cwd.

---

## Track D — Response Output Cache (revised invalidation)

### D1 — Content-addressable cache

Keep the design; fix the invalidation key.

**Problem with TTL:** A prompt cached at T=0 is served until T+24h regardless of filesystem state. If the user edits a file that was part of the context, the cached answer is stale. A cache hit on a stale answer is worse than a miss — it silently returns an incorrect result.

**Correct invalidation key:** `sha256(prompt + git_head_ref_of_cwd)`. If the git HEAD ref changed, all cache entries for that cwd are invalidated. This is cheap (one `git rev-parse HEAD` per lookup, ~3ms), reliable, and aligns with the natural invalidation boundary of development work: commits.

**Backstop TTL:** 4 hours for un-committed edits. Working tree changes that have not been committed do not change HEAD, so the git-HEAD key would not invalidate them. A 4-hour window on a stale cache hit is acceptable for most development patterns and prevents indefinite staleness in long-running branches.

---

## Revised --effort mapping

| Class | v1 | v2 | Rationale |
|-------|----|----|-----------|
| trivial | Haiku + low | Haiku + low | Optimal, no change |
| simple | Sonnet + low | Sonnet + low | Already minimal thinking |
| standard | Sonnet + medium | **Sonnet + low** | No extended thinking needed; 60–80% thinking reduction |
| hard | Sonnet + high | **Opus + medium** | Model quality dominates; Sonnet+high hits capability ceiling |
| reasoning | Opus + high | **Opus + medium** (escalate to high on signal) | Reserve high for provably complex sessions |
| max | Opus + high | Opus + high (escalate to **xhigh** on max_tokens signal) | Ceiling only when prior turn was truncated |

---

## Sprint order

**Sprint 0 (this week) — observability + effort tuning:**
- E1: Standard class effort=low (profile.ts, one line)
- C1–C5: Telemetry instrumentation

**Sprint 1 (next week) — quality-safe structural wins:**
- E2: Hard class → Opus+medium
- E3: Reasoning class effort escalation (session-signal-gated)
- A1: Closed-form system prompt rewriting
- B3: File pre-injection

**Sprint 2 (after Sprint 0+1 telemetry validates savings):**
- E4: Max class xhigh escalation path
- B1: Cognitive mode injection (quality eval prerequisite must pass first)
- D1: Output cache with git HEAD invalidation

**Sprint 3 (conditional on observability data):**
- A2: Context peeling (only if C1–C5 shows >20% redundant input tokens on standard class)
- B2: Schema output (user opt-in, ship when someone asks)

**Removed from default pipeline:**
- A3: Ephemeral sessions

---

## Expected savings

| Change | Expected reduction | Confidence |
|--------|-------------------|------------|
| E1: standard effort=low | 60–80% thinking tokens on highest-volume class | High |
| E2: hard → Opus+medium | ~40% thinking tokens on hard class; quality gain | Medium |
| E3: reasoning effort downgrade | 30–50% thinking tokens on reasoning class | Medium |
| A1: system prompt trim | 30–60% cache_creation on trivial/simple | High |
| B1: narration suppression | 20–40% output tokens on standard | Low (needs eval gate) |
| D1: response cache | 100% saving on cache-hit turns | Medium (hit rate TBD) |

**E1 alone** — shifting the highest-volume class from effort=medium to effort=low — reduces thinking tokens by 60–80% for ~65% of all prompts. On a session with 20 standard-class turns at current Sonnet output pricing ($3/M):

- Before: 20 turns × 6,000 thinking tokens = 120,000 tokens = **$0.36**
- After: 20 turns × 200 thinking tokens = 4,000 tokens = **$0.012**

Track C is prerequisite, not a savings track. The telemetry data from Sprint 0 will confirm or revise these projections before Sprint 2 behavior changes ship.
