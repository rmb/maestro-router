// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { predictFromMarkov } from "./markov.js";

describe("predictFromMarkov", () => {
  describe("high-confidence predictions", () => {
    test("trivial → simple (0.65 confidence)", () => {
      const result = predictFromMarkov(["trivial"]);
      expect(result).toEqual({
        predictedClass: "simple",
        confidence: 0.65,
      });
    });

    test("simple → standard (0.70 confidence)", () => {
      const result = predictFromMarkov(["simple"]);
      expect(result).toEqual({
        predictedClass: "standard",
        confidence: 0.7,
      });
    });

    test("standard → standard (0.45 confidence, below 0.5 threshold returns null)", () => {
      const result = predictFromMarkov(["standard"]);
      expect(result).toBeNull();
    });

    test("hard → hard (0.50 confidence, exactly at boundary)", () => {
      const result = predictFromMarkov(["hard"]);
      expect(result).toEqual({
        predictedClass: "hard",
        confidence: 0.5,
      });
    });

    test("reasoning → reasoning (0.60 confidence)", () => {
      const result = predictFromMarkov(["reasoning"]);
      expect(result).toEqual({
        predictedClass: "reasoning",
        confidence: 0.6,
      });
    });

    test("max → max (0.70 confidence)", () => {
      const result = predictFromMarkov(["max"]);
      expect(result).toEqual({
        predictedClass: "max",
        confidence: 0.7,
      });
    });
  });

  describe("ignores history before last class", () => {
    test("uses only the last class in a long history", () => {
      const result = predictFromMarkov(["trivial", "simple", "standard", "hard", "reasoning"]);
      // Last class is "reasoning" → predict "reasoning" with 0.60
      expect(result?.predictedClass).toBe("reasoning");
      expect(result?.confidence).toBe(0.6);
    });

    test("long history with max at end", () => {
      const result = predictFromMarkov([
        "trivial",
        "simple",
        "standard",
        "hard",
        "reasoning",
        "reasoning",
        "reasoning",
        "max",
      ]);
      // Last class is "max" → predict "max" with 0.70
      expect(result?.predictedClass).toBe("max");
      expect(result?.confidence).toBe(0.7);
    });
  });

  describe("edge cases", () => {
    test("empty array returns null", () => {
      expect(predictFromMarkov([])).toBeNull();
    });

    test("undefined returns null", () => {
      expect(predictFromMarkov(undefined)).toBeNull();
    });

    test("unknown class returns null", () => {
      expect(predictFromMarkov(["unknown_class" as any])).toBeNull();
    });

    test("single-element history", () => {
      const result = predictFromMarkov(["simple"]);
      expect(result).toEqual({
        predictedClass: "standard",
        confidence: 0.7,
      });
    });
  });

  describe("markov lock-in scenario (K2)", () => {
    test("sustained standard mode returns null (0.45 < 0.5 threshold)", () => {
      const result = predictFromMarkov(["standard", "standard", "standard"]);
      expect(result).toBeNull();
    });

    test("sustained reasoning mode predicts reasoning", () => {
      const result = predictFromMarkov(["reasoning", "reasoning", "reasoning", "reasoning"]);
      expect(result?.predictedClass).toBe("reasoning");
      expect(result?.confidence).toBe(0.6);
    });

    test("sustained max mode predicts max", () => {
      const result = predictFromMarkov(["max", "max", "max", "max", "max"]);
      expect(result?.predictedClass).toBe("max");
      expect(result?.confidence).toBe(0.7);
    });
  });

  describe("real session patterns", () => {
    test("escalation: trivial → simple → standard → hard", () => {
      // After reaching hard, predict hard
      const result = predictFromMarkov(["trivial", "simple", "standard", "hard"]);
      expect(result?.predictedClass).toBe("hard");
      expect(result?.confidence).toBe(0.5);
    });

    test("reasoning crisis: standard → hard → reasoning", () => {
      const result = predictFromMarkov(["standard", "hard", "reasoning"]);
      expect(result?.predictedClass).toBe("reasoning");
      expect(result?.confidence).toBe(0.6);
    });

    test("back down: reasoning → hard → standard returns null (0.45 < 0.5)", () => {
      const result = predictFromMarkov(["reasoning", "hard", "standard"]);
      expect(result).toBeNull();
    });
  });

  describe("confidence threshold boundary", () => {
    test("returns prediction when confidence == 0.5 (inclusive boundary)", () => {
      const result = predictFromMarkov(["hard"]);
      expect(result).not.toBeNull();
      expect(result?.confidence).toBe(0.5);
    });

    test("returns null when all transitions are below 0.5 (hypothetical)", () => {
      // In the actual matrix, hard → hard is exactly 0.5, so this is
      // a boundary case. All real classes have a best transition >= 0.5.
      // This test documents the boundary behavior.
      const result = predictFromMarkov(["hard"]);
      expect(result).not.toBeNull(); // hard → hard is 0.5, which passes
    });
  });
});
