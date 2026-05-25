# Thinking Token Reduction — Plan v4

*2026-05-25 · replaces v3 · grounded in production telemetry from `maestro stats`*

## Production telemetry reveals v3 is misprioritized

```
requests       140
spent          $3.589
saved          $3.389 (48.6%)
cache hit      2.9%               ← anomaly
session boot   $3.586             ← 99.9% of total spend
fallback rate  67.9%              ← classifier broken
standard p90 output  11,624 tok   ← brevity hint failing
```

Three numbers rewrite the plan:

1. **Cache hit rate 2.9%.** Maestro's model-affinity sessions (Task 1) were supposed to push this to 70–80%. Production says it didn't.
2. **Session boot is 99.9% of spend.** Every dollar Maestro spends is `cache_creation_input_tokens`, not output, not thinking, not reasoning. v3's optimizations attack output (B/F3) and thinking (E) tokens — the wrong target.
3. **Classifier fallback rate 67.9%.** The pipeline is hitting the markov/default fallback path 2/3 of the time. The heuristic + embedding + LLM stack is not converging. Whatever v3 builds on top of "smart classification" is built on sand.

If we fix only cache locality — push hit rate from 2.9% to 90% — the math:

- Current: 140 turns × ~$0.0256 cache_creation = $3.59
- Fixed: 14 first-turns × $0.0256 + 126 cache_reads × ~$0.0026 = $0.69
- **Savings: 81%** from one change

Every other v3 hack stacks on top of this, but they're rounding error until cache locality is fixed. **v4's headline is: make cache work.**

---

## Root cause hypothesis: spec-driven cache invalidation

The model-affinity work keys sessions by `(cwd, modelTier)`. That fixes cache busting when class jumps between model tiers. But within a tier, the system prompt content can still vary, which Anthropic's prompt cache treats as a different prefix — cache miss.

Spec flags that affect the cached prefix:

- `--tools` whitelist (different value → different tool definitions in system prompt)
- `--mcp-config` (different MCPs → different tool definitions)
- `--bare` (strips system prompt entirely → totally different prefix)
- `--exclude-dynamic-system-prompt-sections` (toggles dynamic sections)
- `--append-system-prompt` (suffix change → cache invalidated from append point)

Maestro varies several of these per class:

| Class | tools | mcp | bare | append-system-prompt |
|-------|-------|-----|------|---------------------|
| trivial | Read,Edit | empty | conditional | global default |
| simple | Read,Edit | empty | no | global default |
| standard | default | (full) | no | global default |
| hard | default | (full) | no | global default |
| reasoning | default | (full) | no | global default |
| max | default | (full) | no | global default |

So a user session going `trivial → simple → standard → hard → standard` undergoes at least three full cache invalidations (trivial↔simple are similar but bare may toggle; simple↔standard tools differ; standard↔hard same tools but session might differ for other reasons). Each invalidation is a fresh `cache_creation_input_tokens` charge.

**This is a perverse outcome of v3's F1/F2 (tool/MCP isolation on standard) — it would *worsen* cache locality, not improve it.** Restricting tools per class causes more cache invalidations across class transitions than the per-turn savings recover.

v4 inverts this priority.

---

## Track Z — System-prompt-fingerprint sessions (NEW, highest priority)

Replace `(cwd, modelTier)` session keying with `(cwd, systemPromptFingerprint)`.

```ts
const fingerprint = sha256([
  spec.model,
  spec.tools ?? "default",
  spec.mcpConfig ?? "user-default",
  spec.bare ? "bare" : "full",
  spec.excludeDynamicSections ? "exclude" : "include",
  spec.appendSystemPrompt ?? userConfig.appendSystemPrompt,
].join("\0"));
```

When routing decision lands on `(cwd, fingerprint)`:
- If a session exists with that fingerprint → `--resume` (cache hits)
- If no session → `--session-id <new>` (cache miss is unavoidable on first turn)

**Implication:** users routinely have 3–5 concurrent sessions per cwd, one per fingerprint. Disk cost: ~5 × 100kB = 0.5MB per cwd. Negligible.

**Implication for class definitions:** to maximize cache hits, fingerprint variation should be MINIMAL across classes. The v3 instinct to restrict tools/MCP per class is the wrong instinct — it shatters the fingerprint space. v4 keeps tool/MCP stable within a model tier:

| Class | tools | mcp | Fingerprint group |
|-------|-------|-----|------|
| trivial | default | user-default | Haiku-A |
| simple | default | user-default | Haiku-A or Sonnet-A |
| standard | default | user-default | Sonnet-A |
| hard | default | user-default | Sonnet-A or Opus-A |
| reasoning | default | user-default | Opus-A |
| max | default | user-default | Opus-A |

This collapses fingerprint count from ~6 to ~3. Cache hits across class changes within a tier (simple↔standard on Sonnet, hard↔reasoning between Sonnet and Opus).

**Trade-off:** loses the system-prompt-trimming savings from F1/F2 in v3. But the cache_creation savings dominate by ~20× — F1/F2's 25% per-turn savings on a $0.018 turn = $0.0045; cache locality fixing turns a $0.0256 cache_creation into a $0.0026 cache_read = $0.023 saved. Cache locality wins 5×.

---

## Track Y — Classifier fallback rate investigation (NEW, blocking)

67.9% fallback rate means the pipeline is broken in production. Before any optimization ships:

1. **Add per-stage telemetry to `maestro stats`** — show breakdown: how often does override fire, turn-type, heuristic, embedding, LLM, markov-prior, default?
2. **Lower the LLM stage confidence threshold to fire more aggressively.** If heuristic+embedding aren't converging at 0.55, fall through to LLM more eagerly.
3. **Audit the markov-prior path** — is it returning class=null instead of a class when recent history is sparse?
4. **Check the embedding classifier** — is the ONNX model loading correctly in VSCode subprocess context?

This is debugging, not new design. Sprint 0 blocking item.

---

## Track X — Standard output cap (NEW, data-driven)

Telemetry: standard class p90 output = **11,624 tokens**. The current global `--append-system-prompt "Be concise..."` is not constraining standard output. The cap exists for trivial (200) and simple (500); standard is uncapped.

Proposed: `maxOutputTokens: 4000` on standard. p90 currently 11.6k → after cap, p90 ≤ 4k. Cuts output tokens by ~60% on the worst 10% of standard turns.

**Risk:** legitimate long responses get truncated. Mitigation: cap to 4k, allow user to `@deep continue` on truncation. The cap is a soft ceiling — Claude stops cleanly at the limit, doesn't error.

**Combined with Track Z:** since fingerprint stays stable, adding `maxOutputTokens` to spec doesn't shatter fingerprints (the cap flag doesn't appear in the cached system prompt; it's a generation parameter).

---

## Track I — Tool result interception (NEW Claude Code internals hack)

The Read tool returns file contents with `cat -n` line numbers prefixed. For a 500-line file:
- Useful content: ~10k tokens
- Line number overhead: ~3k tokens (6 chars × 500 lines)
- Overhead ratio: ~30%

These line numbers enter Claude's context and stay there. On a long session with many file reads, the line-number overhead compounds.

**Hack:** the SDK proxy ([src/wrapper/sdk-proxy.ts](src/wrapper/sdk-proxy.ts)) already intercepts stream-json events. When a `tool_result` event for the Read tool flows through, rewrite the result to strip line numbers BEFORE it enters Claude's context.

**Strategy:**
- Keep line numbers on the FIRST 50 and LAST 50 lines (Claude often uses these for navigation)
- Strip line numbers on the middle (replace `   42→` with empty, save ~5 chars per line)
- For files <100 lines, leave intact

**Savings:** ~20–30% on Read tool result token cost. Compounds with session length (Read results stay in context).

**Risk:** Claude uses line numbers for the Edit tool's `old_string` matching. Stripping line numbers from history doesn't break this — Edit tool reads the file fresh each time it edits. But Claude's reasoning ("I see on line 47 that...") becomes less precise.

Mitigation: leave a tiny line-anchor every 25 lines (`   25→`, `   50→`, `   75→`). Cuts overhead 80% while preserving navigation.

**Only applicable to wire-compat / stream-json path** (where Maestro can intercept). Direct `maestro run` doesn't have this capability.

---

## Track J — Session file rewriting (NEW Claude Code internals hack)

Claude stores sessions in `~/.claude/projects/<encoded-cwd>/*.jsonl`. Each line is a conversation event. `--resume <id>` loads the file.

On long sessions (20+ turns), old tool results bloat the file. Tool results from turn 1 are still in the file at turn 50, costing input tokens on every subsequent --resume.

**Hack:** Maestro intercepts --resume. Before forwarding to Claude:
1. Read the session JSONL
2. Identify "stale" tool results: turn N where N < currentTurn - 10, AND the result wasn't referenced in any subsequent turn's user message
3. Replace stale results with a stub: `{"type":"tool_result","content":"<elided — re-Read if needed>","metadata":{"original_size":1234}}`
4. Write a temporary session file with the rewritten history
5. `--resume <temp-id>` instead of original

**Savings:** on a 30-turn session with avg 8k tokens per tool result, elision of 20 old results = 160k tokens off the input. At Sonnet cache_read pricing ($0.30/M tokens), that's $0.048 saved per turn after rewrite.

**Risk:** Claude expects exact history. Aggressive elision could break references ("Earlier you read foo.ts and we found..."). Conservative elision (only results >5 turns old AND >5k tokens AND not referenced) is safer.

**Implementation:** [src/wrapper/session-pruner.ts](src/wrapper/session-pruner.ts) (new module). Heuristic for "referenced" = exact string match between tool result content and any subsequent user message.

**This is the highest-ceiling hack in v4** but also the riskiest. Default off, opt-in for Sprint 2.

---

## Track K — Classifier acceleration (NEW)

### K1 — Classifier output cache

Cache LLM classifier outputs by `sha256(prompt)`. Same prompt → same class.

In developer workflows, identical prompts repeat (running tests, asking same question, retrying after error). LRU cache, 24h TTL, 1000 entries.

**Savings:** ~$0.001 × hit rate (probably 20–40% on a heavy session). Small but free.

### K2 — Markov-prior pipeline short-circuit

When last 3 classes agree at high confidence: skip pipeline entirely, route directly to that class.

Currently markov-prior is a fallback (low confidence 0.35). Proposed: when 3 consecutive same-class hits exist, treat as high confidence and short-circuit before LLM stage.

**Risk:** classifier never re-evaluates. If session shifts complexity (was standard, now hard), the markov lock keeps it at standard. Mitigation: detect class-bump signals (longer prompt, error keywords) that break the lock.

---

## Track L — CLAUDE.md auto-compression (NEW Claude Code internals hack)

User has global CLAUDE.md (~60 lines, ~600 tokens) + project CLAUDE.md (~150 lines, ~1500 tokens) + memory/ auto-imports. All load on every turn. With cache, this is ~2.1k tokens of cache_creation on session boot.

**Hack:** auto-rewrite CLAUDE.md into a token-dense form. Apply rules:
- Tables → bullet lists (smaller)
- Decorative formatting (`---`, `===`) → removed
- Polite phrasing → imperative
- Examples that aren't load-bearing → removed
- Repeated concepts → factored

**Implementation:** `maestro tune --compress-md` command. Runs Haiku once on each CLAUDE.md, produces compressed version, writes to `CLAUDE.compressed.md`. User reviews and renames. Original kept as `CLAUDE.original.md`.

**Savings:** 30–50% on CLAUDE.md size = ~700 tokens off cache_creation. Modest but free after one-time setup.

**Risk:** semantic loss. Mitigation: rule-based compression first; LLM compression only with user review.

---

## Track M — Continuation detection (NEW)

When user types "continue", "keep going", "and?", "yes go on": this is a continuation prompt. Claude's natural behavior is to recap context before continuing ("As I was saying about...").

**Hack:** detect continuation prompts via heuristic. Inject `--append-system-prompt "User is asking you to continue. Resume from where you stopped. No recap. No restating the question."`.

**Savings:** 50–70% thinking and output tokens on continuation turns. These are ~10–15% of turns in long sessions.

**Risk:** Claude might skip needed context-grounding. Low risk for true continuation prompts (user explicitly asked for continuation).

---

## Refined sprint order

**Sprint 0 (this week) — fix the foundation:**

1. **Y: Investigate classifier fallback rate** (debugging — blocking)
2. **Z: System-prompt-fingerprint sessions** (the cache-locality hack)
3. **X: Standard output cap at 4000 tokens** (data-driven)
4. **C1–C5 telemetry** (already in v3, still required)

**Sprint 1 (validate Sprint 0 with new telemetry):**

5. E1 standard effort=low (with subagent exception)
6. E3 reasoning class signal escalation
7. M1 continuation detection
8. K1 classifier output cache
9. K2 markov-prior short-circuit (if Track Y revealed the cause)

**Sprint 2 (deeper hacks once foundation is healthy):**

10. I1 tool result line-number stripping (in SDK proxy only)
11. J1 session file rewriting (opt-in)
12. L1 CLAUDE.md auto-compression (one-time)
13. D1 git-aware response cache

**Demoted from v3 (rationale: would worsen cache locality):**

- F1 tool whitelist per class — **demote** (causes fingerprint fragmentation)
- F2 MCP isolation per class — **demote** (same reason)
- F3 class-specific brevity hint — **demote** (changes append-system-prompt per class, fragments fingerprint)

These can be revisited if Track Z proves the fingerprint sessions handle the fragmentation without cache loss. For now they're net-negative.

**Retained from v3:**

- E1, E2, E3, E4 (effort optimizations — don't affect fingerprint)
- A1 expanded scope (system prompt trim affects fingerprint, must be applied uniformly)
- G2 maxOutputTokens caps (don't affect fingerprint)
- F4 aggressive bare detection (creates separate fingerprint, but conditional on rare patterns)
- D1 corrected response cache

---

## Hacks evaluated: quality vs token reduction vs risk

| Hack | Token Reduction | Quality Risk | Implementation | Confidence | Recommendation |
|------|----------------|--------------|----------------|------------|----------------|
| **Z** fingerprint sessions | 70–80% on cache_creation | None | Medium (rewire session store) | High | **Ship Sprint 0** |
| **Y** fallback rate fix | Enables everything else | None (debugging) | Medium | High | **Ship Sprint 0** |
| **X** standard output cap | 60% on top decile | Low (truncation rare on standard) | Trivial (one-line) | High | **Ship Sprint 0** |
| **E1** standard effort=low | 60–80% thinking on standard | Low (eval gate) | Trivial | High | Ship Sprint 1 |
| **E2** context-aware hard | Quality fix | Low | Small | Medium | Ship Sprint 1 |
| **E3** reasoning escalation | 30–50% reasoning thinking | Low | Small | Medium | Ship Sprint 1 |
| **E4** max xhigh escalation | Quality on truncated | None | Small | Medium | Ship Sprint 2 |
| **M1** continuation detect | 50–70% on triggered turns | Low | Small | Medium | Ship Sprint 1 |
| **K1** classifier cache | $0.001 × hit rate | None | Trivial | High | Ship Sprint 1 |
| **K2** markov short-circuit | 50ms + $0.001 / hit | Low (class lock risk) | Small | Medium | Ship Sprint 1 |
| **I1** Read line-number strip | 20–30% per Read result | Medium (line-anchoring) | Medium (stream-json proxy) | Medium | Test then ship Sprint 2 |
| **J1** session file rewriting | 30–60% on long sessions | High (history tampering) | Large | Low | Opt-in only, Sprint 2 |
| **L1** CLAUDE.md compression | 30–50% on CLAUDE.md | Low (review-gated) | Small | High | Ship Sprint 2 (one-time) |
| **A1** system prompt trim (uniform) | 30–60% cache_creation on trivial | Low | Small | High | Ship Sprint 2 |
| **D1** response cache | 100% on hits | Low (correct invalidation) | Medium | Medium | Ship Sprint 2 |
| **G2** output cap hard/reasoning | 10–20% on pathological | Low | Trivial | High | Ship Sprint 1 |
| **F4** aggressive bare detect | 37k × increased trigger rate | Low | Small | Medium | Ship Sprint 1 |
| **F1** tool whitelist per class | -5% (cache fragmentation) | Low | Done already | High | **Demoted** |
| **F2** MCP isolation per class | -10% (cache fragmentation) | Low | Done already | High | **Demoted** |
| **F3** class-specific brevity | -3% (cache fragmentation) | Low | Done already | High | **Demoted** |
| **B1** cognitive mode | Already shipped globally | Low | n/a | n/a | **Retired** |
| **A3** ephemeral sessions | Variable | Very high (UX break) | Small | Low | **Removed from defaults** |

---

## Quality + Risk Evaluation (the closing analysis)

### What goes right

The dominant cost is cache_creation. Track Z attacks it directly with no quality risk — the fingerprint session work is purely an indexing change. Claude sees the same system prompt content; it just gets `--resume`d instead of fresh. Quality is preserved exactly because the model and context are unchanged.

Track Y is debugging — fixing a broken classifier produces only upside. The current 67.9% fallback rate means classifier signals are being ignored 2/3 of the time, so the routing decisions are mostly "use the default." Fixing this gives Maestro the levers it was designed to have.

Track X (output cap) is data-driven. p90 of 11.6k tokens on standard class is well above what standard tasks need (eval set targets are usually 1–3k). Capping at 4k cuts the long tail; legitimate long responses are rare on standard class.

Tracks E1–E4, K1, K2, M1, G2, F4 are low-risk refinements stacking on top of the foundation. Each is small, well-scoped, and reversible.

### What requires caution

Track J1 (session file rewriting) is the highest ceiling and the highest risk. Tampering with Claude's session files violates an implicit contract. Symptoms of failure could include:
- Claude hallucinating prior context that was elided
- Edit tool failing because the file content from prior reads is stubbed
- Hard-to-debug "Claude seems to forget things" complaints

Mitigation: opt-in, conservative elision rules (only stale results >5 turns old, >5k tokens, no references), and a `MAESTRO_SESSION_PRUNE=off` env var as escape hatch.

Track I1 (line-number stripping in tool results) has a more subtle risk. Claude's internal reasoning becomes less anchored — "line 47" references in subsequent Edit calls might miss. Anchoring every 25 lines preserves most utility while keeping 80% of the savings.

Track L1 (CLAUDE.md compression) only ships with user-in-the-loop review. The LLM compression step is deterministic enough but can quietly drop semantic nuance. Original kept; user can revert.

### Risk-aware deferred items

The v3 hacks that this audit demoted (F1, F2, F3) are not "bad" — they're suboptimally sequenced. If Track Z stabilizes cache locality such that fingerprint fragmentation is acceptable, F1/F2/F3 can resurface in a v5. The bet here is that cache locality is worth 5× more than tool/MCP trimming, so don't fragment the fingerprint space until the per-fragment savings are validated.

### Final risk-vs-benefit verdict

For Sprint 0 (Y + Z + X): **ship aggressively.** All three are low-risk and high-impact. Expected effect on telemetry:
- Cache hit rate: 2.9% → 60–80% (Z)
- Classifier fallback rate: 67.9% → <10% (Y)
- Standard p90 output: 11.6k → ~4k (X)
- Total spend: $3.59 → ~$0.80 (78% reduction)

For Sprint 1: incremental, well-tested. Adds another 10–20% on top of Sprint 0.

For Sprint 2 (J1 especially): treat as experimental. Run with `--dry-run` mode that logs what would be elided without actually modifying session files. Ship to defaults only after a week of dry-run telemetry shows no anomalies.

The big lesson from running v3 against production telemetry: **plan against measured cost distributions, not theoretical token reductions.** v3's analysis assumed cache was working at >50% hit rate; production says it's 2.9%. Every "save 10% on output tokens" optimization is multiplied by the cache hit rate to determine real impact, and a 2.9% cache hit rate makes them all noise.

Fix the foundation first.

---

## Sprint 0 Improvements

### Z.bootstrap — Eager fingerprint prewarming on VSCode activation

v4's Track Z has a bootstrap hole: when a fingerprint is first seen, cache_creation is unavoidable. For a fresh project, ALL fingerprints are fresh — first standard turn pays cache_creation, first hard turn pays cache_creation, etc. The session-affinity payoff only starts on second turn per fingerprint.

**Improvement:** at VSCode extension activation (or first Maestro invocation in a cwd), background-spawn a 1-token throwaway `claude --print` for the two most likely fingerprints: (Sonnet, default-tools) and (Opus, default-tools). Cache_creation runs at idle time, not during the user's first interaction. By the time the user types, cache is warm.

**Cost:** ~$0.05 prewarming spend per cwd-activation, paid at moment of zero user attention. Saves $0.05 on the user's first real turn (which would have been cache_creation anyway). Net cost: ~$0.

**Latency win:** user's first turn TTFB drops from ~5s (cache_creation overhead) to ~1s (cache_read). This is the user-visible value.

**Implementation:** [src/wrapper/prewarm.ts](src/wrapper/prewarm.ts) (new module). Triggered from wire-compat startup when shape is "process-wrapper" and cwd has no recent prewarm marker. Gated by `prewarmEnabled: true` in userConfig (default on).

### Z.handoff — Cross-fingerprint context summary

v4's Track Z creates discontinuity when fingerprint changes mid-conversation. User does 5 standard turns on Sonnet, then asks a hard question routing to Opus — new fingerprint, new session, no context.

**Improvement:** when the routing decision crosses fingerprints (especially upward to higher capability), inject a one-paragraph context summary as the first message of the new session. Maestro generates the summary via a cheap Haiku call from the prior session's last 3 user prompts and decisions.

**Format of injected handoff:**
```
[Context handoff from prior session]
Recent conversation in this cwd: <user worked on X, asked about Y, encountered Z error>.
Current focus: <one-line summary>
```

**Cost:** ~$0.001 per fingerprint switch (Haiku summarization). Maybe 5 switches per heavy session = $0.005/day.

**Benefit:** preserves UX continuity ("Claude remembers what we were discussing") despite fingerprint-driven session changes. Avoids the "why doesn't Claude know about that file we just discussed?" failure mode.

### Y.guarantee — Hard fallback elimination

v4's Track Y says "investigate" but that's open-ended. The 67.9% fallback rate could take weeks to root-cause.

**Improvement:** add a guaranteed-progress strategy. If, after all classifiers run, the pipeline still has no decision: don't fall back to "default" — fall back to **STANDARD class explicitly** with classifier=`forced.standard`. Standard is the median; misroute risk is symmetric (might be too cheap, might be too expensive, but bounded).

This guarantees `fallback rate = 0%` mechanically. Then debugging Y becomes a perf optimization (push the classifier success rate up) instead of a correctness blocker.

**Risk:** standard is sometimes wrong. But this is no worse than the current state where "fallback to default" probably resolves to standard-ish anyway. It just makes the decision explicit.

### X.soft — Replace hard cap with soft-cap-via-prompt

v4's Track X caps standard at 4000 tokens via `--max-output-tokens`. p90 is 11.6k, so ~10% of turns get truncated mid-output.

**Improvement:** dual-layer cap. Soft cap (via append-system-prompt): `"Aim for responses ≤ 4000 tokens. If longer needed, summarize and offer to expand."` Hard cap (via --max-output-tokens): 8000.

Result: median Claude self-limits around 4k. The 10% of legitimately long responses degrade gracefully (summary + "want me to expand?") instead of being truncated mid-sentence. Hard cap at 8k prevents pathological generation but rarely triggers.

**Trade-off:** soft cap costs a few words of system prompt. Negligible.

### Sprint 0 kill-switch

Add `MAESTRO_DISABLE_TRACK_Z=1` env var that disables fingerprint sessions (falls back to v3 model-affinity). Symmetric env vars for X and Y. Documented in `--help` and CLAUDE.md.

This is one line per track, ships with the feature. If anyone reports issues, instant rollback without redeploy.

---

## Sprint 1 Risk Reduction

### E1.shadow — Shadow A/B before flipping standard to effort=low

v4's E1 changes the default for the highest-volume class. If quality regresses on edge cases, we won't know until the user complains.

**Improvement:** ship E1 in shadow mode for one week before flipping. On every standard-class turn, run effort=low as the primary, AND fire a background classifier comparison call at effort=medium (no Claude spawn — just the would-be decision metadata) so we capture the counterfactual.

Better: actually spawn medium on 5% of turns (sampled), compare outcomes:
- stop_reason distribution
- output token p90
- tool call count
- session resume rate (proxy for "did user need to retry")

After one week, if effort=low shows ≥98% parity on these metrics, flip permanently. If not, revert and add a heuristic to detect the regressing prompt type.

**Cost:** 5% extra calls × ~$0.012 standard cost = ~$0.0006/turn extra. ~$0.08/week on a heavy session. Cheap insurance.

### E1.escalate — Self-correcting effort on truncation

If a standard turn produces `stop_reason="max_tokens"` at effort=low, that turn was probably under-routed. Two mitigations:

1. **Immediate:** auto-retry the same turn at effort=medium on a fresh background session, replace the user-facing response. Cost: ~$0.02 extra per regression. Frequency: probably <1% of standard turns.

2. **Persistent:** add a session-scoped "escalation marker." Next standard turn in this session routes at effort=medium until the session ends. Eliminates compounding errors within a session.

This makes E1 self-healing — wrong routes get corrected within one turn.

### M1.conservative — Stricter continuation trigger

v4's M1 detects "continue", "keep going", "and?", "yes go on" → injects "no recap" hint.

**Risk:** false positives. User says "continue with the auth refactor" as a fresh instruction. The "no recap" hint causes Claude to skip needed context grounding.

**Improvement:** require TWO signals before triggering:

1. Linguistic: `^(continue|keep going|go on|and\?|yes|more|next)\b` (≤30 chars)
2. Session state: prior turn had `stop_reason="max_tokens"` OR prior turn output ended in code-block-open or sentence-fragment (heuristic)

Both required. Reduces false-positive rate to near-zero. False negatives (legitimate continuations that don't trigger) just behave like normal turns — no harm.

### K2.escape — Markov lock-in safety valves

v4's K2 short-circuits when last 3 classes agree. Risk: classifier never re-evaluates; session locked into one class even when prompts shift.

**Improvement:** mandatory escape conditions that break the lock:

- Prompt length > 2× session prompt-length mean (signals scope shift)
- Prompt contains escalation keywords: `bug|race|deadlock|crash|fails|broken|error|prod` (signals hard escalation)
- Override hint present (`@fast`, `@think`, `@deep`)
- Prior turn's stop_reason was `max_tokens` (signals prior under-routing)

If any escape fires, run the full pipeline instead of using the markov shortcut. Combine pipeline result with the markov prior using existing vote logic.

### K1.invalidate — Self-correcting classifier cache

v4's K1 caches classifier outputs by prompt hash. Risk: if a cached classification was wrong (led to under-routing → max_tokens), it keeps being wrong.

**Improvement:** on every turn, write `(promptHash, decidedClass, stopReason, outputTokens)` to a sidecar log. When a cached classification's prior outcome shows `stop_reason="max_tokens"`, invalidate that cache entry on next lookup. Self-correcting.

Effort: small — already write outcome events to telemetry.jsonl in v3.

### E3.AND — Tighten reasoning escalation to require two signals

v4's E3 has three escalation signals OR'd. Risk: false escalations when only one signal fires noisily.

**Improvement:** require TWO of three signals (AND-of-2). This makes escalation conservative — only escalates when the session is clearly in hard-reasoning mode. Reduces over-spend on borderline cases.

Counter-risk: under-escalates when only one strong signal fires. Mitigation: any single signal at strength >0.9 still escalates (treated as two-of-three).

### Sprint 1 verification gate

After each Sprint 1 hack ships, watch telemetry for 48 hours. Add a `maestro health` command that compares pre/post:

- avg cost per class
- fallback rate
- output p90 per class
- stop_reason="max_tokens" rate
- cache hit rate

If any metric regresses >10% from pre-Sprint-1 baseline, automatic alert (stderr warning on next maestro invocation) recommending rollback. Manual decision to revert via env var.

---

## Summary of refinements

**Sprint 0 hardening:**
- Z.bootstrap — prewarm fingerprints at activation (closes the bootstrap gap)
- Z.handoff — context summary on fingerprint switch (closes the UX discontinuity)
- Y.guarantee — fallback always picks standard (closes the indefinite-investigation hole)
- X.soft — soft-cap-by-prompt + hard-cap-by-flag (replaces hard truncation with graceful degradation)
- Sprint 0 kill-switch via env vars

**Sprint 1 de-risking:**
- E1.shadow — 5% sampled medium-effort comparison for one week before flip
- E1.escalate — self-correcting on max_tokens stop
- M1.conservative — two-signal AND trigger
- K2.escape — explicit mandatory unlocks
- K1.invalidate — self-correcting cache on max_tokens outcome
- E3.AND — two-of-three signals (with strong-single override)
- Sprint 1 verification gate via `maestro health`

The pattern across both: **build in self-correction loops**. Every hack has a known failure mode; ship the hack with the detection-and-recovery for that mode. Avoid "ship and pray" rollouts on a production tool.
