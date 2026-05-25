// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { stripLineNumbers } from "./line-stripper.js";

describe("stripLineNumbers", () => {
  test("single line with number → number stripped", () => {
    expect(stripLineNumbers("1\tfunction foo() {")).toBe("function foo() {");
  });

  test("multi-line example → all numbers stripped", () => {
    const input = "1\timport { foo } from 'bar';\n2\texport const x = 1;\n3\tconst y = { a: 1 };";
    const expected = "import { foo } from 'bar';\nexport const x = 1;\nconst y = { a: 1 };";
    expect(stripLineNumbers(input)).toBe(expected);
  });

  test("no line numbers → unchanged", () => {
    const text = "function foo() {\n  return 42;\n}";
    expect(stripLineNumbers(text)).toBe(text);
  });

  test("mixed (some lines with numbers, some without) → only number lines stripped", () => {
    const input = "1\tfoo\nbar\n2\tbaz";
    const expected = "foo\nbar\nbaz";
    expect(stripLineNumbers(input)).toBe(expected);
  });

  test("empty lines preserved", () => {
    const input = "1\tfirst\n\n2\tthird";
    const expected = "first\n\nthird";
    expect(stripLineNumbers(input)).toBe(expected);
  });

  test("large line numbers → stripped", () => {
    expect(stripLineNumbers("42\tline content")).toBe("line content");
    expect(stripLineNumbers("999\tanother line")).toBe("another line");
  });

  test("content that looks like line number but isn't POSIX format → preserved", () => {
    // Missing tab separator
    expect(stripLineNumbers("1 content")).toBe("1 content");
    // Non-digit prefix
    expect(stripLineNumbers("a\tcontent")).toBe("a\tcontent");
    // Tab but no number
    expect(stripLineNumbers("\tcontent")).toBe("\tcontent");
  });

  test("tabs after the number in content preserved", () => {
    expect(stripLineNumbers("1\tfoo\tbar\tbaz")).toBe("foo\tbar\tbaz");
  });

  test("idempotent: running twice gives same result as once", () => {
    const input = "1\tfoo\n2\tbar";
    const once = stripLineNumbers(input);
    const twice = stripLineNumbers(once);
    expect(twice).toBe(once);
  });

  test("real Read tool output example (simulated)", () => {
    const input =
      "     1\timport { foo } from 'bar';\n" +
      "     2\texport const x = 1;\n" +
      "     3\tconst y = { a: 1 };";
    // Note: the mock above uses spaces before digits, but our regex expects
    // just digits. This tests the edge case of whitespace-padded line numbers.
    // Our regex should NOT strip these (they're not ^\d+\t), so they're preserved.
    const result = stripLineNumbers(input);
    // The spaces+number+tab are NOT stripped because the regex expects start-of-line.
    expect(result).toBe(input);
  });

  test("actual Read output with tab separator (no padding)", () => {
    // The Read tool uses `cat -n` which produces: "     1\t..."
    // But the SDK proxy receives this after line parsing, so leading spaces
    // are part of the line content, not line markers. This test ensures we
    // handle the case where the Read tool result is "1\tcontent" (clean digit-tab).
    const input = "1\timport foo;\n2\tconst x = 1;";
    expect(stripLineNumbers(input)).toBe("import foo;\nconst x = 1;");
  });

  test("whitespace only after number+tab preserved", () => {
    expect(stripLineNumbers("1\t   spaces")).toBe("   spaces");
    expect(stripLineNumbers("1\t\ttabs")).toBe("\ttabs");
  });

  test("empty string → empty string", () => {
    expect(stripLineNumbers("")).toBe("");
  });

  test("string with only a line number → empty", () => {
    expect(stripLineNumbers("1\t")).toBe("");
  });

  test("performance: large file with many line numbers", () => {
    const lines: string[] = [];
    for (let i = 1; i <= 1000; i++) {
      lines.push(`${i}\tline content ${i}`);
    }
    const input = lines.join("\n");

    const t0 = performance.now();
    const result = stripLineNumbers(input);
    const t1 = performance.now();

    // Verify correctness
    const resultLines = result.split("\n");
    expect(resultLines).toHaveLength(1000);
    expect(resultLines[0]).toBe("line content 1");
    expect(resultLines[999]).toBe("line content 1000");

    // Budget: <1ms per operation
    expect(t1 - t0).toBeLessThan(1);
  });
});
