// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { overrideClassifier, stripOverride } from "./override.js";
import type { Class } from "../core/types.js";

const call = (prompt: string) => overrideClassifier.classify({ prompt });

describe("overrideClassifier", () => {
  test("@opus → max", async () => {
    expect(await call("@opus design something")).toMatchObject({
      class: "max",
      confidence: 1.0,
    });
  });

  test("@deep → max", async () => {
    expect(await call("@deep debug this")).toMatchObject({ class: "max" });
  });

  test("@think → reasoning", async () => {
    expect(await call("@think how should we architect this?")).toMatchObject({
      class: "reasoning",
    });
  });

  test("@sonnet → standard", async () => {
    expect(await call("@sonnet implement a function")).toMatchObject({
      class: "standard",
    });
  });

  test("@fast → trivial", async () => {
    expect(await call("@fast rename foo to bar")).toMatchObject({ class: "trivial" });
  });

  test("@haiku → trivial", async () => {
    expect(await call("@haiku quick fix please")).toMatchObject({ class: "trivial" });
  });

  test("@fast+context → trivial AND emits disable_bare diagnostic", async () => {
    const result = await call("@fast+context rename in our auth module");
    expect(result).toMatchObject({ class: "trivial", confidence: 1.0 });
    const codes = result!.diagnostics!.map((d) => d.code);
    expect(codes).toContain("override.matched");
    expect(codes).toContain("override.disable_bare");
  });

  test("@fast (alone) does NOT emit disable_bare", async () => {
    const result = await call("@fast rename foo");
    const codes = (result!.diagnostics ?? []).map((d) => d.code);
    expect(codes).not.toContain("override.disable_bare");
  });

  test("override matched message includes the hint", async () => {
    const result = await call("@opus build it");
    const matched = result!.diagnostics!.find((d) => d.code === "override.matched");
    expect(matched?.message).toBe("@opus");
  });

  test("case insensitive", async () => {
    expect(await call("@OPUS design a system")).toMatchObject({ class: "max" });
    expect(await call("@Fast rename it")).toMatchObject({ class: "trivial" });
    expect(await call("@Fast+Context rename it")).toMatchObject({ class: "trivial" });
  });

  test("matches mid-prompt with leading space", async () => {
    expect(await call("hey @deep find the bug")).toMatchObject({ class: "max" });
  });

  test("does not match within a word", async () => {
    expect(await call("email@opus.com")).toBeNull();
    expect(await call("foo@fast.bar")).toBeNull();
  });

  test("does not match when no @ override", async () => {
    expect(await call("rename foo to bar")).toBeNull();
    expect(await call("")).toBeNull();
  });

  test("first override wins when multiple present", async () => {
    expect(await call("@fast then @deep do stuff")).toMatchObject({ class: "trivial" });
  });

  test("returns confidence 1.0 on match", async () => {
    const r = await call("@opus go");
    expect(r!.confidence).toBe(1.0);
  });

  // Sanity: every documented hint maps to a Class value of the union
  test("every documented override maps to a known class", async () => {
    const known: Class[] = ["trivial", "simple", "standard", "hard", "reasoning", "max"];
    const hints = ["opus", "deep", "think", "sonnet", "fast", "haiku", "fast+context"];
    for (const hint of hints) {
      const result = await call(`@${hint} test`);
      expect(known).toContain(result!.class);
    }
  });
});

describe("stripOverride", () => {
  test("removes leading override", () => {
    expect(stripOverride("@fast rename foo")).toBe("rename foo");
  });

  test("removes mid-prompt override", () => {
    expect(stripOverride("hey @deep find the bug")).toBe("hey find the bug");
  });

  test("removes @fast+context override", () => {
    expect(stripOverride("@fast+context rename in auth")).toBe("rename in auth");
  });

  test("returns input unchanged when no override", () => {
    expect(stripOverride("rename foo")).toBe("rename foo");
  });

  test("only removes the first occurrence", () => {
    expect(stripOverride("@fast something @deep else")).toBe("something @deep else");
  });

  test("is case insensitive", () => {
    expect(stripOverride("@OPUS go")).toBe("go");
  });
});
