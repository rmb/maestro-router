// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionStore } from "./session.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "maestro-sess-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("createSessionStore", () => {
  test("getOrCreate returns a UUID v4 and isNew=true on first call", async () => {
    const store = createSessionStore({ path: join(dir, "s.json") });
    const result = await store.getOrCreate("/foo", "haiku");
    expect(result.sessionId).toMatch(UUID_RE);
    expect(result.isNew).toBe(true);
  });

  test("getOrCreate reuses the most-recent session for same cwd (F9)", async () => {
    const store = createSessionStore({ path: join(dir, "s.json") });
    const first = await store.getOrCreate("/foo", "haiku");
    const second = await store.getOrCreate("/foo", "haiku");
    expect(second.sessionId).toBe(first.sessionId);
    expect(first.isNew).toBe(true);
    expect(second.isNew).toBe(false);
  });

  test("different cwds get different sessions", async () => {
    const store = createSessionStore({ path: join(dir, "s.json") });
    const a = await store.getOrCreate("/foo", "haiku");
    const b = await store.getOrCreate("/bar", "haiku");
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(a.isNew).toBe(true);
    expect(b.isNew).toBe(true);
  });

  test("newSession: true forces a fresh UUID even with recent session present", async () => {
    const store = createSessionStore({ path: join(dir, "s.json") });
    const a = await store.getOrCreate("/foo", "haiku");
    const b = await store.getOrCreate("/foo", "haiku", { newSession: true });
    expect(b.sessionId).not.toBe(a.sessionId);
    expect(b.isNew).toBe(true);
  });

  test("reuse window: expired sessions are not reused", async () => {
    let t = 0;
    const store = createSessionStore({
      path: join(dir, "s.json"),
      reuseWindowMs: 1000,
      now: () => t,
    });
    t = 1_000_000;
    const a = await store.getOrCreate("/foo", "haiku");
    t = 1_002_000; // 2s later, beyond window
    const b = await store.getOrCreate("/foo", "haiku");
    expect(b.sessionId).not.toBe(a.sessionId);
    expect(b.isNew).toBe(true);
  });

  test("reuse refreshes lastUsedAt", async () => {
    let t = 1000;
    const store = createSessionStore({
      path: join(dir, "s.json"),
      now: () => t,
    });
    const a = await store.getOrCreate("/foo", "haiku");
    t = 5000;
    const b = await store.getOrCreate("/foo", "haiku");
    expect(b.sessionId).toBe(a.sessionId);
    const records = await store.list();
    const rec = records.find((r) => r.sessionId === a.sessionId)!;
    expect(new Date(rec.lastUsedAt).getTime()).toBe(5000);
  });

  test("touch updates lastUsedAt without changing id", async () => {
    let t = 1000;
    const store = createSessionStore({ path: join(dir, "s.json"), now: () => t });
    const a = await store.getOrCreate("/foo", "haiku");
    t = 9999;
    await store.touch(a.sessionId);
    const records = await store.list();
    expect(records[0]!.sessionId).toBe(a.sessionId);
    expect(new Date(records[0]!.lastUsedAt).getTime()).toBe(9999);
  });

  test("list returns all stored sessions", async () => {
    const store = createSessionStore({ path: join(dir, "s.json") });
    await store.getOrCreate("/a", "haiku");
    await store.getOrCreate("/b", "haiku");
    await store.getOrCreate("/c", "haiku");
    const all = await store.list();
    expect(all).toHaveLength(3);
  });

  test("missing file → list returns []", async () => {
    const store = createSessionStore({ path: join(dir, "missing.json") });
    expect(await store.list()).toEqual([]);
  });

  test("filters invalid entries silently on load", async () => {
    const path = join(dir, "s.json");
    await writeFile(
      path,
      JSON.stringify([
        { sessionId: "good", cwd: "/x", createdAt: "2026-01-01T00:00:00Z", lastUsedAt: "2026-01-01T00:00:00Z" },
        { cwd: "/x" },
        "not an object",
        { sessionId: 42, cwd: "/y", createdAt: "x", lastUsedAt: "y" },
      ]),
    );
    const store = createSessionStore({ path });
    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0]!.sessionId).toBe("good");
  });

  test("file contents are valid JSON", async () => {
    const path = join(dir, "s.json");
    const store = createSessionStore({ path });
    await store.getOrCreate("/foo", "haiku");
    const raw = await readFile(path, "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  test("most-recent reuse picks newest when multiple sessions exist for cwd", async () => {
    let t = 1000;
    const store = createSessionStore({ path: join(dir, "s.json"), now: () => t });
    const a = await store.getOrCreate("/foo", "haiku");
    t = 2000;
    const b = await store.getOrCreate("/foo", "haiku", { newSession: true });
    t = 3000;
    const c = await store.getOrCreate("/foo", "haiku");
    expect(c.sessionId).toBe(b.sessionId);
    expect(c.sessionId).not.toBe(a.sessionId);
    expect(c.isNew).toBe(false);
  });
});

describe("appendClass", () => {
  test("appends class, caps at 5 entries (oldest dropped)", async () => {
    const store = createSessionStore({ path: join(dir, "s.json") });
    const { sessionId } = await store.getOrCreate("/foo", "sonnet");
    for (const cls of ["trivial", "simple", "standard", "hard", "reasoning", "max"]) {
      await store.appendClass(sessionId, cls);
    }
    const records = await store.list();
    const rec = records.find((r) => r.sessionId === sessionId);
    expect(rec?.recentClasses).toHaveLength(5);
    expect(rec?.recentClasses?.at(-1)).toBe("max");
    // "trivial" was the first pushed and should have been dropped
    expect(rec?.recentClasses?.[0]).toBe("simple");
  });

  test("new session starts with no recentClasses", async () => {
    const store = createSessionStore({ path: join(dir, "s.json") });
    const { sessionId } = await store.getOrCreate("/foo", "sonnet");
    const records = await store.list();
    const rec = records.find((r) => r.sessionId === sessionId);
    expect(rec?.recentClasses ?? []).toHaveLength(0);
  });
});

describe("appendTurnType", () => {
  test("appends turn type, caps at 5 entries (oldest dropped)", async () => {
    const store = createSessionStore({ path: join(dir, "s.json") });
    const { sessionId } = await store.getOrCreate("/foo", "sonnet");
    for (const t of ["user_prompt", "error_recovery", "error_recovery", "error_recovery", "user_prompt", "error_recovery"]) {
      await store.appendTurnType(sessionId, t);
    }
    const records = await store.list();
    const rec = records.find((r) => r.sessionId === sessionId);
    expect(rec?.recentTurnTypes).toHaveLength(5);
    expect(rec?.recentTurnTypes?.at(-1)).toBe("error_recovery");
    expect(rec?.recentTurnTypes?.[0]).toBe("error_recovery");
  });

  test("new session starts with no recentTurnTypes", async () => {
    const store = createSessionStore({ path: join(dir, "s.json") });
    const { sessionId } = await store.getOrCreate("/foo", "sonnet");
    const records = await store.list();
    const rec = records.find((r) => r.sessionId === sessionId);
    expect(rec?.recentTurnTypes ?? []).toHaveLength(0);
  });
});

describe("getByFingerprint", () => {
  test("creates new session for a new fingerprint", async () => {
    const store = createSessionStore({ path: join(dir, "s.json") });
    const result = await store.getByFingerprint("/foo", "abc123def456abcd");
    expect(result.sessionId).toMatch(UUID_RE);
    expect(result.isNew).toBe(true);
  });

  test("reuses session for same cwd + fingerprint", async () => {
    const store = createSessionStore({ path: join(dir, "s.json") });
    const first = await store.getByFingerprint("/foo", "abc123def456abcd");
    const second = await store.getByFingerprint("/foo", "abc123def456abcd");
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.isNew).toBe(false);
  });

  test("different fingerprints for same cwd get different sessions", async () => {
    const store = createSessionStore({ path: join(dir, "s.json") });
    const a = await store.getByFingerprint("/foo", "fingerprint-aaa");
    const b = await store.getByFingerprint("/foo", "fingerprint-bbb");
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(a.isNew).toBe(true);
    expect(b.isNew).toBe(true);
  });

  test("newSession: true forces fresh session even with matching fingerprint", async () => {
    const store = createSessionStore({ path: join(dir, "s.json") });
    const a = await store.getByFingerprint("/foo", "abc123def456abcd");
    const b = await store.getByFingerprint("/foo", "abc123def456abcd", { newSession: true });
    expect(b.sessionId).not.toBe(a.sessionId);
    expect(b.isNew).toBe(true);
  });

  test("expired fingerprint sessions are not reused", async () => {
    let t = 0;
    const store = createSessionStore({
      path: join(dir, "s.json"),
      reuseWindowMs: 1000,
      now: () => t,
    });
    t = 1_000_000;
    const a = await store.getByFingerprint("/foo", "fp-expiry-test");
    t = 1_002_000; // 2s later, beyond 1s window
    const b = await store.getByFingerprint("/foo", "fp-expiry-test");
    expect(b.sessionId).not.toBe(a.sessionId);
    expect(b.isNew).toBe(true);
  });

  test("getOrCreate and getByFingerprint use independent key namespaces (no cross-reuse)", async () => {
    // A session created via getOrCreate with modelTier "haiku" must NOT be reused
    // by getByFingerprint even if the derived fingerprint happened to collide.
    const store = createSessionStore({ path: join(dir, "s.json") });
    // Create via legacy API
    const legacy = await store.getOrCreate("/foo", "haiku");
    // Look up via fingerprint using a known fingerprint string (not the derived one)
    const fp = await store.getByFingerprint("/foo", "totally-different-fp");
    expect(fp.sessionId).not.toBe(legacy.sessionId);
    expect(fp.isNew).toBe(true);
  });
});

describe("stop reason and effort escalation", () => {
  test("updatePostTurnData persists stopReason and lastCacheReadTokens in one write", async () => {
    const store = createSessionStore({ path: join(dir, "s.json") });
    const { sessionId } = await store.getOrCreate("/foo", "haiku");
    await store.updatePostTurnData(sessionId, { stopReason: "max_tokens", lastCacheReadTokens: 42000 });
    const records = await store.list();
    const rec = records.find((r) => r.sessionId === sessionId);
    expect(rec?.lastStopReason).toBe("max_tokens");
    expect(rec?.lastCacheReadTokens).toBe(42000);
  });

  test("updatePostTurnData on unknown sessionId is a no-op (no throw)", async () => {
    const store = createSessionStore({ path: join(dir, "s.json") });
    await expect(store.updatePostTurnData("nonexistent-uuid", { stopReason: "end_turn", lastCacheReadTokens: 0 })).resolves.toBeUndefined();
  });

  test("setEffortEscalated marks session; getEffortEscalated returns true", async () => {
    const store = createSessionStore({ path: join(dir, "s.json") });
    const { sessionId } = await store.getOrCreate("/foo", "sonnet");
    expect(await store.getEffortEscalated(sessionId)).toBe(false);
    await store.setEffortEscalated(sessionId);
    expect(await store.getEffortEscalated(sessionId)).toBe(true);
  });

  test("getEffortEscalated returns false for unknown sessionId", async () => {
    const store = createSessionStore({ path: join(dir, "s.json") });
    expect(await store.getEffortEscalated("no-such-uuid")).toBe(false);
  });

  test("setEffortEscalated is idempotent", async () => {
    const store = createSessionStore({ path: join(dir, "s.json") });
    const { sessionId } = await store.getOrCreate("/foo", "opus");
    await store.setEffortEscalated(sessionId);
    await store.setEffortEscalated(sessionId);
    expect(await store.getEffortEscalated(sessionId)).toBe(true);
  });
});

describe("backward compat: legacy records without systemPromptFingerprint", () => {
  test("old record with only modelTier is NOT reused by getByFingerprint", async () => {
    const path = join(dir, "s.json");
    await writeFile(
      path,
      JSON.stringify([
        {
          sessionId: "legacy-session-id",
          cwd: "/foo",
          modelTier: "haiku",
          createdAt: new Date().toISOString(),
          lastUsedAt: new Date().toISOString(),
        },
      ]),
    );
    const store = createSessionStore({ path });
    const result = await store.getByFingerprint("/foo", "some-fingerprint");
    expect(result.sessionId).not.toBe("legacy-session-id");
    expect(result.isNew).toBe(true);
  });

  test("old record with only modelTier is still returned by list()", async () => {
    const path = join(dir, "s.json");
    await writeFile(
      path,
      JSON.stringify([
        {
          sessionId: "legacy-session-id",
          cwd: "/foo",
          modelTier: "haiku",
          createdAt: new Date().toISOString(),
          lastUsedAt: new Date().toISOString(),
        },
      ]),
    );
    const store = createSessionStore({ path });
    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0]!.sessionId).toBe("legacy-session-id");
  });

  test("getOrCreate (deprecated) creates sessions with systemPromptFingerprint set", async () => {
    const store = createSessionStore({ path: join(dir, "s.json") });
    const { sessionId } = await store.getOrCreate("/foo", "haiku");
    const records = await store.list();
    const rec = records.find((r) => r.sessionId === sessionId);
    expect(rec?.systemPromptFingerprint).toBeDefined();
    expect(typeof rec?.systemPromptFingerprint).toBe("string");
  });
});

describe("model-tier affinity", () => {
  test("same cwd, different modelTier → different sessions", async () => {
    const store = createSessionStore({ path: join(dir, "s.json") });
    const haiku = await store.getOrCreate("/foo", "haiku");
    const sonnet = await store.getOrCreate("/foo", "sonnet");
    expect(haiku.sessionId).not.toBe(sonnet.sessionId);
    expect(haiku.isNew).toBe(true);
    expect(sonnet.isNew).toBe(true);
  });

  test("same cwd, same modelTier → session reused", async () => {
    const store = createSessionStore({ path: join(dir, "s.json") });
    const first = await store.getOrCreate("/foo", "haiku");
    const second = await store.getOrCreate("/foo", "haiku");
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.isNew).toBe(false);
  });

  test("legacy record without modelTier is not reused for any tier", async () => {
    const path = join(dir, "s.json");
    await writeFile(
      path,
      JSON.stringify([
        {
          sessionId: "old-uuid",
          cwd: "/foo",
          createdAt: new Date().toISOString(),
          lastUsedAt: new Date().toISOString(),
        },
      ]),
    );
    const store = createSessionStore({ path });
    const result = await store.getOrCreate("/foo", "haiku");
    expect(result.sessionId).not.toBe("old-uuid");
    expect(result.isNew).toBe(true);
  });

  test("updateLastDecision persists prompt/class and getLastDecision retrieves them", async () => {
    const store = createSessionStore({ path: join(dir, "s.json") });
    const { sessionId } = await store.getOrCreate("/foo", "haiku");
    await store.updateLastDecision(sessionId, "fix the bug in auth.ts", "hard");
    const last = await store.getLastDecision(sessionId);
    expect(last).not.toBeNull();
    expect(last!.prompt).toBe("fix the bug in auth.ts");
    expect(last!.cls).toBe("hard");
  });

  test("getLastDecision returns null when no prior decision exists", async () => {
    const store = createSessionStore({ path: join(dir, "s.json") });
    const { sessionId } = await store.getOrCreate("/foo", "haiku");
    const last = await store.getLastDecision(sessionId);
    expect(last).toBeNull();
  });

  test("updateLastDecision stores the prompt verbatim (truncation is the caller's responsibility)", async () => {
    const store = createSessionStore({ path: join(dir, "s.json") });
    const { sessionId } = await store.getOrCreate("/foo", "haiku");
    const long = "x".repeat(600);
    await store.updateLastDecision(sessionId, long, "standard");
    const last = await store.getLastDecision(sessionId);
    expect(last!.prompt.length).toBe(600);
  });
});
