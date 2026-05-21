// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { extractJSON } from "./extract.js";

describe("extractJSON", () => {
  test("parses plain JSON object", () => {
    expect(extractJSON('{"a":1}')).toEqual({ a: 1 });
  });

  test("parses plain JSON array", () => {
    expect(extractJSON("[1,2,3]")).toEqual([1, 2, 3]);
  });

  test("extracts from ```json fenced block", () => {
    const text = "Some preamble\n```json\n{\"class\":\"trivial\",\"confidence\":1}\n```\nAfterword";
    expect(extractJSON(text)).toEqual({ class: "trivial", confidence: 1 });
  });

  test("extracts from ``` fenced block without lang tag", () => {
    const text = "Result:\n```\n{\"x\":42}\n```";
    expect(extractJSON(text)).toEqual({ x: 42 });
  });

  test("extracts brace-balanced object from surrounding prose", () => {
    const text = "Here is the answer: {\"foo\":\"bar\"} done.";
    expect(extractJSON(text)).toEqual({ foo: "bar" });
  });

  test("handles nested braces correctly", () => {
    const text = "prefix {\"a\":{\"b\":{\"c\":1}}} suffix";
    expect(extractJSON(text)).toEqual({ a: { b: { c: 1 } } });
  });

  test("ignores braces inside strings", () => {
    const text = 'noise {"key":"value with } and { inside"} tail';
    expect(extractJSON(text)).toEqual({ key: "value with } and { inside" });
  });

  test("ignores escaped quotes inside strings", () => {
    const text = 'x {"k":"he said \\"hi\\""} y';
    expect(extractJSON(text)).toEqual({ k: 'he said "hi"' });
  });

  test("extracts brace-balanced array from prose", () => {
    expect(extractJSON('result is [1, 2, 3] done')).toEqual([1, 2, 3]);
  });

  test("returns null for unmatched brace", () => {
    expect(extractJSON("text {unmatched")).toBeNull();
  });

  test("returns null for empty input", () => {
    expect(extractJSON("")).toBeNull();
  });

  test("returns null for non-JSON content", () => {
    expect(extractJSON("just some prose with no json")).toBeNull();
  });

  test("returns null on invalid JSON inside fenced block (no fallback succeeds)", () => {
    expect(extractJSON("```json\nnot valid json}{[\n```")).toBeNull();
  });

  test("prefers fenced over surrounding braces when both present", () => {
    const text = '{"outer":1} ```json\n{"inner":2}\n```';
    expect(extractJSON(text)).toEqual({ inner: 2 });
  });

  test("falls back to brace-balanced when fenced parse fails", () => {
    const text = "```json\ninvalid\n```\nbut here is {\"real\":true}";
    expect(extractJSON(text)).toEqual({ real: true });
  });

  test("handles whitespace and newlines around content", () => {
    expect(extractJSON("\n\n  {\"a\":1}  \n\n")).toEqual({ a: 1 });
  });

  test("type parameter narrows the return", () => {
    const parsed = extractJSON<{ class: string; confidence: number }>(
      '{"class":"trivial","confidence":1}',
    );
    expect(parsed?.class).toBe("trivial");
    expect(parsed?.confidence).toBe(1);
  });
});
