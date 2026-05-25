# Thinking Token Reduction — Design Spec

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce tokens consumed during Claude's internal reasoning and tool-use loops while holding quality constant, and fix the telemetry blind spots that make this invisible today.

**Architecture:** Three independent tracks — (A) context compression before routing, (B) thinking-mode persona injection, (C) telemetry instrumentation to make the hidden costs visible. Each track is independently shippable; none depends on the others.

**Tech Stack:** TypeScript ESM, Node ≥ 20, existing Maestro pipeline and wrapper, no new runtime deps.

---

## The Token Composition Problem

When you send a prompt to Claude via Maestro, the `total_cost_usd` captured in telemetry is accurate but opaque. Here's what it actually contains:

```
total_cost_usd = (input tokens × model_input_rate)
               + (output tokens × model_output_rate)          ← includes thinking!
               + (cache_creation × cache_write_rate)
               − (cache_read × cache_read_rate)               ← savings
```

The hidden costs inside `output tokens`:
- **Thinking tokens** — Claude's internal chain-of-thought before it writes a word. With `--effort high`, this can be 80% of output cost.
- **Tool call outputs** — each `Read`/`Edit`/`Bash` call adds output tokens (the tool invocation JSON) and then adds the file content as input tokens on the next turn.

For a "rename foo to bar" trivial task, the breakdown is approximately:
| Category | Tokens | % of cost |
|---|---|---|
| System prompt (cached) | 0 (cache_read) | 0% |
| Session history (cached) | 0 (cache_read) | 0% |
| Current prompt | ~20 | < 1% |
| Thinking | ~200–800 | 60-80% |
| Output text | ~50–200 | 20-40% |

**The largest single lever is thinking tokens — and they're completely invisible today.**

---

## Track A: Context Compression Before Routing

### A1: Closed-form prompt rewriting for trivial class

**The hack:** Claude's thinking budget scales with input ambiguity. An "open problem" prompt forces Claude to consider approaches, verify, plan. A "closed completion" prompt collapses thinking to fill-in-the-blank.

Open form (current): `"rename the variable userNaem to userName"`
→ Claude thinks: find all occurrences, check for naming conflicts, understand the codebase, decide whether to explain...

Closed form (proposed): `"Apply: s/userNaem/userName/g. Output changed lines only."`
→ Claude thinks: apply the substitution. Done.

**Implementation:** In `src/cli/run-cmd.ts` and `src/cli/wire-compat.ts`, for prompts classified as `trivial` with `confidence ≥ 0.9` and `bareSafe: true`, post-process the prompt before passing it to `streamClaude`:

```typescript
function closedFormRewrite(prompt: string, cls: Class, confidence: number): string {
  if (cls !== "trivial" || confidence < 0.9) return prompt;
  // Rename: "rename X to Y" → "s/X/Y/g. Output changed lines only."
  const renameMatch = prompt.match(/^rename\s+(?:the\s+)?(?:variable\s+)?[`"]?(\S+)[`"]?\s+to\s+[`"]?(\S+)[`"]?/i);
  if (renameMatch) return `Apply: s/${renameMatch[1]}/${renameMatch[2]}/g. Output changed lines only. No explanation.`;
  // Format: "format this file with prettier" → lean form
  if (/^(format|prettier|eslint|lint)\b/i.test(prompt)) return `${prompt}. Output only the changed lines.`;
  return prompt;
}
```

**Expected impact:** 40-70% thinking token reduction on bareSafe trivial prompts. These are the cheapest prompts anyway, so absolute savings are small — but the pattern matters for the system.

### A2: Context peeling — strip irrelevant file content from the prompt

**The hack:** Users frequently paste entire files for operations that affect 5 lines. Claude processes all pasted content during thinking. Stripping irrelevant context reduces the thinking surface proportionally.

**Detection:** Inspect the prompt for embedded file content (heuristic: 20+ lines of code-looking text). Extract lines relevant to the detected operation:
- Rename X: extract lines containing `X` ±5 lines
- Add to function `foo`: extract function `foo` body ±10 lines
- General: extract first 50 + last 20 lines (intro + exports)

**Implementation:** New module `src/wrapper/peel.ts`:

```typescript
export function peelContext(prompt: string, cls: Class): string {
  // Only peel for trivial/simple — hard/reasoning/max may need full context
  if (cls !== "trivial" && cls !== "simple") return prompt;
  const lines = prompt.split("\n");
  if (lines.length < 30) return prompt; // no peel needed
  // detect code block: 3+ consecutive lines starting with spaces/code chars
  // extract relevant window around detected operation
  // ... implementation
}
```

**Expected impact:** For 500-line files, reduces effective input from ~10,000 tokens to ~500-2,000 tokens. At Haiku input rate ($0.0000008/token), saves $0.007 per such call. Small per-call but compounds.

### A3: Ephemeral sessions for trivial tasks in long sessions

**The hack (counterintuitive):** For trivial bareSafe tasks in a session with >15 prior turns, a fresh session is CHEAPER than resuming. With 15 turns of history, input tokens grow to ~100,000+ even with caching. A fresh trivial session with `--bare` pays $0.002 cache_creation and processes only 200 input tokens.

Crossover math: Haiku charges $0.0008/1k input tokens. At 15 turns of ~50k token history: reading from cache costs $0.0000012/token × 50,000 = $0.06 input cost even on cache_read. A fresh session: $0.02 cache_creation. Fresh wins at turn 25+.

**Implementation:** Add `trivialEphemeralAfterTurn: number` config (default: 25). In `run-cmd.ts`, when routing trivial+bareSafe and `recentClasses.length >= config.trivialEphemeralAfterTurn`, force `newSession: true`.

---

## Track B: Thinking-Mode Persona Override

### B1: Per-class cognitive mode injection via `--append-system-prompt`

The current `appendSystemPrompt` is a brevity hint: "Be concise. Avoid preambles." This softly nudges output style. The **bold version** changes the cognitive mode — HOW Claude thinks, not just what it outputs.

**The hack:** For each class, inject a cognitive persona that structurally changes the internal reasoning path:

```typescript
const COGNITIVE_MODE_BY_CLASS: Record<Class, string> = {
  trivial: "EFFICIENCY MODE: Single mechanical operation. No approach planning. No verification. Output the change only.",
  simple: "FOCUSED MODE: Single-file edit. Read only what's needed. Make the change. One brief sentence if clarification needed.",
  standard: "STANDARD MODE: Read relevant context, implement, verify once. No exploration beyond the task.",
  hard: "DEEP MODE: Thorough analysis warranted. Use tools freely. Explain your reasoning on complex decisions.",
  reasoning: "", // no override — full thinking warranted
  max: "",       // no override — full thinking warranted
};
```

In `buildClaudeArgs` (`spawn.ts`), append the cognitive mode after the user's `appendSystemPrompt`:

```typescript
const cogMode = COGNITIVE_MODE_BY_CLASS[decision.class];
const fullAppend = [userAppend, cogMode].filter(Boolean).join(" ");
```

**Why this works:** Claude's thinking style mirrors the register of its instructions. A persona that says "no approach planning" triggers a different internal path than a persona that says "be thorough." This is not output formatting — it's instruction-following at the thinking level.

**Expected impact:** The literature on prompt engineering shows system-prompt persona changes reduce chain-of-thought length by 30-60% on constrained tasks. For trivial class: estimated 50% thinking token reduction.

**Risk:** Quality degradation on hard/reasoning (hence the empty string for those classes). Needs eval verification after each class-level change.

### B2: Schema-constrained output for trivial/simple

**The hack:** `--json-schema` forces structured JSON output. When the output schema is maximally constrained, the thinking collapses to "fill in the schema fields."

For trivial rename operations:
```json
{
  "type": "object",
  "properties": {
    "old": {"type": "string"},
    "new": {"type": "string"},
    "changed_lines": {"type": "array", "items": {"type": "string"}}
  },
  "required": ["old", "new", "changed_lines"]
}
```

The model thinks: "old = userNaem, new = userName, changed_lines = [...]". Zero narrative, zero explanation, zero thinking about how to present the answer.

**Implementation:** Add `outputJsonSchema?: string` to `ClassSpec`. For trivial class, set it to a minimal diff schema. In `buildClaudeArgs`, emit `--json-schema` when set.

**Caveat:** This changes the output format that the VSCode extension sees. Claude Code's extension expects natural language. The output parser would need to extract the changed lines from the JSON and reformat as a diff. Complex integration — ship as an opt-in config flag.

### B3: Tool call pre-fetching — inject file content to avoid Read round trips

**The hack:** The most expensive hidden token cost is the Read → process → Edit → process tool loop. Each tool call turn multiplies the session input tokens by adding the full previous context + the tool result. A 5-Read session can cost 10× more than a 1-turn session in input tokens.

**Pre-emptive context injection:** When the routing decision is `trivial` or `simple` AND the prompt mentions a file path (or a file can be inferred from the session context), inject the file content directly into the prompt before Claude starts. Claude doesn't need to call `Read` — the content is already there.

```typescript
async function injectFileContext(prompt: string, cls: Class): Promise<string> {
  if (cls !== "trivial" && cls !== "simple") return prompt;
  // Detect file references: paths like "src/foo.ts", "utils.ts", "./bar.js"
  const fileRef = prompt.match(/\b(src\/[\w/.-]+\.(ts|js|py|go|rb)|[\w-]+\.(ts|js|py|go|rb))\b/);
  if (!fileRef) return prompt;
  try {
    const content = await readFile(fileRef[0], "utf8");
    const lines = content.split("\n");
    if (lines.length > 100) return prompt; // too large — let Claude use Read normally
    return `File content of ${fileRef[0]}:\n\`\`\`\n${content}\n\`\`\`\n\nTask: ${prompt}`;
  } catch {
    return prompt; // file not found — pass through unchanged
  }
}
```

**Expected impact:** Eliminates 1-2 tool call round trips per simple task. Each eliminated round trip saves: (session history tokens + file content tokens) × input_rate. For a 10-turn session with a 200-line file: saves ~15,000 input tokens × $0.0000008 = $0.012 per call.

**Risk:** Over-injecting context for tasks that don't need it (e.g., the user mentions a filename in passing but doesn't want it read). Mitigate by only injecting when the prompt contains action verbs targeting the file.

---

## Track C: Telemetry Instrumentation

### C1: First-byte latency — proxy for thinking tokens

**The insight:** Claude starts streaming output only AFTER the thinking phase completes (with `--effort low/medium/high`). Time-to-first-byte is therefore a proxy for thinking token count.

**Formula:** `estimated_thinking_tokens ≈ (first_byte_ms / 1000) × model_tokens_per_second`

| Model | Tokens/second |
|---|---|
| haiku | ~1500 |
| sonnet | ~800 |
| opus | ~400 |

**Implementation:** In `src/wrapper/stream.ts`, record `firstByteMs` (milliseconds from spawn start to first non-whitespace character of output). Add to `CostBreakdown`:

```typescript
export type CostBreakdown = {
  // existing fields...
  /** ms from spawn to first output byte — proxy for thinking overhead */
  firstByteMs?: number;
  /** estimated thinking tokens = firstByteMs/1000 × model_token_rate */
  estimatedThinkingTokens?: number;
};
```

In `maestro stats`, show per-class thinking overhead:
```
thinking overhead (estimated)
  trivial       avg  800 tok  (~$0.0006/call)
  standard      avg 3200 tok  (~$0.003/call)
  hard          avg 8000 tok  (~$0.008/call)
```

This is the first time you'll have visibility into where the hidden costs actually live.

### C2: Session depth tracker — the invisible context growth cost

**The insight:** As a session grows, each new turn re-reads the entire history from cache. Even cache_read isn't free ($0.00015/1k tokens for Haiku). A 30-turn session where each turn re-reads 100k tokens of history costs $0.00015 × 100 × 30 = $0.45 in cache_read overhead — invisible in current telemetry.

**Implementation:** Track `sessionTurnCount` (number of `appendClass` calls for the current session) in `SessionRecord`. Log it in the `decision` telemetry event. In `maestro stats`, show:

```
session depth effect
  avg session depth at time of decision: 12 turns
  estimated context overhead per turn:   $0.0012
  weekly cost from context growth:       $0.073
```

### C3: Tool call count from output parsing

**The insight:** Claude's `--output-format json` output includes the conversation that happened internally, including tool use blocks. By counting the tool use blocks in the streamed output, Maestro can estimate how many Read/Edit/Bash calls occurred.

**Implementation:** In `src/wrapper/output.ts`, parse for tool use blocks:

```typescript
function countToolCalls(rawOutput: string): number {
  return (rawOutput.match(/"type"\s*:\s*"tool_use"/g) ?? []).length;
}
```

Add `toolCallCount?: number` to `CostBreakdown` and log it. In `maestro stats`:

```
tool calls per decision (avg)
  trivial     0.3
  simple      1.8
  standard    4.2
  hard        8.7
```

High tool call counts on standard/hard are the target for pre-fetching (Track B3).

### C4: The "should have been trivial" signal

**The insight:** When a `standard` decision generates < 150 output tokens and 0-1 tool calls, it was probably trivial. This is a soft mis-route signal — the heuristic over-classified.

**Implementation:** In `run-cmd.ts`, after parsing output, check:

```typescript
if (decision.class === "standard" && parsed?.cost?.outputTokens < 150 && toolCallCount <= 1) {
  // Log implicit "should have been simple" signal to telemetry
  void telemetry.log({ type: "outcome", ..., impliedClass: "simple" });
}
```

Feed these signals into `maestro tune --learn` to auto-generate downgrade heuristic patterns. This closes the feedback loop between runtime behavior and routing accuracy.

---

## Track D: Response Output Cache (Bold / Experimental)

### D1: Local deterministic output cache for bareSafe trivial

**The most aggressive hack:** For `trivial` + `bareSafe: true` + `confidence ≥ 0.95`, the output is highly deterministic. Cache it locally keyed by `sha256(prompt + file_content_hash)`. On a cache hit, replay the stored output without spawning Claude.

**Savings:** 100% token reduction for repeated operations. In a typical day: "format this file" runs multiple times on the same files, "lint fix" runs after every edit. These are the highest-frequency operations and the most deterministic.

**Implementation:**
- `src/wrapper/output-cache.ts`: JSONL file at `~/.maestro/output-cache.jsonl`, keyed by prompt hash + file hash
- TTL: 1 hour (file content may change)
- Cap: 500 entries, LRU eviction
- Gate: only for trivial, bareSafe, confidence ≥ 0.95, and only when the file(s) referenced in the prompt haven't changed since the cache was written

**Risk:** Cache stale if file changes between writes. Mitigate with file mtime check. Also: cached outputs may contain "...I have renamed all occurrences" style language — need to verify the output is structurally a code change, not prose.

---

## Priority and Expected Impact

| Track | Implementation Effort | Expected Token Reduction | Ships When |
|---|---|---|---|
| C1: First-byte latency telemetry | Low (2h) | 0% actual, 100% visibility | Next sprint |
| C2: Session depth tracking | Low (1h) | 0% actual, visibility | Next sprint |
| B1: Cognitive mode persona injection | Low (2h) | 30-50% thinking tokens on trivial/simple | Next sprint |
| C3: Tool call count | Medium (3h) | 0% actual, visibility | Next sprint |
| A2: Context peeling | Medium (4h) | 30-60% on large-file prompts | v0.3 |
| B3: File pre-injection | Medium (4h) | Eliminate 1-2 tool round trips | v0.3 |
| A3: Ephemeral trivial sessions | Low (2h) | 40-60% on long sessions | v0.3 |
| C4: Should-have-been-trivial signal | Medium (3h) | Improves routing accuracy 2-5% | v0.3 |
| A1: Closed-form prompt rewriting | High (8h) | 40-70% thinking on trivial | v0.3 |
| B2: Schema-constrained output | High (6h) + integration risk | 60-80% thinking on trivial | v0.4 |
| D1: Response output cache | High (6h) + risk | 100% on repeated operations | v0.4 |

**Recommended sequencing:**

1. **First:** Ship C1 + C2 + C3 — pure observability, no behavior change. You can't optimize what you can't see. These give you the data to prioritize the rest.

2. **Second:** Ship B1 — cognitive mode injection. Low risk (strings-only change), high impact (30-50% thinking reduction on trivial/simple). Validate with eval.

3. **Third:** Ship A3 + C4 + B3. Three independent improvements that compound.

4. **Later:** A1, B2, D1 are progressively bolder with more integration complexity.

---

## Appendix: What the telemetry currently does and doesn't capture

**Captured (accurate):**
- `total_cost_usd` per routing decision — exact, matches Anthropic billing
- `inputTokens`, `outputTokens`, `cacheCreationInputTokens`, `cacheReadInputTokens` — correct
- Per-class cost averages, override rates, cache hit rates

**Not captured:**
- Thinking token breakdown (hidden inside `outputTokens`)
- Per-tool-call token counts within a session
- Session history overhead growth per turn
- Time-to-first-byte (thinking duration proxy)
- Tool call count per session
- Whether output contained code vs prose (quality signal)

**PII note:**
Default PostHog events contain no PII: class, confidence, model, latency, base64-hashed cwd (non-reversible). Only risk: `sendPromptText: true` sends raw prompt text, which may contain variable names, file paths, or business logic. Leave `sendPromptText` off unless explicitly opted in.
