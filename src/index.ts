// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0
//
// Public API for maestro-router. Adapters/wrapper internals are intentionally
// not exported — Maestro is consumed primarily via the CLI binary.

// ── Core factories ─────────────────────────────────────────────────────────
export { createClassifier } from "./core/classifier.js";
export {
  ALL_CLASSES,
  applyOverrides,
  balancedProfile,
  builtinProfiles,
  cheapProfile,
  createProfile,
  loadProfile,
  qualityProfile,
} from "./core/profile.js";
export { createPipeline } from "./core/pipeline.js";
export { cacheKey, createCache } from "./core/cache.js";
export { createTelemetry } from "./core/telemetry.js";
export { extractJSON } from "./core/extract.js";

// ── Namespaced bundles ─────────────────────────────────────────────────────
export * as classifiers from "./classifiers/internal-index.js";
export * as profiles from "./profiles/internal-index.js";

// ── Types ──────────────────────────────────────────────────────────────────
export type {
  Class,
  ClassSpec,
  Classification,
  Classifier,
  ClassifyFn,
  ClassifyOptions,
  CostBreakdown,
  Decision,
  Diagnostic,
  Effort,
  HeuristicRule,
  Message,
  Profile,
  ProfileOverride,
  Request,
  TelemetryEvent,
  TurnType,
  UserConfig,
} from "./core/types.js";
