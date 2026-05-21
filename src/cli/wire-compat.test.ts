// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { extractFirstUserPrompt } from "./wire-compat.js";

const userTurn = (text: string): string =>
  JSON.stringify({ type: "user", message: { content: [{ type: "text", text }] } });

const toolResult = (): string =>
  JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] } });

const systemInit = (): string =>
  JSON.stringify({ type: "system", subtype: "init", session_id: "abc" });

const assistantMsg = (): string =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } });

describe("extractFirstUserPrompt", () => {
  test("returns null for empty string", () => {
    expect(extractFirstUserPrompt("")).toBeNull();
  });

  test("returns null when no user turn present", () => {
    const raw = [systemInit(), assistantMsg()].join("\n");
    expect(extractFirstUserPrompt(raw)).toBeNull();
  });

  test("extracts text from first user turn", () => {
    const raw = [systemInit(), userTurn("what is 2+2?")].join("\n");
    expect(extractFirstUserPrompt(raw)).toBe("what is 2+2?");
  });

  test("skips non-text content blocks (tool_result) and finds the user text turn", () => {
    const raw = [toolResult(), userTurn("follow-up question")].join("\n");
    expect(extractFirstUserPrompt(raw)).toBe("follow-up question");
  });

  test("skips assistant and system lines", () => {
    const raw = [systemInit(), assistantMsg(), userTurn("hello world")].join("\n");
    expect(extractFirstUserPrompt(raw)).toBe("hello world");
  });

  test("skips malformed JSON lines without throwing", () => {
    const raw = ["not json", "{bad", userTurn("clean prompt")].join("\n");
    expect(extractFirstUserPrompt(raw)).toBe("clean prompt");
  });

  test("returns first user text even when multiple user turns are present", () => {
    const raw = [userTurn("first"), userTurn("second")].join("\n");
    expect(extractFirstUserPrompt(raw)).toBe("first");
  });

  test("handles user turn with multiple content blocks, picks the text one", () => {
    const mixed = JSON.stringify({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "y", content: "done" },
          { type: "text", text: "and now this question" },
        ],
      },
    });
    expect(extractFirstUserPrompt(mixed)).toBe("and now this question");
  });
});
