# Stream-JSON Per-Turn Routing — Design Spec

**Date:** 2026-05-22
**Status:** Approved for implementation
**Scope:** `src/wrapper/stream-json-proxy.ts` (new) + `src/cli/wire-compat.ts` (update)

---

## Problem

Maestro's VSCode panel sessions currently use session-start routing: the first user message is classified, and that model is used for every subsequent turn in the session. A session that begins trivially (e.g. "what does this function do?") and escalates (e.g. "redesign the cache layer") stays on the wrong model for the expensive turns.

The panel uses `--input-format stream-json`, which is a long-lived bidirectional NDJSON channel. Changing `--model` mid-session is impossible without restarting the process, which breaks session continuity and re-pays the `cache_creation` cost (~$0.05–$0.27).

---

## Solution: Per-Turn `--print --resume` Proxy

Maestro takes over the stdin/stdout channel completely. For each user turn it:

1. Reads the next user message from the extension's stdin (NDJSON line)
2. Classifies the prompt text
3. Spawns `claude --print --resume <sid> --model X --output-format stream-json`
4. Pipes the streaming output back to the extension's stdout
5. Logs per-turn telemetry
6. Waits for the next turn

Session continuity is preserved via `--session-id <uuid> --resume`. Spike 1 confirmed that model swaps across `--resume` are safe (Haiku→Sonnet preserves full context). Tools (Bash, Read, Write, Edit, Glob, Grep) work natively in `--print` mode — the extension sees tool_use and tool_result events in the output stream but does not execute them.

---

## Architecture

```
Extension process
  │  stdin  (NDJSON user turns)
  ▼
┌─────────────────────────────────┐
│  Maestro stream-json-proxy      │
│                                 │
│  loop:                          │
│    readNextUserTurn()           │
│      ↓ promptText               │
│    pipeline.route()             │
│      ↓ decision                 │
│    buildTurnArgs()              │
│      ↓ args                     │
│    spawn claude --print         │
│      --resume <sid>             │
│      --model X --effort Y       │
│      --output-format stream-json│
│      ↓ NDJSON events            │
│    forward to stdout            │
│    suppress init on turns 2+    │
│    log telemetry per turn       │
└─────────────────────────────────┘
  │  stdout (NDJSON events)
  ▼
Extension process
```

---

## New Module: `src/wrapper/stream-json-proxy.ts`

### Exported pure functions (testable without spawning)

**`extractSessionId(args: ReadonlyArray<string>): string | null`**
Scans `args` for `--session-id <value>`. Returns the UUID or null. Used to preserve the session ID the extension provided across all per-turn spawns.

**`buildTurnArgs(base, decision, sessionId, isFirstTurn, bareSupported, excludeDynamic): string[]`**
Constructs the CLI args for one `--print` turn:
- Strips from base: `--input-format stream-json` (and its value), `--output-format <any>` (and its value), routing flags (`--model`, `--effort`, `--max-budget-usd`)
- Strips: `--session-id` and `--resume` (we re-add them below)
- Adds: `--output-format stream-json`
- Adds: `--session-id <uuid>` (always)
- Adds: `--resume` (on turns 2+; turn 1 creates the session fresh or resumes if extension sent --resume)
- Applies routing: `--model X --effort Y --max-budget-usd Z`
- Never adds `--bare` (panel needs full structured output)
- Applies `--exclude-dynamic-system-prompt-sections` per config

**`readNextUserTurn(lines: AsyncIterable<string>): Promise<UserTurn | null>`**
Consumes NDJSON lines until it finds a `{"type":"user"}` message whose `content` array contains a `{"type":"text"}` block. Returns `{ promptText, sessionId }` or null when stdin closes. Skips: system, assistant, tool_result-only user messages, non-JSON lines.

### Orchestrator

**`runStreamJsonProxy(opts: StreamJsonProxyOptions): Promise<number>`**

```
opts:
  realClaude: string
  claudeArgs: ReadonlyArray<string>
  pipeline: Pipeline
  userConfig: UserConfig
  telemetry: Telemetry
  stdin: Readable        (process.stdin in production)
  stdout: Writable       (process.stdout in production)
  stderr: Writable
```

Main loop:
```
sessionId = extractSessionId(claudeArgs) ?? null
isFirstTurn = true
exitCode = 0

while true:
  turn = await readNextUserTurn(lines(stdin))
  if turn is null: break

  if sessionId is null and turn.sessionId is not null:
    sessionId = turn.sessionId

  decision = await pipeline.route({ prompt: turn.promptText })

  args = buildTurnArgs(claudeArgs, decision, sessionId, isFirstTurn, false, userConfig.excludeDynamicSections)

  result = await streamClaudeForTurn(realClaude, args, turn.promptText, stdout, isFirstTurn)

  await telemetry.log({ type: "decision", decision, cost: result.cost })

  isFirstTurn = false
  exitCode = result.exitCode ?? 0

return exitCode
```

**`streamClaudeForTurn(binary, args, prompt, stdout, isFirstTurn)`**
Spawns `claude --print` with the turn args, writes `prompt` to stdin, reads NDJSON events from stdout:
- If `isFirstTurn` is false: suppresses the `{"type":"system","subtype":"init",...}` line (the extension already has an init event from turn 1)
- Forwards all other events to `stdout`
- Returns `{ exitCode, cost: CostBreakdown | null }` parsed from the `result` event

---

## Changes to `src/cli/wire-compat.ts`

Replace the `argsContainStreamJsonInput` block (~35 lines) with:

```typescript
if (argsContainStreamJsonInput(claudeArgs)) {
  const pre = preflight();
  const cli = await loadCliConfig();
  const pipeline = buildPipeline(cli);
  const telemetry = createTelemetry(...);
  return runStreamJsonProxy({
    realClaude,
    claudeArgs,
    pipeline,
    userConfig: cli.userConfig,
    telemetry,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
```

The existing `buildPipeline` helper (inline in the --print path) is extracted into a shared function to avoid duplication.

---

## Test Coverage

**`src/wrapper/stream-json-proxy.test.ts`**

| Test | What it covers |
|------|---------------|
| `extractSessionId` — present | Returns UUID |
| `extractSessionId` — absent | Returns null |
| `extractSessionId` — --resume without value | Returns null, no crash |
| `buildTurnArgs` — strips input-format, adds output-format | Correct args |
| `buildTurnArgs` — isFirstTurn=true has no --resume | First turn args |
| `buildTurnArgs` — isFirstTurn=false has --resume | Subsequent turn args |
| `buildTurnArgs` — routing flags replaced | --model/--effort/--budget updated |
| `buildTurnArgs` — never adds --bare | Safe for panel |
| `readNextUserTurn` — user text turn | Returns promptText |
| `readNextUserTurn` — skips system lines | Correct filtering |
| `readNextUserTurn` — skips tool_result-only user msg | Not a routeable turn |
| `readNextUserTurn` — skips non-JSON | No crash |
| `readNextUserTurn` — null on stream close | Clean exit |
| `streamClaudeForTurn` — suppresses init on turn 2 | No duplicate init to extension |
| `streamClaudeForTurn` — forwards result events | Telemetry populated |
| `runStreamJsonProxy` — multi-turn with mock spawn | Full loop, per-turn decisions logged |

---

## Telemetry

Each turn is logged as a separate `decision` event, same schema as `--print` mode turns. The `classifier` field will show the actual classifier used (heuristic, llm, etc.), not a synthetic `"stream-json"` string. This means `maestro stats` will show panel sessions alongside terminal sessions with accurate per-turn cost breakdown.

---

## What This Does NOT Cover

- **Extension-managed MCP tools**: MCP config is preserved via arg passthrough (unchanged from current), but any tool that requires the extension to execute (not native `--print` mode tools) will not work. This is a pre-existing limitation; no regression introduced.
- **Per-turn session cost cap**: `--max-budget-usd` is set per routing decision. A session with many turns could exceed an intended daily cap. Addressed by the existing `dailyCostCapUsd` config (not in scope here).
- **Streaming partial text before turn completes**: `--output-format stream-json` already streams content chunks as they arrive, so the extension gets real-time output. No additional work needed.

---

## Files Changed

| File | Change |
|------|--------|
| `src/wrapper/stream-json-proxy.ts` | New, ~280 lines |
| `src/wrapper/stream-json-proxy.test.ts` | New, ~220 lines |
| `src/cli/wire-compat.ts` | Replace stream-json handler (~35 lines), extract `buildPipeline` helper |
