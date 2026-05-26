// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, test, expect } from "vitest";
import { createBatchHintState, recordPromptAndMaybeAdvise } from "./batch-hint.js";

describe("batch-hint", () => {
  test("does not advise on a single short prompt", () => {
    const s = createBatchHintState();
    expect(recordPromptAndMaybeAdvise(s, "trivial", 1000)).toBeNull();
  });

  test("does not advise on two short prompts", () => {
    const s = createBatchHintState();
    recordPromptAndMaybeAdvise(s, "trivial", 1000);
    expect(recordPromptAndMaybeAdvise(s, "simple", 2000)).toBeNull();
  });

  test("advises on 3 short prompts in 30s window", () => {
    const s = createBatchHintState();
    recordPromptAndMaybeAdvise(s, "trivial", 1000);
    recordPromptAndMaybeAdvise(s, "simple", 5000);
    const hint = recordPromptAndMaybeAdvise(s, "trivial", 10000);
    expect(hint).toContain("3 short prompts");
  });

  test("only advises once per state instance", () => {
    const s = createBatchHintState();
    recordPromptAndMaybeAdvise(s, "trivial", 1000);
    recordPromptAndMaybeAdvise(s, "simple", 5000);
    recordPromptAndMaybeAdvise(s, "trivial", 10000); // first advisory
    const second = recordPromptAndMaybeAdvise(s, "trivial", 15000);
    expect(second).toBeNull();
  });

  test("ignores standard/hard/max class prompts", () => {
    const s = createBatchHintState();
    recordPromptAndMaybeAdvise(s, "standard", 1000);
    recordPromptAndMaybeAdvise(s, "hard", 5000);
    const third = recordPromptAndMaybeAdvise(s, "max", 10000);
    expect(third).toBeNull();
  });

  test("prunes events outside the 30s window", () => {
    const s = createBatchHintState();
    recordPromptAndMaybeAdvise(s, "trivial", 0);
    recordPromptAndMaybeAdvise(s, "trivial", 10000);
    // 40s later — first two are pruned
    const hint = recordPromptAndMaybeAdvise(s, "trivial", 40_000);
    expect(hint).toBeNull();
  });
});
