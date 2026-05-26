# Spike: T3 — Thinking-block hesitation parsing

## TL;DR

The thinking-block hesitation signal is **not viable in the current architecture**. The
`sdk-proxy.ts` stdout handler only sees complete `assistant` frames
(`{ type: "assistant", message: { content: [...] } }`) after a turn finishes; it does
**not** receive a thinking block's text content in those frames as observed from the
proxy's vantage point. Even if thinking content were forwarded, the feature's value
proposition — escalating `set_max_thinking_tokens` mid-turn — is impossible because
escalation messages can only be injected on `stdin` before the assistant frame begins,
not while it is streaming. The earliest safe injection point is at the next
`tool_result` turn. A stripped-down version (pattern-match on turn completion for
next-turn escalation) is possible but the signal reliability is too low to justify the
complexity before a protocol observation is made in a live session.

---

## Frame shape

The Claude Code stream-json protocol delivers assistant output as a single complete
frame on stdout after the model finishes generating. Based on `extractToolUseBlocks`
in `src/wrapper/stream-json-frames.ts` (line 228) and the Anthropic extended-thinking
API documentation, a thinking-enabled assistant frame looks like:

```json
{
  "type": "assistant",
  "message": {
    "id": "msg_01XxxYyy",
    "type": "message",
    "role": "assistant",
    "content": [
      {
        "type": "thinking",
        "thinking": "<model's raw reasoning text, potentially thousands of tokens>"
      },
      {
        "type": "text",
        "text": "Here is the answer…"
      }
    ],
    "model": "claude-sonnet-4-5",
    "stop_reason": "end_turn",
    "usage": { "input_tokens": 1024, "output_tokens": 2048 }
  }
}
```

Key observations from the codebase:

1. `extractToolUseBlocks` iterates `frame.message.content` looking for
   `{ type: "tool_use" }` blocks (line 230–249). The loop structure is identical to
   what a thinking-block extractor would use — the pattern is confirmed.

2. There is **no existing thinking-block extractor** anywhere in
   `stream-json-frames.ts` or `output.ts`. The `output.ts` parser only touches the
   `type: "result"` envelope frame, never assistant frames. Neither file references
   `"thinking"` as a content-block type.

3. The critical question is whether the `thinking` field within a thinking block is
   actually populated in the stream-json protocol. The Anthropic Messages API populates
   it; however the Claude Code CLI may strip thinking-block content before forwarding
   the assistant frame to the SDK host. **This is unverified** — no protocol capture
   exists in `docs/router-observations.md` that shows a live `type: "thinking"` block
   with a non-empty `thinking` field in the SDK stream. This is the primary blocker.

---

## Hesitation signal design

Assuming thinking content is available, the following pattern set is proposed.

### Tier 1 — High-reliability markers (rare in normal reasoning)

These phrases appear in genuine epistemic uncertainty but rarely in decisive reasoning:

```ts
const HESITATION_HIGH = [
  /\bwait,?\s+(actually|no|hmm)\b/i,
  /\blet me reconsider\b/i,
  /\bthis is (more complex|harder) than\b/i,
  /\bI('m| am) (not sure|unsure|confused)\b/i,
  /\bI (need to|should) (re-?think|reconsider|step back)\b/i,
  /\bI (made|made a) mistake\b/i,
];
```

Any match → `hesitationScore += 2`.

### Tier 2 — Medium-reliability markers (common but contextual)

These appear in normal exploratory reasoning ~30–40% of the time:

```ts
const HESITATION_MEDIUM = [
  /\bactually\b/i,      // very common — needs combination with others
  /\bhmm\b/i,
  /\bwait\b/i,
  /\bbut wait\b/i,
  /\bon second thought\b/i,
  /\bI think I (was wrong|got this wrong)\b/i,
];
```

Any match → `hesitationScore += 1`.

### Tier 3 — Structural signals (model stuck in loop)

Detectable without semantic understanding:

**N-gram repetition.** Split thinking text into 5-grams; if any 5-gram appears ≥ 3
times the model is looping:

```ts
function hasNgramRepetition(text: string, n = 5, threshold = 3): boolean {
  const words = text.toLowerCase().split(/\s+/);
  const counts = new Map<string, number>();
  for (let i = 0; i <= words.length - n; i++) {
    const gram = words.slice(i, i + n).join(" ");
    const c = (counts.get(gram) ?? 0) + 1;
    counts.set(gram, c);
    if (c >= threshold) return true;
  }
  return false;
}
```

N-gram repetition → `hesitationScore += 3`.

**Length without decision.** Thinking block exceeds 2000 tokens with no synthesis
marker (`"therefore"`, `"so "`, `"conclusion"`, `"answer:"`, `"result:"`):

```ts
const SYNTHESIS_MARKERS = /\b(therefore|thus|so,|in conclusion|the answer|my answer)\b/i;
const hasDecision = SYNTHESIS_MARKERS.test(thinkingText);
const isOverlong = thinkingText.split(/\s+/).length > 2000;
if (isOverlong && !hasDecision) hesitationScore += 2;
```

### Escalation threshold

`hesitationScore >= 3` → flag as hesitating. Below 3, do nothing (noise floor).

### Calibration approach

Collect 100 real thinking-block texts from live sessions via a logging mode (opt-in
flag `userConfig.logThinkingBlocks`). Label hesitating vs non-hesitating manually.
Run the scorer against the corpus and tune the threshold to achieve:
- Precision ≥ 0.8 (< 20% false positives — a false positive wastes one token escalation)
- Recall ≥ 0.6 (catching most real hesitation is desirable but not critical)

---

## Implementation sketch

The earliest injection point for a "next-turn escalation" is when the proxy sees the
current turn's `assistant` frame on stdout and the next user/tool_result frame
on stdin has not yet arrived. This is possible because:

- stdout (assistant frame) arrives
- proxy extracts and scores thinking block
- stdin (tool_result) arrives next
- proxy injects elevated `set_max_thinking_tokens` before forwarding the tool_result

```ts
// In sdk-proxy.ts stdout handler, after extractToolUseBlocks(frame):

// T3: thinking-block hesitation detection.
// Fires only on assistant frames when thinking content is present.
if (frame.type === "assistant" && opts.userConfig.hesitationEscalation !== false) {
  const thinkingText = extractThinkingText(frame); // new function in stream-json-frames.ts
  if (thinkingText !== null) {
    const score = scoreHesitation(thinkingText);  // new function in hesitation.ts
    if (score >= HESITATION_THRESHOLD) {
      hesitationPending = true; // flag checked on next stdin turn
      opts.stderr.write(
        `maestro: hesitation detected (score=${score}); will escalate thinking tokens on next turn.\n`
      );
    }
  }
}
```

Then in the stdin handler (tool_result path, around line 320 in sdk-proxy.ts):

```ts
// T3: if hesitation was flagged on the previous assistant frame, override thinking tokens upward.
const thinkingCap = hesitationPending
  ? escalateThinkingTokens(effortToThinkingTokens(decision.spec.effort))
  : effortToThinkingTokens(decision.spec.effort);
if (hesitationPending) {
  hesitationPending = false;
  opts.stderr.write(`maestro: escalated set_max_thinking_tokens → ${thinkingCap}\n`);
}
injectedSeq += 1;
child.stdin?.write(JSON.stringify(buildSetThinkingTokensRequest(thinkingCap, injectedSeq)) + "\n");
```

Where `escalateThinkingTokens` doubles the cap (capped at `null`):

```ts
function escalateThinkingTokens(current: number | null): number | null {
  if (current === null) return null;
  const doubled = current * 2;
  return doubled >= 32000 ? null : doubled;
}
```

New functions needed:

- `extractThinkingText(frame: Frame): string | null` in `stream-json-frames.ts`
- `scoreHesitation(text: string): number` in `src/wrapper/hesitation.ts`

State added to `runSdkProxy`:
- `let hesitationPending = false` (reset after each tool_result turn)

---

## Risks and limitations

### 1. Thinking content may not be forwarded in the stream-json protocol

**This is the most critical unknown.** The Claude Code CLI may strip `thinking` field
content from assistant frames before forwarding them via `--input-format stream-json`.
In the Anthropic Messages API, thinking blocks have `type: "thinking"` with a
`thinking` field. In the stream-json SDK protocol used by Claude Code, the same block
may be reduced to `{ type: "thinking" }` with no content — or stripped entirely.

Evidence from the codebase: `output.ts` never references thinking-block content;
`stream-json-frames.ts` has no `thinking`-type handler. Neither file has a comment
suggesting this was considered and skipped. This is absence of evidence, not evidence
of absence — but it is a red flag.

**Required verification:** Capture a live stream-json session with `--effort high` and
print the raw stdout frames. If `{ type: "thinking", thinking: "..." }` appears with
non-empty content, the feature is viable. If it appears with an empty or absent
`thinking` field, the feature is dead on arrival.

### 2. False positives inflate token spend

Every false-positive hesitation detection escalates `set_max_thinking_tokens` on the
next turn, consuming more tokens than the model would have used otherwise. At
Tier-2-only thresholds, false positive rates will exceed 30% in normal coding sessions
because "actually" and "wait" are routine in exploratory reasoning. The scorer MUST be
calibrated before shipping (see calibration approach above). Without calibration, the
feature is net-negative in cost terms.

### 3. Escalation is asymmetric in cost

The cost of a false positive is one wasted escalation (~$0.003–$0.01 for extra thinking
tokens). The cost of a false negative is a failed or degraded response (potentially
requiring a retry at full cost). The scorer should be biased toward precision over
recall — do not escalate on weak signals.

### 4. Only tool_result continuations benefit

The proxy can only inject `set_max_thinking_tokens` at stdin turn boundaries. For
turns that end in `end_turn` (no tool call), the hesitation signal comes too late —
the turn is already complete. This means hesitation detection only helps in agentic
multi-tool sessions, not conversational sessions. Conversational sessions with
hesitation would need a different mechanism (e.g., a follow-up prompt), which is out
of scope.

### 5. Thinking token escalation vs model escalation

Doubling thinking tokens on a Haiku response may still be insufficient for a
genuinely hard problem. A model upgrade (Haiku → Sonnet, Sonnet → Opus) might be
more effective. This spike focuses on thinking-token escalation because it is lower
cost and preserves the model routing decision. If thinking-token escalation proves
insufficient in practice, model escalation should be considered as a fallback.

---

## Verdict

**Spike more before building.**

Condition: verify via a live protocol capture that `{ type: "thinking" }` blocks in
the stream-json stdout carry non-empty `thinking` field content when
`set_max_thinking_tokens > 8192`. Add the observation to
`docs/router-observations.md` under a "Spike T3a" heading.

If the content is present: build the minimal version — `extractThinkingText` +
`scoreHesitation` (Tier 1 markers + n-gram repetition only, no Tier 2) + the
`hesitationPending` flag in `sdk-proxy.ts`. Default OFF (`userConfig.hesitationEscalation`).
Run calibration before enabling by default.

If the content is absent or stripped: close as "protocol limitation." Log to
`docs/future-ideas.md` as "T3-deferred: thinking content not available in stream-json."

Estimated build cost if content is present: 4–6 hours. Two new files, one state
variable, one new `UserConfig` flag. No new runtime deps.
