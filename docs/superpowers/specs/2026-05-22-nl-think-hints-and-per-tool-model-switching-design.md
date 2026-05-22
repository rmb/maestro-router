# Design: Natural-language think hints & per-tool model switching

Date: 2026-05-22  
Status: Approved

---

## 1. Natural-language think hints in override classifier

### Problem

Users write "think hard", "think deeply", "think step by step" without an `@` prefix.
Today that phrase escapes `override.ts` entirely and lands in the heuristic/LLM stages,
which may or may not route it to the right model. The user's intent is unambiguous —
they are asking for the most capable model — but Maestro ignores the signal.

### Decision

Extend `override.ts` with a second regex (`NATURAL_THINK_RE`) that catches
natural-language intensity phrases and routes them to `max` (Opus) at confidence 1.0.

**Patterns matched** (case insensitive):

```
think hard
think harder
think deeply / think deep
think carefully / think more carefully
think step by step / think step-by-step
```

**False-positive guard.** The regex requires an intensity modifier immediately after
"think". The following must NOT match: "I think", "rethink", "overthink", "think" alone.

**Class mapping:** `max` — same as `@deep`/`@opus`. Rationale: "think hard" is stronger
than `@think` (extended reasoning on Sonnet). The user is signalling they want the
best answer, not just extended thinking time.

**Diagnostic code:** `override.nl_think` — distinguishes natural-language detections
from `@hint` detections in telemetry/logs.

**`stripOverride` unchanged.** Natural-language phrases are part of the user's sentence;
stripping them before forwarding to Claude would corrupt the prompt.

### Architecture

```
override.ts
  ├── OVERRIDE_RE  (@fast / @think / @opus / ...)   → existing
  └── NATURAL_THINK_RE  (think hard / deeply / ...)  → new
```

Both regexes run in the same `classify` function. Override hit at confidence 1.0 →
pipeline short-circuits. Zero per-call cost.

### Tests

| Input | Expected |
|---|---|
| `"think hard if there is a way"` | `max`, confidence 1.0 |
| `"think deeply about this"` | `max` |
| `"think step-by-step"` | `max` |
| `"think step by step"` | `max` |
| `"think carefully"` | `max` |
| `"THINK HARD"` | `max` (case insensitive) |
| `"I think this is fine"` | `null` |
| `"rethink the approach"` | `null` |
| `"overthink it"` | `null` |
| `"think"` (alone) | `null` |

Diagnostic code `override.nl_think` present on all positive matches.

### ADR

→ ADR-0005

---

## 2. Per-tool model switching during multi-step execution

### Problem

When a user sends a complex prompt, Maestro routes it once, spawns
`claude --print --model X`, and that model handles the entire execution including
all internal tool calls (Edit, Bash, Write, Read, …). There is no opportunity to
switch models between tool calls. A trivial Bash command inside a complex session
pays Opus prices; an expensive architectural judgement inside a simple session gets
Haiku.

### Why this is a hard constraint today

`claude --print` owns the tool-execution loop internally. Maestro wraps the CLI
binary; it has no hook between tool calls. The model is bound at spawn time for the
full invocation lifetime.

### The path that exists (SDK proxy)

In streaming API / SDK mode, each `tool_result` is a separate HTTP turn:

```
user_prompt → [model A spawned]
  → tool_use { name: "Edit", id: "tu_1" }
  → tool_result { id: "tu_1" }    ← re-entry point
  → [could spawn model B here]
  → tool_use { name: "Bash", id: "tu_2" }
  → tool_result { id: "tu_2" }    ← re-entry point
  → [could spawn model C here]
```

The `sdk-proxy` + `tool-override` classifier (shipped v0.3) already implements
the routing logic for this mode: `tool_use_id → tool_name → class → model`. The
missing piece is a **stdio bridge** — a local API proxy server that speaks the
streaming API protocol, intercepts each `tool_result` turn, and routes the
continuation to a different model. `claudeProcessWrapper` today wraps a CLI binary,
not an HTTP server.

### Options considered

| Option | Cost | Capability | Verdict |
|---|---|---|---|
| Status quo (per-turn routing only) | 0 | Model fixed per turn | Current |
| Natural-language hints (this spec §1) | Trivial | User can pre-select right model | Ships now |
| stdio bridge / local API proxy | Large | True per-tool routing | Deferred v0.3 |

### Decision

**Defer the stdio bridge to v0.3.** The complexity-vs-savings tradeoff is not yet
justified: most multi-step sessions are homogeneous in complexity, and the per-turn
routing already captures the dominant cost signal. The natural-language hint fix
(§1) closes the most common case where the user signals complexity upfront but
Maestro misses it.

**Preconditions for v0.3 implementation:**

1. `maestro stats` evidence that per-tool switching would save ≥ 15% on real
   workloads (currently unmeasured).
2. An ADR covering the stdio bridge protocol, session continuity across model swaps
   at the tool boundary, and the latency budget per tool call.
3. Bench evidence that the `tool-override` classifier accuracy is ≥ 85% on a
   labelled tool-call dataset.

### ADR

→ ADR-0007
