// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { classifyCompactionCandidate } from "./compaction.js";

describe("classifyCompactionCandidate", () => {
  test("returns [] when prompt is short", () => {
    expect(classifyCompactionCandidate(500, 300_000)).toEqual([]);
  });

  test("returns [] when session has little cached context", () => {
    expect(classifyCompactionCandidate(5_000, 50_000)).toEqual([]);
  });

  test("returns [] when both prompt is short and session is small", () => {
    expect(classifyCompactionCandidate(100, 10_000)).toEqual([]);
  });

  test("fires at medium urgency for warm session + large prompt", () => {
    const diags = classifyCompactionCandidate(4_000, 100_000);
    expect(diags).toHaveLength(1);
    expect(diags[0]!.code).toBe("compaction.candidate");
    expect(diags[0]!.message).toContain("medium urgency");
    expect(diags[0]!.severity).toBe("hint");
  });

  test("fires at high urgency for hot session + large prompt", () => {
    const diags = classifyCompactionCandidate(10_000, 300_000);
    expect(diags).toHaveLength(1);
    expect(diags[0]!.code).toBe("compaction.candidate");
    expect(diags[0]!.message).toContain("high urgency");
  });

  test("reports cached token count in kilo", () => {
    const diags = classifyCompactionCandidate(5_000, 120_000);
    expect(diags[0]!.message).toContain("120k-token session");
  });

  test("returns [] for prompt exactly 1 char below threshold", () => {
    expect(classifyCompactionCandidate(2_999, 300_000)).toEqual([]);
  });

  test("fires for prompt at exact threshold (inclusive)", () => {
    const diags = classifyCompactionCandidate(3_000, 300_000);
    expect(diags).toHaveLength(1);
    expect(diags[0]!.code).toBe("compaction.candidate");
  });
});
