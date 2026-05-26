# Spike: T4 — Kill-and-replay (mid-completion model escalation)

## TL;DR

Viable in a constrained form, but only for the `run-cmd` path (not `sdk-proxy`). The highest-risk unknown is whether `--resume` picks up from a clean checkpoint when the previous child was killed mid-completion or whether it produces a corrupt/partial assistant turn in the session log. A safer and immediately buildable alternative — post-completion max_tokens escalation via auto-resume — covers ~80% of the value without the session-corruption risk.

---

## Session resume mechanics

### What the code does

`buildClaudeArgs` in `src/wrapper/spawn.ts` emits either `--session-id <uuid>` (new session) or `--resume <uuid>` (continuing session). The distinction is already tracked per-turn in `run-cmd.ts`: `isResume: !session.isNew`.

The session store (`src/wrapper/session.ts`) persists `sessionId`, `cwd`, `systemPromptFingerprint`, and a rolling `recentClasses` window, but it does NOT record turn-level checkpoints. There is no Maestro-level concept of "last clean turn". The store only records what Maestro decided; it has no knowledge of what Claude's internal session log contains.

### What `--resume` guarantees (and doesn't)

From spike 1 in `docs/router-observations.md`: `--resume <uuid>` on a new child process correctly restores a session's full conversation history, and a model swap (Haiku → Sonnet) within the same `--resume` chain preserves context. That spike covered the clean case: the first child had a normal `end_turn` stop reason before the second child was spawned.

The unverified case — the one T4 needs — is: what does `--resume` produce when the previous child was killed (SIGTERM) mid-completion, i.e., before a result frame was emitted? Claude Code's session log is presumably written by the CLI process itself. If the CLI writes turns atomically (append the assistant frame only after `stop_reason` is known), then a mid-stream kill leaves no partial turn in the log and `--resume` on a new child picks up from the last complete user message — which is exactly what T4 wants.

If instead the CLI writes tokens to the session log as they stream (optimistic partial write), a mid-stream kill could leave a partial/corrupt assistant turn that `--resume` would replay. This behavior has not been directly observed and is the highest-risk unknown in this spike.

**Finding from code inspection:** The `--output-format json` result envelope is emitted as a single trailing JSON blob after all streaming output. The streaming output itself is plain text or NDJSON. This is consistent with the CLI doing a single atomic commit at completion time, which would make mid-stream kill safe. However this is inference from output format, not from direct observation of the session log file format.

---

## Struggle signal design

For mid-stream kill to be worth the risk, the struggle signals must be detectable before the user sees a bad answer. The following signals are evaluable at different cost/reliability tradeoffs, ordered cheapest-first.

### Signal 1: `max_tokens` stop reason (post-completion)

**Where it fires:** After the child exits, `parseOutput` in `src/wrapper/output.ts` reads `stop_reason` from the JSON envelope. `run-cmd.ts` already persists this via `sessions.updateStopReason(session.sessionId, parsed.cost.stopReason)`.

**Cost:** Zero. Already implemented as E1.escalate.

**Limitation:** This is not mid-stream — the completion is already done and the user has seen the truncated output. Kill-and-replay doesn't apply here; what's needed is a re-issue of the same prompt on a stronger model. This is the "simpler alternative" discussed below.

### Signal 2: Long silence (>N seconds without output chunks)

**Where it could hook in:** `stream.ts` uses a `data` event handler on `child.stdout`. A watchdog timer, reset on each `data` event, that fires after 3–5 seconds of silence could signal a stall.

**Reliability:** Low. Silent pauses during complex reasoning are normal on Opus max-effort. A 3s threshold would produce false positives on legitimate hard tasks. A 10-15s threshold narrows the window but introduces significant latency before escalation fires.

**Cost to implement:** Low — a `setTimeout`/`clearTimeout` pair around the `data` handler in `stream.ts`. However, `stream.ts` is a simple pipe-and-capture function. Embedding struggle detection there would violate its single-responsibility design. A better hook point is a thin wrapper layer around `streamClaude`.

### Signal 3: Repetitive output (n-gram sliding window)

**Where it could hook in:** The `capturedStdout` buffer in `stream.ts` already accumulates the full output. A rolling 4-gram dedup check over the last 200 chars, run every N chunks, could detect looping output.

**Reliability:** Moderate. Claude models rarely produce byte-for-byte repetition in normal output but can loop on constrained prompts with very low token budgets.

**Cost to implement:** ~30 lines of buffer management. No external deps.

**False positive risk:** Code output (repeated variable names, XML/JSON) can trigger n-gram overlap without being a loop. Threshold calibration required.

### Signal 4: Output token budget nearly exhausted (streaming)

**Where it could hook in:** The streaming JSON frames emitted by `--output-format json` during generation (if any). Based on code inspection of `output.ts` and `stream-json-frames.ts`, the current streaming path (used by `sdk-proxy`) carries `result`-type frames with usage fields, but these appear at the end of each turn, not incrementally during token generation. The `run-cmd` path uses plain stdout streaming with a single JSON envelope at the end.

**Availability:** In `sdk-proxy` mode, the `result` frame that contains `output_tokens` arrives after the full turn completes. In `run-cmd` mode (`--print --output-format json`), the JSON is a terminal blob. There is no observed mid-stream token counter in the current Claude CLI output format.

**Conclusion:** This signal is not currently available for mid-stream detection without additional instrumentation from Anthropic's CLI. It can only be read post-completion.

### Signal prioritization summary

| Signal | Timing | Cost | False positive risk | Status |
|--------|--------|------|-------------------|--------|
| max_tokens stop reason | Post-completion | Zero | Low | Already in E1 |
| Long silence >10s | Mid-stream | Low | Medium-high | Buildable |
| Repetitive n-gram output | Mid-stream | Low | Medium | Buildable |
| Output token budget exhausted | Post-completion only | Zero | Low | Not available mid-stream |

---

## Safe kill window

This is the most important constraint for T4. Killing at the wrong moment risks session corruption.

### In `run-cmd` mode (one child per turn)

The Claude CLI process in `--print` mode is a single-turn process. There is no multi-round tool use from Maestro's perspective — Maestro writes a prompt to stdin, reads until the child exits, and parses the result. The "assistant frame" and "tool use round" concepts don't apply here. There is only one phase: the model generating a response.

**Safe kill window:** At any point while the child is running, before the terminal JSON envelope is emitted. Once the JSON envelope starts (recognizable by `{"type":"result"`) the child is about to exit anyway and killing it is unnecessary.

**Risk:** If the session log is written incrementally (unverified), killing mid-stream could leave a partial assistant turn. If it's written atomically at completion (consistent with observed behavior), any mid-stream kill is safe and `--resume` on a new child with the upgraded model will replay from the last complete user turn.

### In `sdk-proxy` mode (long-lived single child, many turns)

The sdk-proxy keeps one Claude child alive for the entire VSCode panel session and drives it via stream-json frames. There are distinct phases:

1. User text frame received → `set_model` injected → user frame forwarded → child begins generation
2. Child emits assistant frames (potentially including `tool_use` blocks)
3. VSCode/Claude Code executes tools and sends `tool_result` user frames back
4. Steps 2–3 repeat until `end_turn` or `max_tokens`
5. Child emits a `result` frame → turn complete

**The only safe kill boundary in sdk-proxy mode is between turns** — specifically after a `result` frame on stdout and before the next user text frame on stdin. Killing mid-generation (steps 2–4) in sdk-proxy mode would corrupt the child's internal state for the current session. The child process manages the session log; killing it mid-tool-round would leave the session in an undefined state from which `--resume` might not recover cleanly.

**Implication for T4 in sdk-proxy mode:** Mid-stream kill is not viable without a fundamentally different architecture (e.g., tracking turn boundaries via `result` frames and only killing at those boundaries — which is functionally equivalent to post-completion escalation, not mid-completion).

---

## Implementation sketch

The viable scope for T4 is the `run-cmd` path only (single-turn `--print` mode). Below is a pseudocode state machine for a standalone `streamWithEscalation` wrapper around `streamClaude`.

```
type EscalationState = "normal" | "struggling" | "killed" | "resumed";

async function streamWithEscalation(opts: StreamClaudeOptions & EscalationOpts): StreamResult {
  const MAX_SILENCE_MS = 10_000;
  const RETRY_LIMIT = 1;   // cycle-breaker
  let attempt = 0;

  while (attempt <= RETRY_LIMIT) {
    attempt++;
    let silenceTimer: NodeJS.Timeout | null = null;
    let state: EscalationState = "normal";

    // Wrap opts with a data-event interceptor that resets the silence timer
    const wrappedOpts = {
      ...opts,
      onChunk: (chunk: string) => {
        // reset silence watchdog
        if (silenceTimer) clearTimeout(silenceTimer);
        silenceTimer = setTimeout(() => {
          // silence threshold exceeded
          state = "struggling";
          abort.abort();   // AbortController signal → child.kill("SIGTERM") in streamClaude
        }, MAX_SILENCE_MS);

        // optional: n-gram repetition check on capturedStdout + chunk
        if (isRepetitive(capturedSoFar + chunk)) {
          state = "struggling";
          abort.abort();
        }
      }
    };

    const abort = new AbortController();
    const result = await streamClaude({ ...wrappedOpts, signal: abort.signal });

    if (silenceTimer) clearTimeout(silenceTimer);

    if (state === "struggling" && attempt <= RETRY_LIMIT) {
      // Upgrade to next model tier and resume
      state = "killed";
      opts = upgradeOpts(opts);   // bump model one tier
      opts.isResume = true;       // next spawn is --resume, not --session-id
      state = "resumed";
      continue;
    }

    return result;
  }

  // RETRY_LIMIT exhausted — return whatever we got from the last attempt
  return lastResult;
}
```

Key notes on the pseudocode:

- `streamClaude` already accepts an `AbortSignal` that calls `child.kill("SIGTERM")`. No new kill mechanism is needed.
- The `onChunk` callback is not currently in `StreamClaudeOptions` — it would need to be added. Currently `stream.ts` just pipes to `opts.stdout` and accumulates in `capturedStdout` with no callback hook.
- `upgradeOpts` needs to know the model ladder: haiku → sonnet → opus. The existing `downgradeUnderPressure` in `sdk-proxy.ts` has the same ladder in reverse.
- The resume on the new child needs `--resume <same-sessionId>` not `--session-id <new-uuid>`. This is already handled correctly by `buildClaudeArgs` when `isResume: true`.

---

## Cycle-breaker design

Without a hard retry cap, a prompt that no model can answer (truly ambiguous, malformed, or requires external information) would loop until the caller is killed.

**Minimal design:**

A single `attempt` counter, cap at `RETRY_LIMIT = 1` (one upgrade, maximum). This means: normal attempt → one escalated attempt → give up and return whatever the escalated attempt produced.

Why `1` and not higher: each upgrade adds latency, cost, and a cache-creation hit on the new model tier. Two upgrades (haiku → sonnet → opus) would add ~$0.08 per stuck prompt in cache-creation costs alone. The policy should be: one upgrade gives the user a meaningfully better model; beyond that, they should use `@deep` explicitly.

The `RETRY_LIMIT` should be configurable via `UserConfig.killReplayMaxAttempts` with a default of 1.

**Additional guard:** Only trigger escalation if the current model is not already at the top tier (opus). Check `opts.model.includes("opus")` before activating the silence watchdog.

---

## Risks

### 1. Session corruption (HIGH — unverified)

If the Claude CLI writes the assistant turn to the session log optimistically (streaming tokens as they arrive), then killing mid-stream leaves a partial turn. When `--resume` is called on the new child, it would replay from the partial state rather than from the last complete user turn.

**What would break:** The new child would receive an incomplete conversation history. The resumed response might be semantically wrong, or the CLI might error on the corrupted log.

**What we don't know:** Whether Claude's session log is append-on-complete or append-on-stream. This is the single most important unknown and must be verified empirically before T4 ships.

**How to verify:** Run a manual spike:
```bash
SID=$(uuidgen)
echo "write me a 2000-word essay about thermodynamics" \
  | claude --print --session-id "$SID" --model haiku &
CHILD_PID=$!
sleep 3
kill -TERM $CHILD_PID
# Then resume:
echo "summarize the essay you just wrote" \
  | claude --print --resume "$SID" --model haiku
```
If the resume says "I was cut off" or gives a coherent summary of partial output, the session log survived the kill. If it errors or says it has no prior output, the kill corrupted the log.

### 2. Telemetry attribution (MEDIUM)

A killed+resumed turn is one logical user turn but 2+ subprocess invocations. The current telemetry model logs one `decision` event per subprocess. If both invocations are logged, `stats` will count the turn twice and over-report costs. If only the resumed invocation is logged, the silence/kill event is invisible.

**Proposed handling:** See "Telemetry" section below.

### 3. Interaction with Track Z / session fingerprinting (MEDIUM)

When the model is upgraded (e.g., haiku → sonnet), the system-prompt fingerprint changes (model is a component of `computeFingerprint`). This means the upgraded child needs a different session than the original child. The session store would create a new `systemPromptFingerprint`-keyed record for the sonnet session.

However: the `--resume <original-sessionId>` flag on the new child refers to the conversation history in Claude's internal session log, not to Maestro's session store. Maestro's fingerprint key only determines which `sessionId` UUID Maestro requests — it's Claude's session log (indexed by UUID) that holds the actual conversation history.

The implication is that the killed turn's UUID was a haiku-fingerprint session. When Maestro creates a sonnet-fingerprint session to resume, it will either:
a) Generate a new UUID (new session, no history) — wrong
b) Reuse the same UUID under the sonnet fingerprint — requires the session store to support "re-keying" an existing session under a new fingerprint

**Current behavior:** `getByFingerprint` looks up sessions by `(cwd, fingerprint)`. The haiku UUID is stored under the haiku fingerprint. The sonnet fingerprint lookup will find no recent session and create a new UUID — which would start a fresh conversation, defeating the purpose of resuming.

**Required change for T4:** The kill-and-replay logic must pass the original `sessionId` directly to the new child's `--resume` flag, bypassing the fingerprint-based session store lookup. This is a special-case path that doesn't exist today.

**Does `computeFingerprint` change?** Yes, model is a fingerprint input. On kill-and-replay, the session used to resume must be treated as a "cross-fingerprint resume" — the original UUID under an upgraded model. This is analogous to how the sdk-proxy uses `set_model` to change models within a single long-lived child, but applied to the `--resume` path.

**Track Z prewarm interaction:** After a kill-and-replay, the prewarm logic in `run-cmd.ts` would fire for the sonnet fingerprint, potentially creating a redundant prewarm session. This is benign (prewarm is idempotent) but slightly wasteful.

### 4. `sdk-proxy` mode is incompatible (LOW risk, but scopes the feature)

As analyzed in "Safe kill window", mid-stream kill in sdk-proxy is not viable. T4 is `run-cmd` only. The sdk-proxy already has `set_model` injection which is a per-turn model change with zero subprocess cost. The correct analog for sdk-proxy is to detect struggle post-completion (via `result` frame) and inject a higher-tier `set_model` on the next user turn.

---

## Telemetry

A killed+resumed turn should be logged as a single logical event with an `escalated: true` flag rather than two separate events. This prevents double-counting in `stats`.

**Proposed `TelemetryEvent` addition:**

```ts
| {
    type: "decision";
    ts: string;
    decision: Decision;
    cost?: CostBreakdown;
    prompt?: string;
    sessionId?: string;
    turnIndex?: number;
    // T4: set when this turn was kill-and-replayed
    escalatedFrom?: {
      model: string;
      escalationReason: "silence" | "repetition";
      killedAfterMs: number;
    };
  }
```

The `cost` field would reflect the resumed attempt only (the killed attempt produced no result envelope). The `escalatedFrom` block captures what was killed and why, enabling oracle analysis of escalation frequency and cost.

**`decisions.jsonl` impact:** One entry per logical turn, same as today. The `escalatedFrom` field is optional and ignored by existing consumers.

---

## Simpler alternative

The simpler path — post-completion max_tokens escalation via auto-resume — is already ~50% implemented as E1.escalate in `run-cmd.ts`.

**Current E1.escalate behavior:** When a `standard` turn returns `stopReason: "max_tokens"`, the session is flagged via `sessions.setEffortEscalated`. On the NEXT turn, effort is upgraded from `low` to `medium`. This means the user sees the truncated output and then gets a slightly better experience on the next prompt — not a recovery of the same prompt.

**The missing piece:** Auto-resume on the same prompt after `max_tokens`. When `stopReason === "max_tokens"`, re-issue the same prompt on the next-tier model (or higher effort) using `--resume` to pick up where the model left off. The user sees a "continuing..." indicator rather than truncated output.

This covers the same core case as T4 (model struggling and truncating) with:
- Zero risk of session corruption (the first subprocess exited cleanly with `max_tokens`)
- No need for mid-stream signal detection
- Simpler code path (post-completion is a well-understood hook point in `run-cmd.ts`)

**What it misses vs T4:**
- Stalls and loops not caused by `max_tokens` (e.g., model spinning on a hard problem, producing garbage without hitting the token limit)
- Time saved by killing early vs waiting for `max_tokens` to fire

**Recommendation: build the simpler alternative first.** It requires ~30 lines of change to `run-cmd.ts` and zero architectural risk. The silence/repetition signals in T4 remain valuable but should wait until the simpler path is deployed and produces telemetry showing what % of degraded turns are missed by the post-completion approach.

---

## Verdict

**Simpler alternative (post-completion auto-resume): Build.** Low risk, directly extends the existing E1.escalate path, covers the most common "model ran out of tokens" case. Implement in `run-cmd.ts` as an E1.resume step:

1. After `parseOutput` returns `stopReason === "max_tokens"`:
2. Build upgraded args (one model tier up, or effort `medium` → `high`)
3. Call `streamClaude` again with `--resume <same-sessionId>` and hint "Resume from where you stopped."
4. Log a single telemetry event with the combined cost and `escalated: true` flag

**T4 proper (mid-stream kill): Spike more before building.** The session-corruption risk (Risk 1) must be verified empirically with the manual spike described above before any implementation starts. If `--resume` after a mid-stream kill is clean (verified empirically), then T4 proper is worth building for the silence signal only (the repetition signal has too many false positives to deploy without calibration data). If `--resume` after kill produces a corrupt session, T4 is not viable without changes to Claude CLI internals — skip indefinitely.

**Timeline suggestion:**
1. Build E1.resume (simpler alternative) now — 1 session.
2. Run the manual session-corruption spike (30 minutes of manual testing).
3. If clean: implement T4 silence-only detection as an opt-in behind `userConfig.killReplayEnabled: false` (default off) — 1 session.
4. If corrupt: close T4, add one line to `docs/future-ideas.md`, revisit if Claude CLI exposes a session checkpoint API.
