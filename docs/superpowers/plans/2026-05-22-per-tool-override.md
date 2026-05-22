# Per-tool Profile Overrides — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route tool_result turns to the correct model tier based on which tool was called.

**Architecture:** Track tool_use_id→name in sdk-proxy from assistant stdout frames. When a tool_result user message arrives, look up the tool name and pass it as metadata to a new tool-override classifier that returns conf=1.0 decisions for known tools.

**Tech Stack:** TypeScript strict, ESM, Vitest, Node 20+

---

## Background

Tool_result turns (Read, Grep, LS, Glob, Edit, Write, Bash, Task, WebFetch, etc.) are 40–60% of all turns in a typical VSCode panel session. Currently they receive no per-tool routing:

1. `isUserTextMessage()` only matches text-content user messages. A `tool_result` user message (content block `{type:"tool_result",...}`) passes the `isUserTextMessage` check as `false` and falls straight through to `child.stdin?.write(line + "\n")` — no `set_model` injection.
2. The prior `set_model` from the last user-prompt turn therefore persists. If the user's last prompt was complex (routed to `opus`), every subsequent tool_result also runs on `opus`, even Read/Grep which never need more than Haiku.

The fix has four parts:
- Extend `stream-json-frames.ts` with functions to detect tool_result messages and extract `tool_use_id`s, and to extract `{id, name}` blocks from assistant stdout frames.
- Add a new `tool-override` classifier that reads `metadata.resolvedToolName` and returns `conf=1.0` decisions for known tools.
- Extend `sdk-proxy.ts` to scan assistant stdout frames into a bounded `toolUseMap`, look up tool names on incoming tool_result turns, synthesize a `Request` with `metadata.resolvedToolName`, run it through the pipeline, and inject `set_model` accordingly.
- Wire the new classifier into `buildPipeline()` in `wire-compat.ts`, between `turnTypeClassifier` and `heuristicClassifier`.

---

## Task 1: Extend stream-json-frames.ts

**Files:**
- Modify: `src/wrapper/stream-json-frames.ts`
- Modify: `src/wrapper/stream-json-frames.test.ts`

### Step 1.1 — Write failing tests

- [ ] Add the following tests to `src/wrapper/stream-json-frames.test.ts`:

```typescript
// Append to: src/wrapper/stream-json-frames.test.ts
// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import {
  isToolResultMessage,
  extractToolUseIds,
  extractToolUseBlocks,
} from "./stream-json-frames.js";

describe("isToolResultMessage", () => {
  test("returns true for user frame whose content contains a tool_result block", () => {
    const f = parseFrame(
      '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01","content":"file contents"}]}}',
    )!;
    expect(isToolResultMessage(f)).toBe(true);
  });

  test("returns false for a text-only user message", () => {
    const f = parseFrame(
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}',
    )!;
    expect(isToolResultMessage(f)).toBe(false);
  });

  test("returns false for a non-user frame", () => {
    const f = parseFrame(
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}',
    )!;
    expect(isToolResultMessage(f)).toBe(false);
  });

  test("returns false for a user frame with no message", () => {
    const f = parseFrame('{"type":"user"}')!;
    expect(isToolResultMessage(f)).toBe(false);
  });

  test("returns true when tool_result appears alongside a text block", () => {
    const f = parseFrame(
      '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_02","content":"data"},{"type":"text","text":"note"}]}}',
    )!;
    expect(isToolResultMessage(f)).toBe(true);
  });
});

describe("extractToolUseIds", () => {
  test("returns array of tool_use_id strings from tool_result blocks", () => {
    const f = parseFrame(
      '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01","content":"res"}]}}',
    )!;
    expect(extractToolUseIds(f)).toEqual(["toolu_01"]);
  });

  test("returns multiple ids when multiple tool_result blocks are present", () => {
    const f = parseFrame(
      '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01","content":"a"},{"type":"tool_result","tool_use_id":"toolu_02","content":"b"}]}}',
    )!;
    expect(extractToolUseIds(f)).toEqual(["toolu_01", "toolu_02"]);
  });

  test("returns empty array for a text-only user message", () => {
    const f = parseFrame(
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}',
    )!;
    expect(extractToolUseIds(f)).toEqual([]);
  });

  test("returns empty array when content is absent", () => {
    const f = parseFrame('{"type":"user","message":{}}')!;
    expect(extractToolUseIds(f)).toEqual([]);
  });
});

describe("extractToolUseBlocks", () => {
  test("returns id+name pairs from tool_use blocks in an assistant frame", () => {
    const f = parseFrame(
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_01","name":"Read","input":{"path":"index.ts"}}]}}',
    )!;
    expect(extractToolUseBlocks(f)).toEqual([{ id: "toolu_01", name: "Read" }]);
  });

  test("returns multiple entries when multiple tool_use blocks are present", () => {
    const f = parseFrame(
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_01","name":"Read","input":{}},{"type":"tool_use","id":"toolu_02","name":"Grep","input":{}}]}}',
    )!;
    expect(extractToolUseBlocks(f)).toEqual([
      { id: "toolu_01", name: "Read" },
      { id: "toolu_02", name: "Grep" },
    ]);
  });

  test("returns empty array for a non-assistant frame", () => {
    const f = parseFrame(
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}',
    )!;
    expect(extractToolUseBlocks(f)).toEqual([]);
  });

  test("returns empty array when content contains no tool_use blocks", () => {
    const f = parseFrame(
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I will now read…"}]}}',
    )!;
    expect(extractToolUseBlocks(f)).toEqual([]);
  });

  test("skips tool_use blocks missing id or name", () => {
    const f = parseFrame(
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_01"},{"type":"tool_use","name":"Read"},{"type":"tool_use","id":"toolu_03","name":"Glob","input":{}}]}}',
    )!;
    expect(extractToolUseBlocks(f)).toEqual([{ id: "toolu_03", name: "Glob" }]);
  });
});
```

Run and confirm all new tests fail:

```bash
pnpm test src/wrapper/stream-json-frames.test.ts
# Expected: 3 new describe blocks fail with "is not a function" import errors
```

### Step 1.2 — Implement the three new functions

- [ ] Add to `src/wrapper/stream-json-frames.ts` (after `matchesInjectedRequestId`):

```typescript
// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

/** A user-role message whose content array contains at least one tool_result block. */
export function isToolResultMessage(frame: Frame): boolean {
  if (frame.type !== "user") return false;
  const message = frame.message;
  if (typeof message !== "object" || message === null) return false;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return false;
  return content.some(
    (b) =>
      typeof b === "object" &&
      b !== null &&
      (b as { type?: unknown }).type === "tool_result",
  );
}

/** Extract tool_use_id strings from all tool_result blocks in a user frame. */
export function extractToolUseIds(frame: Frame): string[] {
  const message = frame.message;
  if (typeof message !== "object" || message === null) return [];
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  const ids: string[] = [];
  for (const b of content) {
    if (
      typeof b === "object" &&
      b !== null &&
      (b as { type?: unknown }).type === "tool_result" &&
      typeof (b as { tool_use_id?: unknown }).tool_use_id === "string"
    ) {
      ids.push((b as { tool_use_id: string }).tool_use_id);
    }
  }
  return ids;
}

/** Extract {id, name} pairs from all tool_use blocks in an assistant frame. */
export function extractToolUseBlocks(frame: Frame): Array<{ id: string; name: string }> {
  if (frame.type !== "assistant") return [];
  const message = frame.message;
  if (typeof message !== "object" || message === null) return [];
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  const blocks: Array<{ id: string; name: string }> = [];
  for (const b of content) {
    if (
      typeof b === "object" &&
      b !== null &&
      (b as { type?: unknown }).type === "tool_use" &&
      typeof (b as { id?: unknown }).id === "string" &&
      typeof (b as { name?: unknown }).name === "string"
    ) {
      blocks.push({
        id: (b as { id: string }).id,
        name: (b as { name: string }).name,
      });
    }
  }
  return blocks;
}
```

### Step 1.3 — Run tests and verify

- [ ] Run:
```bash
pnpm typecheck && pnpm lint && pnpm test src/wrapper/stream-json-frames.test.ts
# Expected output: all tests pass, 0 failures
```

### Step 1.4 — Commit

- [ ] Commit:
```bash
git add src/wrapper/stream-json-frames.ts src/wrapper/stream-json-frames.test.ts
git commit -m "frames: add isToolResultMessage, extractToolUseIds, extractToolUseBlocks"
```

---

## Task 2: Create tool-override classifier

**Files:**
- Create: `src/classifiers/tool-override.ts`
- Create: `src/classifiers/tool-override.test.ts`

### Step 2.1 — Write failing tests

- [ ] Create `src/classifiers/tool-override.test.ts`:

```typescript
// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { toolOverrideClassifier } from "./tool-override.js";
import type { Request } from "../core/types.js";

function req(toolName: string | null): Request {
  const r: Request = { prompt: "" };
  if (toolName !== null) {
    r.metadata = { resolvedToolName: toolName };
  }
  return r;
}

describe("toolOverrideClassifier — read-only filesystem tools → trivial", () => {
  test.each(["Read", "Glob", "Grep", "LS"])("%s → trivial conf 1.0", async (tool) => {
    const result = await toolOverrideClassifier.classify(req(tool));
    expect(result).toMatchObject({ class: "trivial", confidence: 1.0 });
  });
});

describe("toolOverrideClassifier — write tools → simple", () => {
  test.each(["Edit", "Write", "MultiEdit", "NotebookEdit"])("%s → simple conf 1.0", async (tool) => {
    const result = await toolOverrideClassifier.classify(req(tool));
    expect(result).toMatchObject({ class: "simple", confidence: 1.0 });
  });
});

describe("toolOverrideClassifier — execution tools → simple", () => {
  test("Bash → simple conf 1.0", async () => {
    const result = await toolOverrideClassifier.classify(req("Bash"));
    expect(result).toMatchObject({ class: "simple", confidence: 1.0 });
  });
});

describe("toolOverrideClassifier — agentic / network tools → standard", () => {
  test.each(["Task", "WebFetch", "WebSearch"])("%s → standard conf 1.0", async (tool) => {
    const result = await toolOverrideClassifier.classify(req(tool));
    expect(result).toMatchObject({ class: "standard", confidence: 1.0 });
  });
});

describe("toolOverrideClassifier — unknown / null tool → null (pipeline fallback)", () => {
  test("null resolvedToolName → null", async () => {
    expect(await toolOverrideClassifier.classify(req(null))).toBeNull();
  });

  test("no metadata at all → null", async () => {
    expect(await toolOverrideClassifier.classify({ prompt: "" })).toBeNull();
  });

  test("unknown tool name → null", async () => {
    expect(await toolOverrideClassifier.classify(req("UnknownTool"))).toBeNull();
  });

  test("empty string → null", async () => {
    expect(await toolOverrideClassifier.classify(req(""))).toBeNull();
  });
});

describe("toolOverrideClassifier — diagnostics", () => {
  test("emits tool_override.<toolName> diagnostic code on a match", async () => {
    const result = await toolOverrideClassifier.classify(req("Read"));
    const codes = (result?.diagnostics ?? []).map((d) => d.code);
    expect(codes).toContain("tool_override.Read");
  });

  test("no diagnostics on null return", async () => {
    expect(await toolOverrideClassifier.classify(req("Unknown"))).toBeNull();
  });
});

describe("toolOverrideClassifier — budget", () => {
  test("classifies 1000 tool_result requests in under 100ms total", async () => {
    const tools = ["Read", "Grep", "Edit", "Bash", "Task", "Unknown"];
    const start = Date.now();
    for (let i = 0; i < 1000; i++) {
      await toolOverrideClassifier.classify(req(tools[i % tools.length]!));
    }
    expect(Date.now() - start).toBeLessThan(100);
  });
});
```

Run and confirm all new tests fail:

```bash
pnpm test src/classifiers/tool-override.test.ts
# Expected: fails with "Cannot find module './tool-override.js'"
```

### Step 2.2 — Implement the classifier

- [ ] Create `src/classifiers/tool-override.ts`:

```typescript
// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0
// budget: 1ms

import { createClassifier } from "../core/classifier.js";
import type { Class, ClassifyFn, Request } from "../core/types.js";

/**
 * Per-tool routing table. Keys are exact tool names as returned by
 * the Claude API's tool_use content blocks.
 *
 * Routing rationale:
 *   trivial  — pure reads; no generation needed; Haiku more than sufficient.
 *   simple   — structured writes / shell execs; deterministic, short output.
 *   standard — agentic / network tools; may require multi-step reasoning.
 */
const TOOL_CLASS: ReadonlyMap<string, Class> = new Map([
  ["Read", "trivial"],
  ["Glob", "trivial"],
  ["Grep", "trivial"],
  ["LS", "trivial"],
  ["Edit", "simple"],
  ["Write", "simple"],
  ["MultiEdit", "simple"],
  ["NotebookEdit", "simple"],
  ["Bash", "simple"],
  ["Task", "standard"],
  ["WebFetch", "standard"],
  ["WebSearch", "standard"],
]);

const classify: ClassifyFn = (req: Request) => {
  const toolName = req.metadata?.resolvedToolName;
  if (typeof toolName !== "string" || toolName.length === 0) return null;
  const cls = TOOL_CLASS.get(toolName);
  if (cls === undefined) return null;
  return {
    class: cls,
    confidence: 1.0,
    diagnostics: [
      { severity: "info", code: `tool_override.${toolName}`, message: toolName },
    ],
  };
};

export const toolOverrideClassifier = createClassifier({
  name: "tool-override",
  weight: 1.0,
  classify,
});
```

### Step 2.3 — Run tests and verify

- [ ] Run:
```bash
pnpm typecheck && pnpm lint && pnpm test src/classifiers/tool-override.test.ts
# Expected output: all tests pass, 0 failures
```

### Step 2.4 — Commit

- [ ] Commit:
```bash
git add src/classifiers/tool-override.ts src/classifiers/tool-override.test.ts
git commit -m "classifiers: add tool-override classifier (conf=1.0 per-tool routing)"
```

---

## Task 3: Extend sdk-proxy.ts with tool_use tracking and tool_result routing

**Files:**
- Modify: `src/wrapper/sdk-proxy.ts`
- Modify: `src/wrapper/sdk-proxy.test.ts`

### Step 3.1 — Write failing tests

- [ ] Add the following test suites to `src/wrapper/sdk-proxy.test.ts`:

```typescript
// Append to: src/wrapper/sdk-proxy.test.ts

describe("runSdkProxy — tool_result routing via toolUseMap", () => {
  test("reads tool name from assistant stdout frame and injects set_model for subsequent tool_result", async () => {
    const tel = mockTelemetry();
    const out = collectorStream();
    const stderr = collectorStream();
    const fc = fakeChild([]);

    // Pipeline: Read → trivial (haiku), anything else → standard (sonnet).
    const pipeline: Pipeline = {
      route: async (req) => {
        const tool = req.metadata?.resolvedToolName;
        return decisionFor(tool === "Read" ? "trivial" : "standard");
      },
    };

    // Sequence: assistant emits tool_use(Read), then host sends tool_result.
    const assistantLine =
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_01","name":"Read","input":{"path":"index.ts"}}]}}';
    const toolResultLine =
      '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01","content":"file contents"}]}}';

    const proxyP = runSdkProxy({
      realClaude: "node",
      claudeArgs: [],
      pipeline,
      profile: balancedProfile,
      userConfig: {},
      telemetry: tel.writer,
      stdin: Readable.from([toolResultLine + "\n"]),
      stdout: out.stream,
      stderr: stderr.stream,
      spawn: fc.spawn,
    });

    // Emit the assistant frame from child stdout BEFORE the tool_result arrives.
    // In real usage the child processes the tool_use and we get the result on stdin.
    // In tests we emit on child stdout before closing.
    fc.emit(assistantLine);
    fc.close(0);
    await proxyP;

    // The proxy should have injected set_model (haiku) then the tool_result frame.
    expect(fc.stdinWrites).toHaveLength(2);
    const setModel = JSON.parse(fc.stdinWrites[0]!.trim()) as {
      type: string;
      request: { subtype: string; model: string };
    };
    expect(setModel.type).toBe("control_request");
    expect(setModel.request.subtype).toBe("set_model");
    expect(setModel.request.model).toBe(balancedProfile.classes.trivial.model); // haiku

    const forwarded = JSON.parse(fc.stdinWrites[1]!.trim()) as { type: string };
    expect(forwarded.type).toBe("user");
  });

  test("tool_result with unknown tool_use_id falls back to pipeline without metadata", async () => {
    const tel = mockTelemetry();
    const out = collectorStream();
    const stderr = collectorStream();
    const fc = fakeChild([]);

    const routeCalls: Array<import("../core/types.js").Request> = [];
    const pipeline: Pipeline = {
      route: async (req) => {
        routeCalls.push(req);
        return decisionFor("standard");
      },
    };

    // tool_result referencing an id that never appeared in assistant stdout.
    const toolResultLine =
      '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"unknown-id","content":"data"}]}}';

    setTimeout(() => fc.close(0), 10);

    await runSdkProxy({
      realClaude: "node",
      claudeArgs: [],
      pipeline,
      profile: balancedProfile,
      userConfig: {},
      telemetry: tel.writer,
      stdin: Readable.from([toolResultLine + "\n"]),
      stdout: out.stream,
      stderr: stderr.stream,
      spawn: fc.spawn,
    });

    // Pipeline must have been called with no resolvedToolName.
    expect(routeCalls).toHaveLength(1);
    expect(routeCalls[0]!.metadata?.resolvedToolName).toBeUndefined();

    // set_model + tool_result frame forwarded.
    expect(fc.stdinWrites).toHaveLength(2);
  });

  test("toolUseMap evicts oldest entry when size exceeds 50", async () => {
    const tel = mockTelemetry();
    const out = collectorStream();
    const stderr = collectorStream();
    const fc = fakeChild([]);

    const routeCalls: Array<import("../core/types.js").Request> = [];
    const pipeline: Pipeline = {
      route: async (req) => {
        routeCalls.push(req);
        return decisionFor("standard");
      },
    };

    // Emit 51 assistant frames, each with a different tool_use id.
    // The first one ("toolu_00") should be evicted before we send its tool_result.
    const proxyP = runSdkProxy({
      realClaude: "node",
      claudeArgs: [],
      pipeline,
      profile: balancedProfile,
      userConfig: {},
      telemetry: tel.writer,
      stdin: Readable.from([
        '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_00","content":"data"}]}}\n',
      ]),
      stdout: out.stream,
      stderr: stderr.stream,
      spawn: fc.spawn,
    });

    // Emit 51 assistant frames with unique ids; toolu_00 through toolu_50.
    for (let i = 0; i <= 50; i++) {
      fc.emit(
        `{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_${i.toString().padStart(2,"0")}","name":"Read","input":{}}]}}`,
      );
    }
    fc.close(0);
    await proxyP;

    // toolu_00 was evicted; pipeline receives no resolvedToolName.
    expect(routeCalls).toHaveLength(1);
    expect(routeCalls[0]!.metadata?.resolvedToolName).toBeUndefined();
  });

  test("tool_result logging records a decision event", async () => {
    const tel = mockTelemetry();
    const out = collectorStream();
    const stderr = collectorStream();
    const fc = fakeChild([]);

    const assistantLine =
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_01","name":"Grep","input":{}}]}}';
    const toolResultLine =
      '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01","content":"12 matches"}]}}';

    const proxyP = runSdkProxy({
      realClaude: "node",
      claudeArgs: [],
      pipeline: mockPipeline("trivial"),
      profile: balancedProfile,
      userConfig: {},
      telemetry: tel.writer,
      stdin: Readable.from([toolResultLine + "\n"]),
      stdout: out.stream,
      stderr: stderr.stream,
      spawn: fc.spawn,
    });

    fc.emit(assistantLine);
    fc.close(0);
    await proxyP;

    expect(tel.events).toHaveLength(1);
    expect(tel.events[0]!.type).toBe("decision");
  });

  test("non-tool-result user message is not affected by toolUseMap logic", async () => {
    const tel = mockTelemetry();
    const out = collectorStream();
    const stderr = collectorStream();
    const fc = fakeChild([]);

    const routeCalls: Array<import("../core/types.js").Request> = [];
    const pipeline: Pipeline = {
      route: async (req) => {
        routeCalls.push(req);
        return decisionFor("standard");
      },
    };

    const userLine =
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"explain this"}]}}';

    setTimeout(() => fc.close(0), 10);

    await runSdkProxy({
      realClaude: "node",
      claudeArgs: [],
      pipeline,
      profile: balancedProfile,
      userConfig: {},
      telemetry: tel.writer,
      stdin: Readable.from([userLine + "\n"]),
      stdout: out.stream,
      stderr: stderr.stream,
      spawn: fc.spawn,
    });

    // Normal user-text path: prompt passed, no resolvedToolName.
    expect(routeCalls).toHaveLength(1);
    expect(routeCalls[0]!.metadata?.resolvedToolName).toBeUndefined();
    expect(routeCalls[0]!.prompt).toBe("explain this");
  });
});
```

Run and confirm the new describe block fails:

```bash
pnpm test src/wrapper/sdk-proxy.test.ts
# Expected: existing tests still pass; new "tool_result routing" tests fail
```

### Step 3.2 — Implement tool_use tracking and tool_result routing in sdk-proxy.ts

- [ ] Replace `src/wrapper/sdk-proxy.ts` with:

```typescript
// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0
//
// SDK-aware bidirectional stream-json proxy. Speaks the Claude Code SDK
// control protocol: passes initialize / MCP / hook / etc. control frames
// through to a long-running real claude subprocess, intercepts user text
// messages to inject a set_model control_request based on the pipeline's
// routing decision, and filters our injected control_responses out of
// the SDK-host-facing stdout.
//
// Per-tool routing (C12): when an assistant frame contains tool_use blocks,
// we record tool_use_id → tool_name in a bounded map. When the host later
// sends a tool_result user message, we look up the tool name and inject it
// as metadata.resolvedToolName into the Request so the tool-override
// classifier can return conf=1.0 decisions for known tools.

import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { Pipeline } from "../core/pipeline.js";
import type { TelemetryWriter } from "../core/telemetry.js";
import { PROMPT_TRUNCATE_CHARS } from "../core/types.js";
import type { Decision, Profile, UserConfig } from "../core/types.js";
import {
  buildSetModelRequest,
  extractPromptText,
  extractToolUseBlocks,
  extractToolUseIds,
  isToolResultMessage,
  isUserTextMessage,
  matchesInjectedRequestId,
  parseFrame,
} from "./stream-json-frames.js";

export type SdkProxySpawn = (
  binary: string,
  args: ReadonlyArray<string>,
) => ChildProcess;

export type SdkProxyOptions = {
  realClaude: string;
  claudeArgs: ReadonlyArray<string>;
  pipeline: Pipeline;
  profile: Profile;
  userConfig: UserConfig;
  telemetry: TelemetryWriter;
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  /** Injectable spawn for tests. Defaults to node:child_process.spawn. */
  spawn?: SdkProxySpawn;
};

const defaultSpawn: SdkProxySpawn = (binary, args) =>
  nodeSpawn(binary, [...args], { stdio: ["pipe", "pipe", "pipe"] });

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s;
}

/** Maximum number of tool_use_id entries to keep in the tracking map. */
const TOOL_USE_MAP_MAX = 50;

export async function runSdkProxy(opts: SdkProxyOptions): Promise<number> {
  const spawn = opts.spawn ?? defaultSpawn;
  const child = spawn(opts.realClaude, opts.claudeArgs);

  let injectedSeq = 0;
  let exitCode = 0;

  /**
   * Maps tool_use_id → tool_name, populated from assistant stdout frames.
   * Bounded to TOOL_USE_MAP_MAX entries; oldest entry evicted on overflow.
   * Used to resolve which tool triggered each tool_result turn on stdin.
   */
  const toolUseMap = new Map<string, string>();

  // ── stdout: filter our injected control_responses, populate toolUseMap
  // from assistant frames, forward everything else.
  if (child.stdout) {
    child.stdout.setEncoding("utf8");
    let buf = "";
    child.stdout.on("data", (chunk: string) => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const frame = parseFrame(line);
        if (frame !== null) {
          if (matchesInjectedRequestId(frame)) continue;
          // Track tool_use blocks from assistant frames for per-tool routing.
          const toolUseBlocks = extractToolUseBlocks(frame);
          for (const { id, name } of toolUseBlocks) {
            if (toolUseMap.size >= TOOL_USE_MAP_MAX) {
              // Evict the oldest entry (Map preserves insertion order).
              const firstKey = toolUseMap.keys().next().value;
              if (firstKey !== undefined) toolUseMap.delete(firstKey);
            }
            toolUseMap.set(id, name);
          }
        }
        opts.stdout.write(line + "\n");
      }
    });
  }

  if (child.stderr) {
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => opts.stderr.write(chunk));
  }

  // ── child lifecycle: capture exit code, propagate to caller.
  const closed = new Promise<void>((resolve) => {
    child.on("close", (code) => {
      exitCode = code ?? 0;
      resolve();
    });
  });

  // ── stdin: parse line-by-line, intercept user text messages and
  // tool_result messages, forward everything else.
  const rl = readline.createInterface({ input: opts.stdin, crlfDelay: Infinity });

  for await (const line of rl) {
    const frame = parseFrame(line);

    if (frame !== null && isUserTextMessage(frame)) {
      const promptText = extractPromptText(frame) ?? "";
      const t0 = Date.now();

      // Slash commands (/model, /clear, /compact, etc.) are interactive
      // directives handled by the SDK host. Don't classify them, and
      // don't inject set_model — they should reach the SDK host's command
      // handler unmodified.
      if (promptText.startsWith("/")) {
        child.stdin?.write(line + "\n");
        continue;
      }

      const decision: Decision = await opts.pipeline.route({ prompt: promptText });

      // Inject set_model BEFORE forwarding the user message so claude
      // honors the new model on this turn.
      injectedSeq += 1;
      const setModel = buildSetModelRequest(decision.spec.model, injectedSeq);
      child.stdin?.write(JSON.stringify(setModel) + "\n");
      child.stdin?.write(line + "\n");

      try {
        await opts.telemetry.log({
          type: "decision",
          ts: new Date().toISOString(),
          decision: { ...decision, latencyMs: Date.now() - t0 },
          prompt: truncate(promptText, PROMPT_TRUNCATE_CHARS),
        });
      } catch { /* telemetry must never block routing */ }

      continue;
    }

    if (frame !== null && isToolResultMessage(frame)) {
      const t0 = Date.now();

      // Resolve the tool name from the first tool_use_id in this result frame.
      // In practice a tool_result carries exactly one tool_use_id, but we
      // defensively read the first populated id.
      const ids = extractToolUseIds(frame);
      const resolvedToolName =
        ids.length > 0 ? toolUseMap.get(ids[0]!) : undefined;

      const request = {
        prompt: "",
        metadata:
          resolvedToolName !== undefined
            ? { resolvedToolName }
            : undefined,
      };

      const decision: Decision = await opts.pipeline.route(request);

      injectedSeq += 1;
      const setModel = buildSetModelRequest(decision.spec.model, injectedSeq);
      child.stdin?.write(JSON.stringify(setModel) + "\n");
      child.stdin?.write(line + "\n");

      try {
        await opts.telemetry.log({
          type: "decision",
          ts: new Date().toISOString(),
          decision: { ...decision, latencyMs: Date.now() - t0 },
        });
      } catch { /* telemetry must never block routing */ }

      continue;
    }

    // Control frame, assistant message, result, anything else: pass through.
    child.stdin?.write(line + "\n");
  }

  // Stdin closed by caller — end the child's stdin to let it terminate.
  child.stdin?.end();

  await closed;
  return exitCode;
}
```

### Step 3.3 — Run tests and verify

- [ ] Run:
```bash
pnpm typecheck && pnpm lint && pnpm test src/wrapper/sdk-proxy.test.ts
# Expected output: all tests pass (existing + new), 0 failures
```

### Step 3.4 — Commit

- [ ] Commit:
```bash
git add src/wrapper/sdk-proxy.ts src/wrapper/sdk-proxy.test.ts
git commit -m "proxy: track tool_use_id→name from stdout, route tool_result turns per tool"
```

---

## Task 4: Wire tool-override into pipeline in wire-compat.ts

**Files:**
- Modify: `src/cli/wire-compat.ts`
- Modify: `src/cli/wire-compat.test.ts` (if present) or integration smoke test

### Step 4.1 — Write failing integration test (pipeline order)

The `buildPipeline` function is not exported, so we test the observable effect: a tool_result turn with a known tool name must route to the expected model tier without needing a full integration harness. We verify by inspecting that `toolOverrideClassifier` is present in the classifier list via the pipeline's behaviour rather than its internals.

The simplest test is a unit check that the new classifier is reachable from the pipeline built by `buildPipeline`. Since `buildPipeline` is not exported, add a narrow export of the classifier list for test introspection, or test via the pipeline routing a synthetic Request.

- [ ] Add to `src/cli/wire-compat.test.ts` (create if absent):

```typescript
// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { toolOverrideClassifier } from "../classifiers/tool-override.js";
import { overrideClassifier } from "../classifiers/override.js";
import { turnTypeClassifier } from "../classifiers/turn-type.js";
import { heuristicClassifier } from "../classifiers/heuristic.js";
import { createPipeline } from "../core/pipeline.js";
import { balancedProfile } from "../core/profile.js";
import type { Request } from "../core/types.js";

/**
 * Smoke test: build the same classifier ordering that buildPipeline uses
 * and verify a tool_result request with resolvedToolName=Read routes to trivial.
 */
describe("wire-compat pipeline ordering — tool-override inserted", () => {
  test("Read tool_result request routes to trivial class via toolOverrideClassifier", async () => {
    const classifiers = [
      overrideClassifier,
      turnTypeClassifier,
      toolOverrideClassifier,
      heuristicClassifier,
    ];
    const pipeline = createPipeline({ classifiers, profile: balancedProfile });
    const req: Request = {
      prompt: "",
      metadata: { resolvedToolName: "Read" },
    };
    const decision = await pipeline.route(req);
    expect(decision.class).toBe("trivial");
    expect(decision.classifier).toBe("tool-override");
  });

  test("Task tool_result request routes to standard class", async () => {
    const classifiers = [
      overrideClassifier,
      turnTypeClassifier,
      toolOverrideClassifier,
      heuristicClassifier,
    ];
    const pipeline = createPipeline({ classifiers, profile: balancedProfile });
    const req: Request = {
      prompt: "",
      metadata: { resolvedToolName: "Task" },
    };
    const decision = await pipeline.route(req);
    expect(decision.class).toBe("standard");
    expect(decision.classifier).toBe("tool-override");
  });

  test("user prompt without metadata falls through to heuristic", async () => {
    const classifiers = [
      overrideClassifier,
      turnTypeClassifier,
      toolOverrideClassifier,
      heuristicClassifier,
    ];
    const pipeline = createPipeline({ classifiers, profile: balancedProfile });
    const req: Request = { prompt: "rename this function" };
    const decision = await pipeline.route(req);
    // turnType and toolOverride both return null; heuristic or default wins.
    expect(decision.classifier).not.toBe("tool-override");
  });
});
```

Run and confirm the tests pass (they test the classifier composition directly, not the unexported `buildPipeline`):

```bash
pnpm test src/cli/wire-compat.test.ts
# Expected: passes — the classifier composition logic is already correct.
```

### Step 4.2 — Wire into buildPipeline

- [ ] In `src/cli/wire-compat.ts`, add the import and insert the classifier:

Change the import block — add `toolOverrideClassifier`:

```typescript
import { toolOverrideClassifier } from "../classifiers/tool-override.js";
```

Change `buildPipeline` — insert `toolOverrideClassifier` between `turnTypeClassifier` and `heuristic`:

```typescript
// Before:
const classifiers: Classifier[] = [overrideClassifier, turnTypeClassifier, heuristic];

// After:
const classifiers: Classifier[] = [overrideClassifier, turnTypeClassifier, toolOverrideClassifier, heuristic];
```

The full modified `buildPipeline` function (for unambiguous diff):

```typescript
function buildPipeline(cli: LoadedCliConfig): { pipeline: Pipeline; profile: Profile } {
  const { profile } = loadProfile({ userConfig: cli.userConfig, overrides: cli.profileOverrides });
  const heuristic =
    cli.userHeuristics.length > 0
      ? createHeuristicClassifier({ extraRules: cli.userHeuristics })
      : heuristicClassifier;
  const classifiers: Classifier[] = [
    overrideClassifier,
    turnTypeClassifier,
    toolOverrideClassifier,
    heuristic,
  ];
  if (cli.userConfig.useEmbeddingClassifier !== false) classifiers.push(embeddingClassifier);
  // Wrapper-hot-path discipline: the LLM stage adds 13-20s of cold-call
  // latency and ~$0.04 of cache_creation cost per VSCode prompt. With
  // VSCode's 60s subprocess-init deadline, that's too tight a margin and
  // caused real timeouts in production. Heuristic + embedding + the
  // pipeline default-class fallback cover the wrapper case well enough;
  // the LLM stage stays available for `bench --llm` / `tune` where
  // accuracy matters more than latency. Opt back in with
  // useLlmClassifierInWrapper: true.
  if (cli.userConfig.useLlmClassifierInWrapper === true) classifiers.push(llmClassifier);
  return { pipeline: createPipeline({ classifiers, profile }), profile };
}
```

### Step 4.3 — Run full test suite

- [ ] Run:
```bash
pnpm typecheck && pnpm lint && pnpm test
# Expected output: all tests pass, 0 failures
```

### Step 4.4 — Commit

- [ ] Commit:
```bash
git add src/cli/wire-compat.ts src/cli/wire-compat.test.ts
git commit -m "wire-compat: insert tool-override classifier between turn-type and heuristic"
```

---

## Final verification

- [ ] Run the full suite one last time:
```bash
pnpm typecheck && pnpm lint && pnpm test
# All green, zero failures.
```

- [ ] Confirm the 4 commits landed:
```bash
git log --oneline -5
# Expected tail:
#   wire-compat: insert tool-override classifier between turn-type and heuristic
#   proxy: track tool_use_id→name from stdout, route tool_result turns per tool
#   classifiers: add tool-override classifier (conf=1.0 per-tool routing)
#   frames: add isToolResultMessage, extractToolUseIds, extractToolUseBlocks
```

---

## Summary of changes

| File | Change |
|------|--------|
| `src/wrapper/stream-json-frames.ts` | +3 exported functions: `isToolResultMessage`, `extractToolUseIds`, `extractToolUseBlocks` |
| `src/wrapper/stream-json-frames.test.ts` | +3 describe blocks covering all new functions |
| `src/classifiers/tool-override.ts` | New file: `toolOverrideClassifier` with 12 tool entries, conf=1.0 |
| `src/classifiers/tool-override.test.ts` | New file: full test coverage including budget test |
| `src/wrapper/sdk-proxy.ts` | Add `toolUseMap` (bounded at 50); scan assistant stdout frames; route tool_result turns |
| `src/wrapper/sdk-proxy.test.ts` | +5 tests in new "tool_result routing via toolUseMap" describe block |
| `src/cli/wire-compat.ts` | Add import; insert `toolOverrideClassifier` in `buildPipeline` |
| `src/cli/wire-compat.test.ts` | New file (or addendum): 3 integration smoke tests for pipeline ordering |

**Cost impact:** zero per-call overhead. `toolOverrideClassifier` is a pure synchronous Map lookup (~0ms). It fires before the heuristic and embedding classifiers, short-circuiting at conf=1.0 for all known tools. Tool_result turns that previously inherited the prior user-prompt model now route to Haiku (trivial tools) or Sonnet (simple/standard tools), cutting per-turn cost for the dominant turn type in VSCode sessions.
