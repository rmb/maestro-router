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
