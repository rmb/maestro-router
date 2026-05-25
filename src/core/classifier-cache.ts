// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0
// budget: 1ms

import { createHash } from "node:crypto";
import type { Class } from "./types.js";

export type CachedClassification = {
  class: Class;
  classifier: string;
  confidence: number;
  cachedAt: string;
  /** If this classification led to a max_tokens stop, it's marked invalid and will be dropped. */
  invalidated?: boolean;
};

export type ClassifierCacheOptions = {
  maxEntries?: number;
  ttlMs?: number;
};

export type ClassifierCache = {
  get(promptHash: string): CachedClassification | null;
  set(promptHash: string, value: CachedClassification): void;
  /** Invalidate a cache entry when its prior use produced a max_tokens stop. */
  invalidate(promptHash: string): void;
  promptHash(prompt: string): string;
  size(): number;
};

const DEFAULT_MAX_ENTRIES = 1000;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * In-memory LRU cache for classifier outputs.
 * Keyed by sha256(prompt). 24h TTL, 1000 entries max.
 * Self-correcting: entries invalidated when prior outcome was max_tokens.
 *
 * BYPASS rules (enforced by the caller / pipeline.ts):
 *   - Prompts starting with `@` (override — user is explicitly routing)
 *   - Continuation prompts matching /^(continue|keep going|go on|and\?)\b/i
 *
 * PIPELINE INTEGRATION CONTRACT (for the pipeline.ts agent):
 *
 *   import { classifierCache } from "./classifier-cache.js";
 *
 *   Before running classifiers in pipeline.route():
 *     const hash = classifierCache.promptHash(req.prompt);
 *     const BYPASS = req.prompt.startsWith("@") ||
 *                    /^(continue|keep going|go on|and\??)\b/i.test(req.prompt.trim());
 *     if (!BYPASS) {
 *       const hit = classifierCache.get(hash);
 *       if (hit) {
 *         // Build a Decision from hit and return early (similar to cache.get() pattern).
 *         return buildDecision({ cls: hit.class, classifier: `cache:${hit.classifier}`, ... });
 *       }
 *     }
 *
 *   After pipeline resolves a decision (short-circuit or vote):
 *     if (!BYPASS) {
 *       classifierCache.set(hash, {
 *         class: decision.class,
 *         classifier: decision.classifier,
 *         confidence: decision.confidence,
 *         cachedAt: new Date().toISOString(),
 *       });
 *     }
 *
 *   On max_tokens outcome (in spawn/output callback):
 *     classifierCache.invalidate(hash);
 */
export function createClassifierCache(opts?: ClassifierCacheOptions): ClassifierCache {
  const maxEntries = opts?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;

  // Map preserves insertion order; oldest entry = first key = LRU victim.
  const store = new Map<string, CachedClassification>();

  return {
    promptHash(prompt: string): string {
      return createHash("sha256").update(prompt).digest("hex").slice(0, 16);
    },

    get(promptHash: string): CachedClassification | null {
      const entry = store.get(promptHash);
      if (!entry) return null;

      // Drop invalidated entries.
      if (entry.invalidated) {
        store.delete(promptHash);
        return null;
      }

      // Drop expired entries.
      const age = Date.now() - new Date(entry.cachedAt).getTime();
      if (age > ttlMs) {
        store.delete(promptHash);
        return null;
      }

      // LRU: move to end (most recently used).
      store.delete(promptHash);
      store.set(promptHash, entry);
      return entry;
    },

    set(promptHash: string, value: CachedClassification): void {
      if (store.has(promptHash)) {
        store.delete(promptHash);
      } else if (store.size >= maxEntries) {
        // Evict the oldest (first) entry.
        const oldest = store.keys().next().value;
        if (oldest !== undefined) {
          store.delete(oldest);
        }
      }
      store.set(promptHash, value);
    },

    invalidate(promptHash: string): void {
      const entry = store.get(promptHash);
      if (entry) {
        store.set(promptHash, { ...entry, invalidated: true });
      }
    },

    size(): number {
      return store.size;
    },
  };
}

/** Singleton instance with default options (maxEntries=1000, ttlMs=24h). */
export const classifierCache: ClassifierCache = createClassifierCache();
