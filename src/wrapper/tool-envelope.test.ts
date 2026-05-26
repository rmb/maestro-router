// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, test, expect } from "vitest";
import { compressToolEnvelope } from "./tool-envelope.js";

describe("compressToolEnvelope", () => {
  test("C1: collapses Write/Edit file-updated ack", () => {
    const input =
      "The file /abs/path/foo.ts has been updated successfully. (file state is current in your context — no need to Read it back).";
    expect(compressToolEnvelope(input)).toBe("ok u /abs/path/foo.ts");
  });

  test("C1: collapses Write/Edit file-created ack", () => {
    const input =
      "The file /abs/path/new.ts has been created successfully. (file state is current in your context — no need to Read it back).";
    expect(compressToolEnvelope(input)).toBe("ok c /abs/path/new.ts");
  });

  test("C3: collapses TodoWrite ack", () => {
    const input =
      "Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress.";
    expect(compressToolEnvelope(input)).toBe("ok todo");
  });

  test("C2: strips trailing file-state footer on real Read body", () => {
    const input =
      "1\tfunction foo() {\n2\t  return 42;\n3\t}\n\n (file state is current in your context — no need to Read it back).";
    const out = compressToolEnvelope(input);
    expect(out).not.toMatch(/file state is current/);
    expect(out).toMatch(/function foo/);
  });

  test("C6: drops 'Stream closed' noise lines", () => {
    const input =
      "header line\nTool permission request failed: Error: Stream closed\ncontent line";
    const out = compressToolEnvelope(input);
    expect(out).not.toMatch(/Stream closed/);
    expect(out).toMatch(/header line/);
    expect(out).toMatch(/content line/);
  });

  test("idempotent: re-running produces no further change", () => {
    const input =
      "The file /x.ts has been updated successfully. (file state is current in your context — no need to Read it back).";
    const once = compressToolEnvelope(input);
    const twice = compressToolEnvelope(once);
    expect(twice).toBe(once);
  });

  test("preserves content with no envelope match", () => {
    const input = "diff --git a/x b/x\n@@ -1,3 +1,3 @@\n-foo\n+bar\n context";
    expect(compressToolEnvelope(input)).toBe(input);
  });

  test("preserves whitespace inside fenced code", () => {
    const input = "```\n    indented\n```";
    expect(compressToolEnvelope(input)).toBe(input);
  });
});
