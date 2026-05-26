// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { computeFingerprint } from "./prewarm.js";
import { resolveAppendSystemPrompt } from "./spawn.js";
import { balancedProfile } from "../core/profile.js";
import type { Decision, UserConfig } from "../core/types.js";

const makeDecision = (cls: keyof typeof balancedProfile.classes): Decision => ({
  class: cls,
  classifier: "test",
  confidence: 1.0,
  spec: balancedProfile.classes[cls],
  latencyMs: 0,
  diagnostics: [],
});

const emptyConfig: UserConfig = {};

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

  test("fingerprint is stable across class swaps within same model (cache reuse)", () => {
    // With the default stable path (restorePerClassBrevity=false), all classes
    // that share the same model/bare/excludeDynamic/tools/mcpConfig produce the
    // same fingerprint because resolveAppendSystemPrompt returns the same
    // DEFAULT_APPEND_SYSTEM_PROMPT regardless of class.
    //
    // Before this fix: CLASS_BREVITY differed per class → different appendSystemPrompt
    // → different fingerprint → fresh cache boot on every class swap.
    // After: stable appendSystemPrompt → same fingerprint → one boot per (cwd, model).
    const trivialDecision = makeDecision("trivial");
    const standardDecision = makeDecision("standard");

    const trivialPrompt = resolveAppendSystemPrompt(trivialDecision, emptyConfig);
    const standardPrompt = resolveAppendSystemPrompt(standardDecision, emptyConfig);

    // Both resolve to the same stable string
    expect(trivialPrompt).toBe(standardPrompt);

    // Therefore fingerprints match when other dimensions match
    const trivialFp = computeFingerprint({
      model: "sonnet",
      bare: false,
      excludeDynamicSections: true,
      appendSystemPrompt: trivialPrompt,
    });
    const standardFp = computeFingerprint({
      model: "sonnet",
      bare: false,
      excludeDynamicSections: true,
      appendSystemPrompt: standardPrompt,
    });

    expect(trivialFp).toBe(standardFp);
  });

  test("fingerprint differs across class swaps in legacy path (restorePerClassBrevity=true)", () => {
    // With the legacy path, CLASS_BREVITY produces different hints per class
    // so fingerprints do differ (expected — this is the pre-fix behavior).
    const legacyConfig: UserConfig = { restorePerClassBrevity: true };

    const trivialDecision = makeDecision("trivial");
    const standardDecision = makeDecision("standard");

    const trivialPrompt = resolveAppendSystemPrompt(trivialDecision, legacyConfig);
    const standardPrompt = resolveAppendSystemPrompt(standardDecision, legacyConfig);

    // Legacy: hints differ per class
    expect(trivialPrompt).not.toBe(standardPrompt);

    const trivialFp = computeFingerprint({
      model: "sonnet",
      bare: false,
      excludeDynamicSections: true,
      appendSystemPrompt: trivialPrompt,
    });
    const standardFp = computeFingerprint({
      model: "sonnet",
      bare: false,
      excludeDynamicSections: true,
      appendSystemPrompt: standardPrompt,
    });

    expect(trivialFp).not.toBe(standardFp);
  });

  test("fingerprint differs when trivialMinimalContext=true vs false (S12)", () => {
    // With trivialMinimalContext enabled, the fingerprint must differ from the
    // full-context version to ensure they use different session buckets
    const fullCtxFp = computeFingerprint({
      model: "haiku",
      bare: false,
      excludeDynamicSections: true,
    });

    const minimalCtxFp = computeFingerprint({
      model: "haiku",
      bare: false,
      excludeDynamicSections: true,
      trivialMinimalContext: true,
    });

    expect(minimalCtxFp).not.toBe(fullCtxFp);
  });

  test("fingerprint omits trivialMinimalContext when false (default)", () => {
    // When trivialMinimalContext is false or undefined, the field should not be
    // included in the fingerprint computation
    const fpWithoutField = computeFingerprint({
      model: "haiku",
      bare: false,
      excludeDynamicSections: true,
    });

    const fpWithFalse = computeFingerprint({
      model: "haiku",
      bare: false,
      excludeDynamicSections: true,
      trivialMinimalContext: false,
    });

    // Both should produce the same fingerprint when the field is absent or false
    expect(fpWithoutField).toBe(fpWithFalse);
  });
});
