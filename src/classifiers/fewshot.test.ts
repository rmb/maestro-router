// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import type { Class } from "../core/types.js";
import {
  CLASS_RUBRIC,
  FEW_SHOT_EXAMPLES,
  renderFewShotBlock,
} from "./fewshot.js";

const ALL: ReadonlyArray<Class> = [
  "trivial",
  "simple",
  "standard",
  "hard",
  "reasoning",
  "max",
];

describe("CLASS_RUBRIC", () => {
  test("mentions every class name", () => {
    for (const cls of ALL) expect(CLASS_RUBRIC).toContain(`- ${cls}:`);
  });
});

describe("FEW_SHOT_EXAMPLES", () => {
  test("has exactly 3 examples per class for all 6 classes", () => {
    expect(FEW_SHOT_EXAMPLES).toHaveLength(18);
    const counts: Record<string, number> = {};
    for (const ex of FEW_SHOT_EXAMPLES) {
      counts[ex.class] = (counts[ex.class] ?? 0) + 1;
    }
    for (const cls of ALL) expect(counts[cls]).toBe(3);
  });

  test("emits examples grouped by class in declared order", () => {
    const seen: Class[] = [];
    let prev: Class | null = null;
    for (const ex of FEW_SHOT_EXAMPLES) {
      if (ex.class !== prev) {
        seen.push(ex.class);
        prev = ex.class;
      }
    }
    expect(seen).toEqual(ALL);
  });

  test("every example has high confidence (0.95)", () => {
    for (const ex of FEW_SHOT_EXAMPLES) expect(ex.confidence).toBe(0.95);
  });
});

describe("renderFewShotBlock", () => {
  test("renders 18 input→output pairs separated by blank lines", () => {
    const block = renderFewShotBlock();
    const pairs = block.split("\n\n");
    expect(pairs).toHaveLength(18);
  });

  test("uses the anti-injection tag format on each input", () => {
    const block = renderFewShotBlock();
    const inputs = block.match(/<PROMPT_TO_CLASSIFY>/g) ?? [];
    expect(inputs).toHaveLength(18);
  });

  test("each rendered output is valid JSON parseable as {class, confidence}", () => {
    const block = renderFewShotBlock();
    const outputs = block.match(/→ ({[^\n]+})/g) ?? [];
    expect(outputs).toHaveLength(18);
    for (const out of outputs) {
      const json = out.replace(/^→ /, "");
      const parsed = JSON.parse(json) as { class: string; confidence: number };
      expect(typeof parsed.class).toBe("string");
      expect(typeof parsed.confidence).toBe("number");
      expect(parsed.confidence).toBeGreaterThan(0);
      expect(parsed.confidence).toBeLessThanOrEqual(1);
    }
  });

  test("is deterministic — repeated calls produce identical bytes (cache stability)", () => {
    expect(renderFewShotBlock()).toBe(renderFewShotBlock());
  });
});
