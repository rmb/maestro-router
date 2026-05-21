// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, test, expect } from "vitest";
import { createCache, cacheKey } from "./cache.js";

describe("createCache", () => {
  test("get returns undefined for missing key", () => {
    const c = createCache<string>();
    expect(c.get("missing")).toBeUndefined();
    expect(c.stats().misses).toBe(1);
  });

  test("set then get returns value", () => {
    const c = createCache<string>();
    c.set("k", "v");
    expect(c.get("k")).toBe("v");
    expect(c.stats().hits).toBe(1);
  });

  test("set is idempotent (replaces value)", () => {
    const c = createCache<number>();
    c.set("k", 1);
    c.set("k", 2);
    expect(c.get("k")).toBe(2);
    expect(c.size()).toBe(1);
  });

  test("evicts oldest when capacity exceeded", () => {
    const c = createCache<number>({ maxEntries: 2 });
    c.set("a", 1);
    c.set("b", 2);
    c.set("c", 3);
    expect(c.get("a")).toBeUndefined();
    expect(c.get("b")).toBe(2);
    expect(c.get("c")).toBe(3);
    expect(c.stats().evictions).toBe(1);
  });

  test("LRU: get moves entry to most-recent slot", () => {
    const c = createCache<number>({ maxEntries: 2 });
    c.set("a", 1);
    c.set("b", 2);
    c.get("a");
    c.set("c", 3);
    expect(c.get("a")).toBe(1);
    expect(c.get("b")).toBeUndefined();
    expect(c.get("c")).toBe(3);
  });

  test("respects TTL on get", () => {
    let time = 1000;
    const c = createCache<string>({ ttlMs: 100, now: () => time });
    c.set("k", "v");
    expect(c.get("k")).toBe("v");
    time = 1101;
    expect(c.get("k")).toBeUndefined();
  });

  test("has reflects TTL", () => {
    let time = 1000;
    const c = createCache<string>({ ttlMs: 50, now: () => time });
    c.set("k", "v");
    expect(c.has("k")).toBe(true);
    time = 1100;
    expect(c.has("k")).toBe(false);
  });

  test("delete removes entry", () => {
    const c = createCache<number>();
    c.set("k", 1);
    expect(c.delete("k")).toBe(true);
    expect(c.get("k")).toBeUndefined();
    expect(c.delete("k")).toBe(false);
  });

  test("clear resets store and stats", () => {
    const c = createCache<number>();
    c.set("a", 1);
    c.get("a");
    c.get("missing");
    c.clear();
    expect(c.size()).toBe(0);
    const s = c.stats();
    expect(s.hits).toBe(0);
    expect(s.misses).toBe(0);
    expect(s.evictions).toBe(0);
  });

  test("stats track hits, misses, evictions", () => {
    const c = createCache<number>({ maxEntries: 1 });
    c.set("a", 1);
    c.set("b", 2);
    c.get("a");
    c.get("b");
    const s = c.stats();
    expect(s.hits).toBe(1);
    expect(s.misses).toBe(1);
    expect(s.evictions).toBe(1);
    expect(s.size).toBe(1);
  });
});

describe("cacheKey", () => {
  test("is deterministic", () => {
    expect(cacheKey("foo")).toBe(cacheKey("foo"));
    expect(cacheKey("foo", "bg")).toBe(cacheKey("foo", "bg"));
  });

  test("differs by prompt", () => {
    expect(cacheKey("foo")).not.toBe(cacheKey("bar"));
  });

  test("differs by scenario hint", () => {
    expect(cacheKey("foo")).not.toBe(cacheKey("foo", "bg"));
    expect(cacheKey("foo", "")).not.toBe(cacheKey("foo", "bg"));
  });

  test("treats undefined and empty scenario hint as different from non-empty", () => {
    const undefHint = cacheKey("foo", undefined);
    const emptyHint = cacheKey("foo", "");
    expect(undefHint).toBe(emptyHint);
    expect(undefHint).not.toBe(cacheKey("foo", "x"));
  });
});
