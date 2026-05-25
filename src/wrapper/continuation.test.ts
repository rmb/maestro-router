// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, test, expect } from "vitest";
import { detectContinuation, CONTINUATION_HINT } from "./continuation.js";

describe("detectContinuation", () => {
  // Both signals present → detected
  test('"continue" + max_tokens → detected', () => {
    const result = detectContinuation("continue", "max_tokens");
    expect(result).not.toBeNull();
    expect(result?.isContinuation).toBe(true);
    expect(result?.hint).toBe(CONTINUATION_HINT);
  });

  test('"keep going" + max_tokens → detected', () => {
    const result = detectContinuation("keep going", "max_tokens");
    expect(result).not.toBeNull();
    expect(result?.isContinuation).toBe(true);
  });

  test('"..." + max_tokens → detected', () => {
    const result = detectContinuation("...", "max_tokens");
    expect(result).not.toBeNull();
    expect(result?.isContinuation).toBe(true);
  });

  test('"go on" + max_tokens → detected', () => {
    const result = detectContinuation("go on", "max_tokens");
    expect(result).not.toBeNull();
    expect(result?.isContinuation).toBe(true);
  });

  test('"and?" + max_tokens → detected', () => {
    const result = detectContinuation("and?", "max_tokens");
    expect(result).not.toBeNull();
    expect(result?.isContinuation).toBe(true);
  });

  // Only one signal → NOT detected
  test('"continue" + end_turn → NOT detected (only linguistic signal)', () => {
    const result = detectContinuation("continue", "end_turn");
    expect(result).toBeNull();
  });

  test('"continue" + null stop reason → NOT detected', () => {
    const result = detectContinuation("continue", null);
    expect(result).toBeNull();
  });

  test('"continue" + undefined stop reason → NOT detected', () => {
    const result = detectContinuation("continue", undefined);
    expect(result).toBeNull();
  });

  // Linguistic signal absent → NOT detected
  test("long continuation-ish prompt + max_tokens → NOT detected (>50 chars)", () => {
    const longPrompt = "continue with the auth refactor and add error handling";
    expect(longPrompt.length).toBeGreaterThan(50);
    const result = detectContinuation(longPrompt, "max_tokens");
    expect(result).toBeNull();
  });

  test("normal prompt + max_tokens → NOT detected (no linguistic pattern)", () => {
    const result = detectContinuation("fix the null pointer in auth.ts", "max_tokens");
    expect(result).toBeNull();
  });

  test("empty string → NOT detected", () => {
    const result = detectContinuation("", "max_tokens");
    expect(result).toBeNull();
  });

  test("whitespace-only string → NOT detected", () => {
    const result = detectContinuation("   ", "max_tokens");
    expect(result).toBeNull();
  });

  // Hint content
  test("hint contains 'Resume' and 'No recap'", () => {
    const result = detectContinuation("continue", "max_tokens");
    expect(result?.hint).toContain("Resume");
    expect(result?.hint).toContain("No recap");
  });

  // Case-insensitive matching
  test('"CONTINUE" (uppercase) + max_tokens → detected', () => {
    const result = detectContinuation("CONTINUE", "max_tokens");
    expect(result).not.toBeNull();
    expect(result?.isContinuation).toBe(true);
  });

  // Leading whitespace trimming
  test("prompt with leading whitespace + max_tokens → detected", () => {
    const result = detectContinuation("  continue  ", "max_tokens");
    expect(result).not.toBeNull();
    expect(result?.isContinuation).toBe(true);
  });
});
