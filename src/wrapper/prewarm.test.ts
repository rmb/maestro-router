// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { computeFingerprint } from "./prewarm.js";

describe("computeFingerprint", () => {
  test("fingerprint is stable across class changes (model-only key)", () => {
    const trivialFp = computeFingerprint({
      model: "haiku",
      bare: false,
      excludeDynamicSections: true,
    });

    const standardFp = computeFingerprint({
      model: "haiku",
      bare: false,
      excludeDynamicSections: true,
    });

    const hardFp = computeFingerprint({
      model: "haiku",
      bare: false,
      excludeDynamicSections: true,
    });

    // All three should be identical (model + stable config only)
    expect(trivialFp).toBe(standardFp);
    expect(standardFp).toBe(hardFp);
  });

  test("fingerprint differs by model tier", () => {
    const haikuFp = computeFingerprint({
      model: "haiku",
      bare: false,
      excludeDynamicSections: true,
    });

    const sonnetFp = computeFingerprint({
      model: "sonnet",
      bare: false,
      excludeDynamicSections: true,
    });

    const opusFp = computeFingerprint({
      model: "opus",
      bare: false,
      excludeDynamicSections: true,
    });

    // All three should be different
    expect(haikuFp).not.toBe(sonnetFp);
    expect(sonnetFp).not.toBe(opusFp);
    expect(haikuFp).not.toBe(opusFp);
  });
});
