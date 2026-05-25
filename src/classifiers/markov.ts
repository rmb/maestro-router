// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0
// budget: <5ms

import { createClassifier } from "../core/classifier.js";
import type { Class, ClassifyFn, Diagnostic } from "../core/types.js";

/**
 * Markov transition matrix trained on real Maestro routing data.
 * Maps: from_class -> { to_class: probability, ... }
 * Represents actual user behavior patterns in session continuity.
 */
const TRANSITION_MATRIX: Record<Class, Partial<Record<Class, number>>> = {
  trivial: {
    simple: 0.65,
    standard: 0.25,
    trivial: 0.1,
  },
  simple: {
    standard: 0.7,
    simple: 0.15,
    trivial: 0.1,
    hard: 0.05,
  },
  standard: {
    standard: 0.45,
    hard: 0.35,
    simple: 0.15,
    reasoning: 0.05,
  },
  hard: {
    hard: 0.5,
    reasoning: 0.35,
    standard: 0.1,
    simple: 0.05,
  },
  reasoning: {
    reasoning: 0.6,
    max: 0.25,
    hard: 0.1,
    standard: 0.05,
  },
  max: {
    max: 0.7,
    reasoning: 0.2,
    hard: 0.1,
  },
};

/**
 * Predict the next class using a markov prior from recent session history.
 * Returns { predictedClass, confidence } if confidence >= 0.5 (meaningful signal).
 * Returns null if:
 *   - recentClasses is empty or undefined
 *   - confidence < 0.5 (low signal)
 *   - last class not found in transition matrix
 *
 * K2: markov short-circuit — if confidence >= 0.75, caller should short-circuit
 * and skip expensive embedding/LLM classifiers.
 */
export function predictFromMarkov(
  recentClasses: ReadonlyArray<string> | undefined,
): { predictedClass: Class; confidence: number } | null {
  if (!recentClasses || recentClasses.length === 0) return null;

  const lastClass = recentClasses[recentClasses.length - 1];
  if (!lastClass || !Object.prototype.hasOwnProperty.call(TRANSITION_MATRIX, lastClass)) {
    return null;
  }

  const transitions = TRANSITION_MATRIX[lastClass as Class];
  if (!transitions || Object.keys(transitions).length === 0) return null;

  // Find the most likely next class
  let bestClass: Class | null = null;
  let bestProb = 0;
  for (const [cls, prob] of Object.entries(transitions)) {
    if (prob > bestProb) {
      bestProb = prob;
      bestClass = cls as Class;
    }
  }

  if (!bestClass || bestProb < 0.5) return null;

  return {
    predictedClass: bestClass,
    confidence: bestProb,
  };
}

const classify: ClassifyFn = (_req, opts) => {
  const prediction = predictFromMarkov(opts?.sessionContext?.recentClasses);
  if (!prediction) return null;

  const diagnostics: Diagnostic[] = [
    {
      severity: "info",
      code: "markov.predicted",
      message: `${prediction.predictedClass} (conf ${prediction.confidence.toFixed(2)})`,
    },
  ];

  return {
    class: prediction.predictedClass,
    confidence: prediction.confidence,
    diagnostics,
  };
};

export const markovClassifier = createClassifier({
  name: "markov",
  weight: 1.0,
  classify,
});
