// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import type { Class } from "../core/types.js";

/**
 * Frozen few-shot examples for the LLM classifier system prompt. Two per
 * class, chosen to span common phrasings. Changing this list invalidates
 * baselines — treat as a frozen contract.
 */
export const FEWSHOT_EXAMPLES: ReadonlyArray<{ class: Class; prompt: string }> = [
  { class: "trivial", prompt: "rename foo to bar" },
  { class: "trivial", prompt: "format this file with prettier" },
  { class: "simple", prompt: "update the error message to mention the user's email" },
  { class: "simple", prompt: "change the default port to 3000" },
  { class: "standard", prompt: "implement a debounce utility in TypeScript" },
  { class: "standard", prompt: "add a REST endpoint for user search" },
  { class: "hard", prompt: "the e2e tests pass locally but fail in CI; figure out why" },
  { class: "hard", prompt: "refactor this 800-line file into smaller modules" },
  { class: "reasoning", prompt: "design a caching layer for our auth service" },
  { class: "reasoning", prompt: "should we move from REST to GraphQL?" },
  { class: "max", prompt: "production is down, here are the logs" },
  { class: "max", prompt: "memory leak we cannot reproduce locally" },
];
