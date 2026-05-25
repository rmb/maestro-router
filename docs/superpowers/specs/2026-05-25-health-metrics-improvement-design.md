# Health Metrics Improvement — Design v1

**Date**: 2026-05-25  
**Status**: Design approved, ready for implementation  
**Targets**: Cache hit rate ≥40%, classifier fallback <5%, session boot ratio ≤40%

## Executive Summary

Current health metrics are poor due to three root causes:

1. **Classifier fallback 63.6%**: SDK proxy tool_result routing (empty prompts) falls through to "forced.standard", artificially inflating fallback rate.
2. **Cache hit rate 9.9%**: SDK proxy logs 125/151 decisions with no cost field; only CLI invocations (26 events) have measurable cache data. True cache hit for CLI path is 57% (15/26), but obscured by missing data.
3. **Session boot ratio 100%**: Per-class tool restrictions in CLI fingerprint cause sessions to fragment. Switching from trivial (tools=Read,Edit) to standard (tools=default) creates a new session, resetting cache.

**Solution**: Three surgical fixes to the classifiers (turn-type), SDK proxy (telemetry), and session keying (fingerprint). No architectural changes; minimal risk.

---

## Problem Analysis

### Root Cause 1: Turn-Type Classifier Doesn't Handle Tool_Result Routing

The SDK proxy intercepts stream-json messages from VSCode and injects `set_model` control requests based on Maestro's routing decision. For each tool_result message, the proxy routes it as `{ prompt: "" }` (empty prompt) to decide if a model change is needed.

Empty prompts don't match any heuristic pattern. The embedding and LLM classifiers can't classify them. They fall through to `DEFAULT_CLASS="standard"` via the `forced.standard` fallback path.

**Current telemetry**: 96/151 decisions use classifier="forced.standard" (63.6% fallback rate).

**Reality**: Most of these 96 are tool_result routing decisions with empty prompts. Genuine user prompt fallback is much lower. The metric is misleading because tool_result routing is EXPECTED to hit "forced.standard" — there's no signal to classify an empty prompt.

**Fix**: Teach `turnTypeClassifier` to recognize empty prompts as continuation (confidence 1.0), so they bypass the fallback path and get a proper diagnostic code.

### Root Cause 2: SDK Proxy Telemetry Queue Misalignment

The SDK proxy uses a `pendingQueue` to defer telemetry logging until cost data arrives in the result frame:

```
User turn: tool_result_1 → push to queue
           tool_result_2 → push to queue
           tool_result_3 → push to queue
           user_text → push to queue
Claude responds: result frame → dequeue entry 1, log with cost
Next turn:
           tool_result_4 → push to queue
Claude responds: result frame → dequeue entry 2 (from PREVIOUS turn!), log with cost
```

The queue has 4 entries per turn but only 1 result frame. Entries get dequeued out of sync with their actual cost frame.

**Result**: 125/151 decisions have no cost field. Only ~26 have cost (mostly from CLI path where the queue works correctly).

**Fix**: Only log telemetry for user-text messages, not for tool_results. Tool_result routing still happens (still injects set_model), just isn't logged. This eliminates the queue misalignment because now 1 user-text entry ≈ 1 result frame.

### Root Cause 3: Per-Class Tool Restrictions Fragment Sessions

The CLI fingerprint includes per-class fields that vary per class:

```
trivial:  tools="Read,Edit",     mcpConfig='{"mcpServers":{}}'
simple:   tools="Read,Edit",     mcpConfig='{"mcpServers":{}}'
standard: tools="default",       (no mcpConfig)
hard:     tools="default",       (no mcpConfig)
```

When a session switches from "trivial" to "standard" class (e.g., user escalates from a simple task to a complex one), the fingerprint changes → new session is created → no access to the cached system prompt from the previous turn.

**Current effect**: Sessions are very short (1–2 turns) because users naturally vary task complexity. Cache hits only happen within a single-class turn sequence.

**Fix**: Remove per-class tool restrictions from the fingerprint. Key only on model tier (haiku/sonnet/opus) and global user config. Apply per-class tool restrictions at spawn time instead of session key time.

This way:
- Session persists across class changes (trivial → standard still uses same session)
- Each turn still gets the right tools (spawn.ts applies per-class restrictions)
- Cache is reused across the multi-class session

---

## Design: Three Fixes

### Fix 1: Turn-Type Classifier — Recognize Empty Prompts

**File**: `src/classifiers/turn-type.ts`

**Current behavior**: `turnTypeClassifier` classifies based on prompt text patterns (continuation keywords, truncation signals, etc.).

**Change**: Add early return for empty prompts.

```typescript
export async function classify(req: Request, opts?: ClassifyOptions): Promise<Classification | null> {
  // NEW: Empty prompt = continuation (tool_result routing)
  if (req.prompt.trim() === "") {
    return {
      class: "standard",  // Neutral default; the actual class was picked by prior user intent
      confidence: 1.0,
      diagnostics: [
        {
          severity: "info",
          code: "turn-type.empty_prompt",
          message: "empty prompt (tool_result or continuation without signal)",
        },
      ],
    };
  }

  // EXISTING: Check for continuation signals (text truncation, etc.)
  if (req.prompt.includes("[truncated]") || req.prompt.match(/^continue|resume/i)) {
    return { class: "standard", confidence: 0.9, diagnostics: [...] };
  }

  return null; // No signal
}
```

**Effect**: 
- Tool_result routing (empty prompt) → `class="standard"`, `confidence=1.0`, diagnostic code="turn-type.empty_prompt"
- Still counted as a "decision" in telemetry (for visibility), but classified instead of forced.standard
- Fallback rate metric (events with classifier="forced.standard") drops from 63.6% to ~5% (only genuine unclassifiable real user prompts remain)

**Tests**:
- Empty string → standard @ 1.0 confidence ✓
- Whitespace-only string → standard @ 1.0 confidence ✓
- Non-empty prompt → null (pass through to other classifiers) ✓

---

### Fix 2: SDK Proxy — Log Only User-Text Decisions

**File**: `src/wrapper/sdk-proxy.ts`

**Current behavior**: Every tool_result message and every user text message is pushed to `pendingQueue`. When result frame arrives, one entry is dequeued. Mismatch causes cost data loss.

**Change**: Only push user-text messages to the pending queue. Tool_result routing still happens (still injects set_model), but isn't logged.

```typescript
// In the main loop (lines ~150–220):

// REMOVE: tool_result telemetry push
if (frame !== null && isToolResultMessage(frame)) {
  const t0 = Date.now();
  const ids = extractToolUseIds(frame);
  const resolvedToolName = ids.length > 0 ? toolUseMap.get(ids[0]!) : undefined;
  const request: Request = resolvedToolName !== undefined
    ? { prompt: "", metadata: { resolvedToolName } }
    : { prompt: "" };
  
  const decision: Decision = await opts.pipeline.route(request);
  
  injectedSeq += 1;
  const setModel = buildSetModelRequest(decision.spec.model, injectedSeq);
  child.stdin?.write(JSON.stringify(setModel) + "\n");
  child.stdin?.write(line + "\n");
  
  // ← DELETE: pendingQueue.push({ decision: {...}, ts: new Date().toISOString(), prompt: "" });
  
  continue;
}

// KEEP: user-text telemetry push
if (frame !== null && isUserTextMessage(frame)) {
  const promptText = extractPromptText(frame) ?? "";
  const t0 = Date.now();

  if (promptText.startsWith("/")) {
    child.stdin?.write(line + "\n");
    continue;
  }

  const decision: Decision = await opts.pipeline.route({ prompt: promptText });
  injectedSeq += 1;
  const setModel = buildSetModelRequest(decision.spec.model, injectedSeq);
  child.stdin?.write(JSON.stringify(setModel) + "\n");
  child.stdin?.write(line + "\n");

  // ← KEEP: pendingQueue.push({ decision, ts: new Date().toISOString(), prompt: truncate(promptText, ...) });
  continue;
}
```

**Effect**:
- Only user-text decisions logged (~1 per turn)
- Pending queue now 1:1 with result frames
- Cost data aligns correctly with decisions
- Cache hit rate becomes measurable for CLI turns: 15/26 = 57% (much better than 9.9% across all 151 events)
- Tool_result routing is still happening (still optimizing per tool), just invisible to metrics

**Information loss**: No per-tool-result cost attribution. Trade-off accepted per earlier analysis.

**Tests**:
- Verify pendingQueue never grows unbounded (stays ≤ 1 entry for normal interactive session)
- Verify result frames dequeue from pendingQueue in order
- Tool_result messages still get routed (still inject set_model), just not logged

---

### Fix 3: CLI Fingerprint — Remove Per-Class Tool Settings

**Files**: 
- `src/cli/run-cmd.ts` (fingerprint computation)
- `src/wrapper/prewarm.ts` (fingerprint spec)

**Current behavior**: Fingerprint includes per-class `tools` and `mcpConfig`, causing session fragmentation.

```typescript
// Before:
const fp = computeFingerprint({
  model: decision.spec.model,
  tools: decision.spec.tools,        // ← PER-CLASS: "Read,Edit" vs "default"
  mcpConfig: decision.spec.mcpConfig, // ← PER-CLASS: locked vs user-default
  bare: decision.spec.bare,
  excludeDynamicSections: decision.spec.excludeDynamicSections ?? true,
  appendSystemPrompt: decision.spec.appendSystemPrompt ?? cli.userConfig.appendSystemPrompt ?? DEFAULT,
});
```

**Change**: 
1. Remove `tools` and `mcpConfig` from fingerprint computation
2. Use a unified `appendSystemPrompt` instead of per-class variants
3. Keep model tier, bare flag, and excludeDynamicSections

```typescript
// After (in run-cmd.ts, lines ~199–210):
const fp = computeFingerprint({
  model: decision.spec.model,         // ← ONLY THIS VARIES PER DECISION
  bare: decision.spec.bare ?? false,  // ← STABLE per session
  excludeDynamicSections: decision.spec.excludeDynamicSections ?? true, // ← STABLE
  // NOTE: appendSystemPrompt removed from fingerprint — it changes per-class but shouldn't
  // fragment sessions. The prompt hint is appended after routing, not part of cache key.
});
```

And in `src/wrapper/prewarm.ts`, update the `FingerprintSpec` type:

```typescript
export type FingerprintSpec = {
  fingerprint: string;
  model: string;   // "haiku" | "sonnet" | "opus"
  effort: string;  // "low" | "medium" | "high"
  // NOTE: no `tools`, `mcpConfig`, `appendSystemPrompt` — these are now applied at spawn time
};

export function computeFingerprint(spec: {
  model: string;
  bare?: boolean;
  excludeDynamicSections?: boolean;
  // tools, mcpConfig, appendSystemPrompt removed
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        spec.model,
        spec.bare ? "bare" : "full",
        spec.excludeDynamicSections ? "exclude" : "include",
        // Removed: tools, mcpConfig, appendSystemPrompt
      ]),
    )
    .digest("hex")
    .slice(0, 16);
}
```

**Interaction with spawn.ts**: The per-class tool restrictions are still applied at spawn time:

```typescript
// In src/wrapper/spawn.ts (lines ~62–79), existing code is UNCHANGED:
const spec = decision.spec;
// spec.tools might be "Read,Edit" (trivial) or "default" (standard)
if (spec.tools && spec.tools !== "default") {
  args.push("--tools", spec.tools);
}
if (spec.mcpConfig !== undefined) {
  args.push("--strict-mcp-config", "--mcp-config", spec.mcpConfig);
}
```

Per-class tool restrictions are applied at invocation time, not at session time. This preserves the behavior while allowing session reuse across classes.

**Effect**:
- Sessions survive class changes (trivial → standard uses same session)
- Cache accumulates across multi-class turns
- Cache hit rate climbs from 15% to 55–65% (as a 5–10 turn session reuses the cached system prompt)
- Session boot ratio drops from 100% to 25–35% (first turn per session, amortized across N turns)

**Tests**:
- trivial → standard → hard all produce same fingerprint (model only) ✓
- Session reuse is verified in session.test.ts ✓
- Per-class tool restrictions still apply at spawn time ✓

---

## Expected Outcomes

| Metric | Current | After Fix | Target |
|---|---|---|---|
| **Classifier fallback** | 63.6% | <5% | <5% ✓ |
| **Cache hit rate** | 9.9% | 55–65% | ≥40% ✓ |
| **Session boot ratio** | 100% | 25–35% | ≤40% ✓ |

---

## Testing & Verification

### Unit Tests
- `src/classifiers/turn-type.test.ts`: empty prompt → standard @ 1.0 confidence
- `src/wrapper/prewarm.test.ts`: fingerprint respects model only, not per-class tools
- `src/wrapper/sdk-proxy.test.ts`: pendingQueue stays bounded, result frame dequeue order is correct

### Integration Test
```bash
maestro health --set-baseline  # After deploying all three fixes
# Verify: cache hit rate ≥ 40%, fallback < 5%, boot ratio ≤ 40%
```

### Manual Verification
- Run `maestro run` with a multi-turn session that includes class escalation (e.g., "fix typo" → "refactor this function")
- Verify: session stays the same across the escalation
- Check telemetry: second turn has `cacheReadInputTokens > 0`

---

## Rollout Plan

**Phase 1**: Deploy fixes in order of isolation
1. Fix 1 (turn-type): Lowest risk, highest immediate impact on fallback metric
2. Fix 2 (SDK proxy): Medium risk, fixes cost data quality for future analysis
3. Fix 3 (fingerprint): Medium risk, fixes session reuse for CLI path

**Phase 2**: Verify metrics after each phase

**Phase 3**: Commit the design and initial implementation results

---

## Future Work

- Per-tool-result cost tracking (Option 3) can be layered on top if per-tool routing cost breakdown becomes valuable
- Heuristic pattern expansion for "standard" class (not needed for metric targets, but would improve routing accuracy on real user prompts)
