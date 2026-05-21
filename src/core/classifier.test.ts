// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { createClassifier } from "./classifier.js";

describe("createClassifier", () => {
  test("returns a Classifier with name/weight/classify", () => {
    const c = createClassifier({
      name: "test",
      weight: 0.5,
      classify: () => null,
    });
    expect(c.name).toBe("test");
    expect(c.weight).toBe(0.5);
    expect(typeof c.classify).toBe("function");
  });

  test("rejects empty name", () => {
    expect(() =>
      createClassifier({ name: "", weight: 0.5, classify: () => null }),
    ).toThrow(/name must be a non-empty string/);
  });

  test("rejects weight below 0", () => {
    expect(() =>
      createClassifier({ name: "x", weight: -0.1, classify: () => null }),
    ).toThrow(/weight must be in \[0, 1\]/);
  });

  test("rejects weight above 1", () => {
    expect(() =>
      createClassifier({ name: "x", weight: 1.5, classify: () => null }),
    ).toThrow(/weight must be in \[0, 1\]/);
  });

  test("rejects non-finite weight", () => {
    expect(() =>
      createClassifier({ name: "x", weight: NaN, classify: () => null }),
    ).toThrow(/weight must be a finite number/);
  });

  test("accepts boundary weights 0 and 1", () => {
    expect(() =>
      createClassifier({ name: "x", weight: 0, classify: () => null }),
    ).not.toThrow();
    expect(() =>
      createClassifier({ name: "x", weight: 1, classify: () => null }),
    ).not.toThrow();
  });

  test("classify function returns Classification when invoked", async () => {
    const c = createClassifier({
      name: "x",
      weight: 0.5,
      classify: () => ({ class: "trivial", confidence: 1.0 }),
    });
    const result = await c.classify({ prompt: "hi" });
    expect(result).toEqual({ class: "trivial", confidence: 1.0 });
  });

  test("classify function can be async", async () => {
    const c = createClassifier({
      name: "x",
      weight: 0.5,
      classify: async () => ({ class: "standard", confidence: 0.8 }),
    });
    const result = await c.classify({ prompt: "hi" });
    expect(result).toEqual({ class: "standard", confidence: 0.8 });
  });

  test("classify function can return null (no signal)", async () => {
    const c = createClassifier({ name: "x", weight: 0.5, classify: () => null });
    expect(await c.classify({ prompt: "hi" })).toBeNull();
  });
});
