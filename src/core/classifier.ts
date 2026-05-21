// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import type { Classifier, ClassifyFn } from "./types.js";

export type ClassifierArgs = {
  name: string;
  weight: number;
  classify: ClassifyFn;
};

/**
 * Factory for a pipeline classifier. Validates inputs at creation time
 * so misconfigured pipelines fail fast at startup, not on the hot path.
 */
export function createClassifier(args: ClassifierArgs): Classifier {
  if (typeof args.name !== "string" || args.name.length === 0) {
    throw new Error("createClassifier: name must be a non-empty string");
  }
  if (typeof args.weight !== "number" || !Number.isFinite(args.weight)) {
    throw new Error("createClassifier: weight must be a finite number");
  }
  if (args.weight < 0 || args.weight > 1) {
    throw new Error("createClassifier: weight must be in [0, 1]");
  }
  if (typeof args.classify !== "function") {
    throw new Error("createClassifier: classify must be a function");
  }
  return { name: args.name, weight: args.weight, classify: args.classify };
}
