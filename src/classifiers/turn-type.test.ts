// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { detectTurnType, turnTypeClassifier } from "./turn-type.js";
import type { Message, Request } from "../core/types.js";

const call = (req: Request) => turnTypeClassifier.classify(req);

const toolResultReq = (content = "result"): Request => ({
  prompt: content,
  messages: [
    { role: "user", content: "list files" },
    { role: "assistant", content: "okay" },
    { role: "tool", content },
  ],
});

describe("detectTurnType", () => {
  test("no messages, plain prompt → user_prompt", () => {
    expect(detectTurnType({ prompt: "rename foo" })).toBe("user_prompt");
  });

  test("no messages, error-laden prompt → error_recovery", () => {
    expect(
      detectTurnType({
        prompt: "got TypeError: Cannot read property 'x' of undefined",
      }),
    ).toBe("error_recovery");
  });

  test("last role tool → tool_result", () => {
    expect(detectTurnType(toolResultReq())).toBe("tool_result");
  });

  test("last role assistant → continuation", () => {
    expect(
      detectTurnType({
        prompt: "...",
        messages: [{ role: "assistant", content: "thinking" }],
      }),
    ).toBe("continuation");
  });

  test("last role user with error → error_recovery", () => {
    expect(
      detectTurnType({
        prompt: "this fails with Error: ECONNREFUSED",
        messages: [{ role: "user", content: "this fails with Error: ECONNREFUSED" }],
      }),
    ).toBe("error_recovery");
  });

  test("last role user without error → user_prompt", () => {
    expect(
      detectTurnType({
        prompt: "add a function",
        messages: [{ role: "user", content: "add a function" }],
      }),
    ).toBe("user_prompt");
  });

  test("error indicators detected: stack trace", () => {
    expect(detectTurnType({ prompt: "here's the stack trace" })).toBe("error_recovery");
  });

  test("error indicators detected: ECONNREFUSED", () => {
    expect(detectTurnType({ prompt: "ECONNREFUSED on retry" })).toBe("error_recovery");
  });

  test("error indicators detected: 'doesn't work'", () => {
    expect(detectTurnType({ prompt: "it doesn't work" })).toBe("error_recovery");
  });

  test("error indicators detected: 'test failed'", () => {
    expect(detectTurnType({ prompt: "the test failed unexpectedly" })).toBe(
      "error_recovery",
    );
  });

  test("error indicators detected: build failed", () => {
    expect(detectTurnType({ prompt: "build failed: missing module" })).toBe(
      "error_recovery",
    );
  });
});

describe("turnTypeClassifier", () => {
  test("empty prompt → standard @ 1.0 confidence", async () => {
    const result = await call({ prompt: "" });
    expect(result).not.toBeNull();
    expect(result?.class).toBe("standard");
    expect(result?.confidence).toBe(1.0);
    expect(result?.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "turn_type.empty_prompt",
        severity: "info",
      })
    );
  });

  test("whitespace-only prompt → standard @ 1.0 confidence", async () => {
    const result = await call({ prompt: "   \n\t  " });
    expect(result).not.toBeNull();
    expect(result?.class).toBe("standard");
    expect(result?.confidence).toBe(1.0);
  });

  test("non-empty prompt → null (pass through to other classifiers)", async () => {
    const result = await call({ prompt: "hello world" });
    expect(result).toBeNull();
  });

  test("user_prompt → null (let others classify)", async () => {
    expect(await call({ prompt: "rename foo" })).toBeNull();
  });

  test("continuation → null", async () => {
    expect(
      await call({
        prompt: "...",
        messages: [{ role: "assistant", content: "..." }],
      }),
    ).toBeNull();
  });

  test("tool_result without prior tool_use → simple confidence 0.85", async () => {
    const result = await call(toolResultReq());
    expect(result).toMatchObject({ class: "simple", confidence: 0.85 });
  });

  test("tool_result with prior Read tool → trivial", async () => {
    const messages: Message[] = [
      { role: "user", content: "show me index.ts" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "reading" },
          { type: "tool_use", id: "x", name: "Read", input: { path: "index.ts" } },
        ],
      },
      { role: "tool", content: "file contents" },
    ];
    const result = await call({ prompt: "file contents", messages });
    expect(result).toMatchObject({ class: "trivial", confidence: 0.85 });
  });

  test("tool_result with prior Grep tool → trivial", async () => {
    const messages: Message[] = [
      { role: "user", content: "find foo" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "x", name: "Grep", input: { pattern: "foo" } }],
      },
      { role: "tool", content: "23 matches" },
    ];
    const result = await call({ prompt: "23 matches", messages });
    expect(result?.class).toBe("trivial");
  });

  test("tool_result with prior Edit tool → trivial (write tools are structured-output)", async () => {
    const messages: Message[] = [
      { role: "user", content: "edit it" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "x", name: "Edit", input: {} }],
      },
      { role: "tool", content: "edit applied" },
    ];
    const result = await call({ prompt: "edit applied", messages });
    expect(result?.class).toBe("trivial");
  });

  test("tool_result with prior Write tool → trivial", async () => {
    const messages: Message[] = [
      { role: "user", content: "write it" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "x", name: "Write", input: {} }],
      },
      { role: "tool", content: "file written" },
    ];
    const result = await call({ prompt: "file written", messages });
    expect(result?.class).toBe("trivial");
  });

  test("error_recovery → hard confidence 0.7", async () => {
    const result = await call({
      prompt: "got error: TypeError",
    });
    expect(result).toMatchObject({ class: "hard", confidence: 0.7 });
  });

  test("error_recovery streak=2 → reasoning confidence 0.8", async () => {
    const result = await turnTypeClassifier.classify(
      { prompt: "got error: TypeError" },
      { sessionContext: { consecutiveErrorRecoveryCount: 2 } },
    );
    expect(result).toMatchObject({ class: "reasoning", confidence: 0.8 });
    const codes = (result?.diagnostics ?? []).map((d) => d.code);
    expect(codes).toContain("turn_type.error_streak_2");
  });

  test("error_recovery streak=3 → max confidence 0.85", async () => {
    const result = await turnTypeClassifier.classify(
      { prompt: "got error: TypeError" },
      { sessionContext: { consecutiveErrorRecoveryCount: 3 } },
    );
    expect(result).toMatchObject({ class: "max", confidence: 0.85 });
    const codes = (result?.diagnostics ?? []).map((d) => d.code);
    expect(codes).toContain("turn_type.error_streak_3");
  });

  test("error_recovery streak=5 → max confidence 0.85 (streak ≥ 3 all go to max)", async () => {
    const result = await turnTypeClassifier.classify(
      { prompt: "build failed: missing module" },
      { sessionContext: { consecutiveErrorRecoveryCount: 5 } },
    );
    expect(result).toMatchObject({ class: "max", confidence: 0.85 });
  });

  test("non-error prompt with high streak count → null (not error_recovery)", async () => {
    const result = await turnTypeClassifier.classify(
      { prompt: "rename foo to bar" },
      { sessionContext: { consecutiveErrorRecoveryCount: 5 } },
    );
    expect(result).toBeNull();
  });

  test("emits turn_type diagnostic", async () => {
    const result = await call(toolResultReq());
    const codes = (result!.diagnostics ?? []).map((d) => d.code);
    expect(codes).toContain("turn_type.tool_result");
  });
});

describe("turnTypeClassifier property: budget", () => {
  test("classifies 100 prompts well under 30ms each", async () => {
    const start = Date.now();
    for (let i = 0; i < 100; i++) {
      await call({ prompt: `prompt ${i}` });
    }
    const elapsedMs = Date.now() - start;
    // Generous: 100 calls in well under 3s; typically <10ms total
    expect(elapsedMs).toBeLessThan(3000);
  });
});
