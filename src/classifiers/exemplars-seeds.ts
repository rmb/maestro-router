// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0
//
// Frozen, hand-curated exemplars per class. The runtime embedding
// classifier compares each prompt to these. Order is load-bearing:
// `seedsChecksum` is computed over the serialized sequence, so any reorder
// invalidates the on-disk `exemplars.json` and forces a re-embed via
// `pnpm embed`.
//
// Bump EXEMPLAR_SEEDS_VERSION whenever you intentionally change the set.

import type { Class } from "../core/types.js";

export const EXEMPLAR_SEEDS_VERSION = "1.0.0";

export type ExemplarSeed = {
  readonly class: Class;
  readonly prompt: string;
};

export const EXEMPLAR_SEEDS: ReadonlyArray<ExemplarSeed> = [
  // ── trivial ────────────────────────────────────────────────────────────
  { class: "trivial", prompt: "rename foo to bar" },
  { class: "trivial", prompt: "format this file with prettier" },
  { class: "trivial", prompt: "run eslint on this file" },
  { class: "trivial", prompt: "fix the typo in line 42" },
  { class: "trivial", prompt: "rename variable x to user_id" },
  { class: "trivial", prompt: "add jsdoc to this method" },
  { class: "trivial", prompt: "fix indentation" },
  { class: "trivial", prompt: "add a copyright header" },
  { class: "trivial", prompt: "rename camelCase to snake_case" },
  { class: "trivial", prompt: "run the linter" },

  // ── simple ────────────────────────────────────────────────────────────
  { class: "simple", prompt: "add a parameter to this function" },
  { class: "simple", prompt: "update the error message to be clearer" },
  { class: "simple", prompt: "change the default port to 3000" },
  { class: "simple", prompt: "add a docstring to this class" },
  { class: "simple", prompt: "change the timeout from 5 to 10 seconds" },
  { class: "simple", prompt: "update the version number in package.json" },
  { class: "simple", prompt: "add an optional second argument" },
  { class: "simple", prompt: "change http to https in the config" },
  { class: "simple", prompt: "add a new entry to the enum" },
  { class: "simple", prompt: "change the success message wording" },

  // ── standard ──────────────────────────────────────────────────────────
  { class: "standard", prompt: "implement a debounce utility" },
  { class: "standard", prompt: "add a REST endpoint for user search" },
  { class: "standard", prompt: "write a function to merge two arrays without duplicates" },
  { class: "standard", prompt: "add pagination to the user list" },
  { class: "standard", prompt: "implement a basic cache with TTL" },
  { class: "standard", prompt: "add input validation to this form" },
  { class: "standard", prompt: "write a script to convert CSV to JSON" },
  { class: "standard", prompt: "add error handling to the API client" },
  { class: "standard", prompt: "implement retry logic with exponential backoff" },
  { class: "standard", prompt: "write tests for the auth module" },

  // ── hard ──────────────────────────────────────────────────────────────
  { class: "hard", prompt: "this test is flaky, find out why" },
  { class: "hard", prompt: "refactor this 800-line file into smaller modules" },
  { class: "hard", prompt: "fix the race condition in the worker pool" },
  { class: "hard", prompt: "the user list is slow with 10k records, optimize it" },
  { class: "hard", prompt: "there's a memory leak in the websocket handler" },
  { class: "hard", prompt: "the cache eviction is wrong sometimes, find the bug" },
  { class: "hard", prompt: "migrate this endpoint from REST to GraphQL preserving the API" },
  { class: "hard", prompt: "find and fix all unused imports across the codebase" },
  { class: "hard", prompt: "there's a subtle off-by-one bug in this loop" },
  { class: "hard", prompt: "split this monolith file into three modules without breaking imports" },

  // ── reasoning ─────────────────────────────────────────────────────────
  { class: "reasoning", prompt: "design a caching layer for our auth service" },
  { class: "reasoning", prompt: "should we move from REST to GraphQL?" },
  { class: "reasoning", prompt: "what's the best architecture for a multi-tenant SaaS billing system?" },
  { class: "reasoning", prompt: "compare Postgres vs MongoDB for our use case" },
  { class: "reasoning", prompt: "design a rate limiter for our public API" },
  { class: "reasoning", prompt: "how should we structure our microservices?" },
  { class: "reasoning", prompt: "design a feature flag system for our app" },
  { class: "reasoning", prompt: "should we adopt event sourcing for orders?" },
  { class: "reasoning", prompt: "design our observability stack" },
  { class: "reasoning", prompt: "design a sharding strategy for our user database" },

  // ── max ───────────────────────────────────────────────────────────────
  { class: "max", prompt: "production is down, here are the logs" },
  { class: "max", prompt: "memory leak we cannot reproduce locally" },
  { class: "max", prompt: "our database has corrupt data, here are the symptoms" },
  { class: "max", prompt: "customers report random logouts, no error in logs" },
  { class: "max", prompt: "silent data loss in the queue, find it" },
  { class: "max", prompt: "our k8s pods are oom-killed but the heap looks fine" },
  { class: "max", prompt: "there's a security breach signature in the logs, trace it" },
  { class: "max", prompt: "data race causing wrong results, can't pin it down" },
  { class: "max", prompt: "cascading failure took down 6 services, trace the root" },
  { class: "max", prompt: "byzantine fault in the consensus layer, debug it" },
];

/**
 * Stable serialization for checksum purposes. Format:
 *   <class>\t<prompt>\n
 * One line per seed, in declared order. Trailing newline included so the
 * checksum is stable under text-tool round-trips.
 */
export function serializeSeedsForChecksum(
  seeds: ReadonlyArray<ExemplarSeed> = EXEMPLAR_SEEDS,
): string {
  return seeds.map((s) => `${s.class}\t${s.prompt}`).join("\n") + "\n";
}
