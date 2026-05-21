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
  test("getOrCreate returns a UUID v4", async () => {
    const store = createSessionStore({ path: join(dir, "s.json") });
    const id = await store.getOrCreate("/foo");
    expect(id).toMatch(UUID_RE);
  });

  test("getOrCreate reuses the most-recent session for same cwd (F9)", async () => {
    const store = createSessionStore({ path: join(dir, "s.json") });
    const a = await store.getOrCreate("/foo");
    const b = await store.getOrCreate("/foo");
    expect(a).toBe(b);
  });

  test("different cwds get different sessions", async () => {
    const store = createSessionStore({ path: join(dir, "s.json") });
    const a = await store.getOrCreate("/foo");
    const b = await store.getOrCreate("/bar");
    expect(a).not.toBe(b);
  });

  test("newSession: true forces a fresh UUID even with recent session present", async () => {
    const store = createSessionStore({ path: join(dir, "s.json") });
    const a = await store.getOrCreate("/foo");
    const b = await store.getOrCreate("/foo", { newSession: true });
    expect(a).not.toBe(b);
  });

  test("reuse window: expired sessions are not reused", async () => {
    let t = 0;
    const store = createSessionStore({
      path: join(dir, "s.json"),
      reuseWindowMs: 1000,
      now: () => t,
    });
    t = 1_000_000;
    const a = await store.getOrCreate("/foo");
    t = 1_002_000; // 2s later, beyond window
    const b = await store.getOrCreate("/foo");
    expect(a).not.toBe(b);
  });

  test("reuse refreshes lastUsedAt", async () => {
    let t = 1000;
    const store = createSessionStore({
      path: join(dir, "s.json"),
      now: () => t,
    });
    const a = await store.getOrCreate("/foo");
    t = 5000;
    const b = await store.getOrCreate("/foo");
    expect(a).toBe(b);
    const records = await store.list();
    const rec = records.find((r) => r.sessionId === a)!;
    expect(new Date(rec.lastUsedAt).getTime()).toBe(5000);
  });

  test("touch updates lastUsedAt without changing id", async () => {
    let t = 1000;
    const store = createSessionStore({ path: join(dir, "s.json"), now: () => t });
    const a = await store.getOrCreate("/foo");
    t = 9999;
    await store.touch(a);
    const records = await store.list();
    expect(records[0]!.sessionId).toBe(a);
    expect(new Date(records[0]!.lastUsedAt).getTime()).toBe(9999);
  });

  test("list returns all stored sessions", async () => {
    const store = createSessionStore({ path: join(dir, "s.json") });
    await store.getOrCreate("/a");
    await store.getOrCreate("/b");
    await store.getOrCreate("/c");
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
        { cwd: "/x" }, // missing fields
        "not an object",
        { sessionId: 42, cwd: "/y", createdAt: "x", lastUsedAt: "y" }, // wrong type
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
    await store.getOrCreate("/foo");
    const raw = await readFile(path, "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  test("most-recent reuse picks newest when multiple sessions exist for cwd", async () => {
    let t = 1000;
    const store = createSessionStore({ path: join(dir, "s.json"), now: () => t });
    const a = await store.getOrCreate("/foo");
    t = 2000;
    const b = await store.getOrCreate("/foo", { newSession: true });
    t = 3000;
    const c = await store.getOrCreate("/foo");
    // c should reuse b (which is more recent than a)
    expect(c).toBe(b);
    expect(c).not.toBe(a);
  });
});
