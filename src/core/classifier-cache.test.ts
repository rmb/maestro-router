// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, test, expect, beforeEach, vi, afterEach } from "vitest";
import { createClassifierCache } from "./classifier-cache.js";
import type { CachedClassification } from "./classifier-cache.js";

function makeEntry(overrides?: Partial<CachedClassification>): CachedClassification {
  return {
    class: "standard",
    classifier: "heuristic",
    confidence: 0.75,
    cachedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("createClassifierCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("basic get/set/get — returns stored entry", () => {
    const cache = createClassifierCache();
    const hash = cache.promptHash("fix the bug in auth.ts");
    expect(cache.get(hash)).toBeNull();

    const entry = makeEntry();
    cache.set(hash, entry);

    const result = cache.get(hash);
    expect(result).not.toBeNull();
    expect(result?.class).toBe("standard");
    expect(result?.classifier).toBe("heuristic");
    expect(result?.confidence).toBe(0.75);
  });

  test("get returns null for missing key", () => {
    const cache = createClassifierCache();
    expect(cache.get("nonexistent")).toBeNull();
  });

  test("TTL expiry — returns null after ttlMs", () => {
    const cache = createClassifierCache({ ttlMs: 1000 });
    const hash = cache.promptHash("refactor the auth module");
    cache.set(hash, makeEntry({ cachedAt: new Date().toISOString() }));

    // Still valid at 999ms
    vi.advanceTimersByTime(999);
    expect(cache.get(hash)).not.toBeNull();

    // Expired at 1001ms
    vi.advanceTimersByTime(2);
    expect(cache.get(hash)).toBeNull();
  });

  test("LRU eviction at maxEntries — oldest is dropped", () => {
    const cache = createClassifierCache({ maxEntries: 3 });
    const h1 = cache.promptHash("prompt one");
    const h2 = cache.promptHash("prompt two");
    const h3 = cache.promptHash("prompt three");
    const h4 = cache.promptHash("prompt four");

    cache.set(h1, makeEntry({ class: "trivial" }));
    cache.set(h2, makeEntry({ class: "simple" }));
    cache.set(h3, makeEntry({ class: "standard" }));

    expect(cache.size()).toBe(3);

    // Adding a 4th entry should evict h1 (oldest).
    cache.set(h4, makeEntry({ class: "hard" }));

    expect(cache.size()).toBe(3);
    expect(cache.get(h1)).toBeNull(); // evicted
    expect(cache.get(h2)).not.toBeNull();
    expect(cache.get(h3)).not.toBeNull();
    expect(cache.get(h4)).not.toBeNull();
  });

  test("LRU: get moves entry to most-recent slot, preventing its eviction", () => {
    const cache = createClassifierCache({ maxEntries: 2 });
    const h1 = cache.promptHash("oldest");
    const h2 = cache.promptHash("middle");
    const h3 = cache.promptHash("newest");

    cache.set(h1, makeEntry({ class: "trivial" }));
    cache.set(h2, makeEntry({ class: "simple" }));

    // Touch h1 to make it most-recently used
    cache.get(h1);

    // Adding h3 should evict h2 (now oldest), not h1
    cache.set(h3, makeEntry({ class: "hard" }));

    expect(cache.get(h1)).not.toBeNull(); // still alive
    expect(cache.get(h2)).toBeNull();     // evicted
    expect(cache.get(h3)).not.toBeNull(); // alive
  });

  test("invalidation on max_tokens — get returns null for invalidated entry", () => {
    const cache = createClassifierCache();
    const hash = cache.promptHash("write a full implementation of X");
    cache.set(hash, makeEntry({ class: "hard" }));

    expect(cache.get(hash)).not.toBeNull();

    // Simulate: prior turn ended in max_tokens
    cache.invalidate(hash);

    expect(cache.get(hash)).toBeNull();
  });

  test("invalidate on missing key is a no-op", () => {
    const cache = createClassifierCache();
    expect(() => cache.invalidate("ghost")).not.toThrow();
    expect(cache.size()).toBe(0);
  });

  test("set replaces existing entry (same hash)", () => {
    const cache = createClassifierCache();
    const hash = cache.promptHash("same prompt");
    cache.set(hash, makeEntry({ class: "trivial" }));
    cache.set(hash, makeEntry({ class: "reasoning" }));

    expect(cache.size()).toBe(1);
    expect(cache.get(hash)?.class).toBe("reasoning");
  });

  test("size() tracks entries correctly", () => {
    const cache = createClassifierCache({ maxEntries: 10 });
    expect(cache.size()).toBe(0);

    const hashes = ["a", "b", "c"].map((p) => cache.promptHash(`prompt ${p}`));
    for (const h of hashes) {
      cache.set(h, makeEntry());
    }
    expect(cache.size()).toBe(3);

    cache.invalidate(hashes[0]!);
    // invalidate does not shrink the store; it marks the entry
    expect(cache.size()).toBe(3);
    // but get after invalidate removes the entry from the store
    cache.get(hashes[0]!);
    expect(cache.size()).toBe(2);
  });

  // -----------------------------------------------------------------------
  // Bypass logic — enforced by pipeline.ts, not by this module.
  // These tests document the EXPECTED bypass conditions for the pipeline
  // integration agent; the cache itself does not reject any key.
  // -----------------------------------------------------------------------

  test("BYPASS DOC: override prompts (@-prefixed) must NOT use this cache", () => {
    // The pipeline should detect `prompt.startsWith('@')` before calling
    // classifierCache.get() / classifierCache.set() for override prompts.
    // This test documents the pattern but does NOT test pipeline.ts logic.
    const prompt = "@deep refactor auth module with event sourcing";
    expect(prompt.startsWith("@")).toBe(true);
    // If the pipeline incorrectly caches an @-override, the cache itself
    // would store and return it — confirming the invariant is the caller's job.
    const cache = createClassifierCache();
    const hash = cache.promptHash(prompt);
    cache.set(hash, makeEntry({ class: "max" }));
    expect(cache.get(hash)).not.toBeNull(); // cache itself is oblivious to bypasses
  });

  test("BYPASS DOC: continuation prompts must NOT use this cache", () => {
    // The pipeline should detect continuation patterns before using the cache.
    const CONTINUATION_RE = /^(continue|keep going|go on|and\??)\b/i;
    const continuationPrompts = ["continue", "keep going", "go on", "and?"];
    for (const p of continuationPrompts) {
      expect(CONTINUATION_RE.test(p)).toBe(true);
    }
  });

  test("promptHash is deterministic and 16 hex chars", () => {
    const cache = createClassifierCache();
    const h1 = cache.promptHash("hello world");
    const h2 = cache.promptHash("hello world");
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(16);
    expect(/^[0-9a-f]+$/.test(h1)).toBe(true);
  });

  test("promptHash differs for different prompts", () => {
    const cache = createClassifierCache();
    expect(cache.promptHash("fix bug")).not.toBe(cache.promptHash("add feature"));
  });
});
