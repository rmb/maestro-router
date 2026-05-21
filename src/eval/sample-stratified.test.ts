// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import type { Class } from "../core/types.js";
import { stratifiedSample } from "./sample-stratified.js";

type Entry = { prompt: string; expectedClass: Class };

const e = (prompt: string, expectedClass: Class): Entry => ({ prompt, expectedClass });

describe("stratifiedSample", () => {
  test("returns [] when size is 0", () => {
    expect(stratifiedSample([e("a", "simple")], 0)).toEqual([]);
  });

  test("returns [] when entries is empty", () => {
    expect(stratifiedSample([], 10)).toEqual([]);
  });

  test("round-robins one per class first, then fills second pass", () => {
    const entries = [
      e("s1", "simple"),
      e("s2", "simple"),
      e("st1", "standard"),
      e("st2", "standard"),
      e("h1", "hard"),
    ];
    const out = stratifiedSample(entries, 5);
    // First pass: one per class in input-order (simple, standard, hard).
    // Second pass: simple again, standard again. (hard exhausted.)
    expect(out.map((x) => x.prompt)).toEqual(["s1", "st1", "h1", "s2", "st2"]);
  });

  test("excludes classes listed in excludeClasses", () => {
    const entries = [
      e("t1", "trivial"),
      e("t2", "trivial"),
      e("t3", "trivial"),
      e("s1", "simple"),
      e("st1", "standard"),
    ];
    const out = stratifiedSample(entries, 10, { excludeClasses: ["trivial"] });
    expect(out.map((x) => x.expectedClass)).not.toContain("trivial");
    expect(out.map((x) => x.prompt).sort()).toEqual(["s1", "st1"]);
  });

  test("trims to size when more entries available than requested", () => {
    const entries: Entry[] = [];
    for (let i = 0; i < 5; i++) entries.push(e(`s${i}`, "simple"));
    for (let i = 0; i < 5; i++) entries.push(e(`st${i}`, "standard"));
    for (let i = 0; i < 5; i++) entries.push(e(`h${i}`, "hard"));
    const out = stratifiedSample(entries, 6);
    expect(out).toHaveLength(6);
    // Two per class in round-robin.
    const counts = out.reduce<Record<string, number>>((acc, x) => {
      acc[x.expectedClass] = (acc[x.expectedClass] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts).toEqual({ simple: 2, standard: 2, hard: 2 });
  });

  test("returns all available when entries < size (post-exclude)", () => {
    const entries = [e("s1", "simple"), e("st1", "standard")];
    const out = stratifiedSample(entries, 20);
    expect(out).toHaveLength(2);
  });

  test("is deterministic across calls with same input", () => {
    const entries = [
      e("a", "simple"),
      e("b", "standard"),
      e("c", "simple"),
      e("d", "hard"),
    ];
    const a = stratifiedSample(entries, 3);
    const b = stratifiedSample(entries, 3);
    expect(a.map((x) => x.prompt)).toEqual(b.map((x) => x.prompt));
  });

  test("preserves input order within each class", () => {
    const entries = [
      e("s3", "simple"),
      e("s1", "simple"),
      e("s2", "simple"),
    ];
    const out = stratifiedSample(entries, 3);
    expect(out.map((x) => x.prompt)).toEqual(["s3", "s1", "s2"]);
  });

  test("fixes the documented bias: first-20 of trivial-heavy dataset", () => {
    // T0.1 debug log: first 20 entries were 17 trivials → all skipped.
    // Stratified excludes trivial; result has zero trivials.
    const entries: Entry[] = [];
    for (let i = 0; i < 17; i++) entries.push(e(`t${i}`, "trivial"));
    entries.push(e("s1", "simple"));
    entries.push(e("st1", "standard"));
    entries.push(e("h1", "hard"));
    const out = stratifiedSample(entries, 20, { excludeClasses: ["trivial"] });
    expect(out.every((x) => x.expectedClass !== "trivial")).toBe(true);
    expect(out).toHaveLength(3);
  });
});
