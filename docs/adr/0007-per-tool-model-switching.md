# ADR-0007 · Per-tool model switching during multi-step execution

## Status

Accepted · 2026-05-22

## Context

When Maestro spawns `claude --print`, the model is locked for the full invocation.
All tool calls (Edit, Bash, Read, Write, …) that Claude makes internally run on the
same model that was selected at turn start. A `Read` call on Opus pays Opus prices;
a multi-file architectural judgement on Haiku gets the wrong model. The per-turn
routing captures the dominant cost signal but cannot optimise within a single turn.

The question surfaced in a session review: "Is there a way to change models during a
multi-layer execution?"

## Constraint

`claude --print` owns the tool-execution loop internally. A CLI wrapper has no hook
between tool calls. The only interception point is the stream-json SDK protocol used
by the VS Code extension, where each `tool_result` is a distinct frame on stdin.

## Decision

Implement per-tool model switching via the existing stream-json SDK proxy path
(`claudeProcessWrapper`). Three components ship together:

### 1. `src/classifiers/tool-override.ts`

A classifier that maps tool names to routing classes at confidence 1.0:

| Tool | Class | Rationale |
|---|---|---|
| Read, Glob, Grep, LS | trivial | Pure reads; no generation |
| Edit, Write, MultiEdit, NotebookEdit, Bash | simple | Structured writes / shell execs |
| Task, WebFetch, WebSearch | standard | May require multi-step reasoning |

Unknown tools return `null` (pipeline falls through to other classifiers).

### 2. `src/wrapper/sdk-proxy.ts` (per-tool routing extension)

On every assistant stdout frame, the proxy records `tool_use_id → tool_name` in a
bounded map (cap 50, oldest-first eviction). On every `tool_result` stdin frame,
it resolves the tool name, injects it as `metadata.resolvedToolName` into the
`Request`, and routes via the full pipeline. `tool-override` fires at conf=1.0 for
known tools. The selected model is injected via `set_model` before the frame is
forwarded to Claude.

### 3. `src/cli/wire-compat.ts`

`toolOverrideClassifier` inserted into the pipeline so it runs on every turn,
including `tool_result` turns.

## Why not `claude --print`?

`--print` mode does not expose individual tool calls as re-routable turns. Supporting
per-tool switching in `--print` mode would require forking the Claude CLI or parsing
its internal output format — both out of scope. The SDK proxy path is the correct
integration layer.

## Consequences

- Tool-result turns in SDK/VS Code mode are routed cheaply: `Read` drops to Haiku,
  `Edit` to Sonnet, complex tool calls stay on Sonnet.
- `--print` mode (non-SDK) is unchanged; model is still locked per turn.
- The `TOOL_CLASS` routing table is static. Per-project overrides (C12) are deferred
  to a future iteration; the table covers the common case.
- `tool-override` runs before heuristic/LLM classifiers — zero per-call cost for
  known tools.

## Deferred

Per-project `TOOL_CLASS` overrides via `.maestro/config.json` (C12) — deferred.
Requires `maestro stats` evidence that per-tool savings justify the config surface.
