// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetDbCache, isSqliteAvailable, openDb } from "./db.js";
import type { TelemetryEvent } from "./types.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "maestro-db-"));
  _resetDbCache();
});

afterEach(async () => {
  _resetDbCache();
  await rm(dir, { recursive: true, force: true });
});

const decision = (ts: string, prompt?: string): TelemetryEvent => ({
  type: "decision",
  ts,
  decision: {
    class: "trivial",
    classifier: "heuristic",
    confidence: 0.9,
    spec: { model: "haiku", effort: "low", maxBudgetUsd: 0.05 },
    latencyMs: 5,
    diagnostics: [],
  },
  ...(prompt !== undefined ? { prompt } : {}),
});

describe("openDb", () => {
  test("returns a MaestroDb instance when node:sqlite is available", () => {
    if (!isSqliteAvailable()) return;
    const db = openDb(join(dir, "decisions.db"));
    expect(db).not.toBeNull();
    expect(db!.count()).toBe(0);
  });

  test("does not throw on a valid path", () => {
    expect(() => openDb(join(dir, "decisions.db"))).not.toThrow();
  });

  test("reuses the same instance for the same path", () => {
    if (!isSqliteAvailable()) return;
    const a = openDb(join(dir, "decisions.db"));
    const b = openDb(join(dir, "decisions.db"));
    expect(a).toBe(b);
  });
});

describe("MaestroDb.insert + count", () => {
  test("inserts a decision event and round-trips through raw_json", () => {
    if (!isSqliteAvailable()) return;
    const db = openDb(join(dir, "decisions.db"))!;
    const ev = decision("2026-05-21T10:00:00.000Z", "hello world");
    db.insert(ev);
    expect(db.count()).toBe(1);

    const rows = db.query("SELECT raw_json FROM events") as Array<{ raw_json: string }>;
    expect(rows).toHaveLength(1);
    const parsed = JSON.parse(rows[0]!.raw_json) as TelemetryEvent;
    expect(parsed.type).toBe("decision");
    expect((parsed as { prompt?: string }).prompt).toBe("hello world");
  });

  test("inserts multiple event types and counts them all", () => {
    if (!isSqliteAvailable()) return;
    const db = openDb(join(dir, "decisions.db"))!;
    db.insert(decision("2026-05-21T10:00:00.000Z"));
    db.insert({
      type: "override",
      ts: "2026-05-21T10:01:00.000Z",
      from: "simple",
      to: "hard",
      prompt: "rewrite",
    });
    db.insert({
      type: "feedback",
      ts: "2026-05-21T10:02:00.000Z",
      sessionId: "s1",
      rating: 5,
    });
    expect(db.count()).toBe(3);
  });
});

describe("MaestroDb.query", () => {
  test("supports parameterized queries", () => {
    if (!isSqliteAvailable()) return;
    const db = openDb(join(dir, "decisions.db"))!;
    db.insert(decision("2026-05-21T10:00:00.000Z"));
    db.insert(decision("2026-05-22T10:00:00.000Z"));
    const rows = db.query(
      "SELECT COUNT(*) AS n FROM events WHERE ts >= ?",
      ["2026-05-22T00:00:00.000Z"],
    ) as Array<{ n: number }>;
    expect(rows[0]!.n).toBe(1);
  });

  test("indexes columns for common stats queries", () => {
    if (!isSqliteAvailable()) return;
    const db = openDb(join(dir, "decisions.db"))!;
    db.insert(decision("2026-05-21T10:00:00.000Z", "p1"));
    db.insert(decision("2026-05-21T10:01:00.000Z", "p2"));
    const rows = db.query(
      "SELECT class, COUNT(*) AS n FROM events WHERE type='decision' GROUP BY class",
    ) as Array<{ class: string; n: number }>;
    expect(rows).toEqual([{ class: "trivial", n: 2 }]);
  });
});

describe("JSONL → SQLite migration", () => {
  test("imports a sibling decisions.jsonl on first open", async () => {
    if (!isSqliteAvailable()) return;
    const jsonl = join(dir, "decisions.jsonl");
    const events: TelemetryEvent[] = [
      decision("2026-05-21T10:00:00.000Z", "a"),
      decision("2026-05-21T10:01:00.000Z", "b"),
      decision("2026-05-21T10:02:00.000Z", "c"),
    ];
    await writeFile(jsonl, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");

    const db = openDb(join(dir, "decisions.db"))!;
    expect(db.count()).toBe(3);
  });

  test("does not double-migrate on reopen", async () => {
    if (!isSqliteAvailable()) return;
    const jsonl = join(dir, "decisions.jsonl");
    const events: TelemetryEvent[] = [
      decision("2026-05-21T10:00:00.000Z", "a"),
      decision("2026-05-21T10:01:00.000Z", "b"),
    ];
    await writeFile(jsonl, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");

    const db1 = openDb(join(dir, "decisions.db"))!;
    expect(db1.count()).toBe(2);

    // Drop the cache to force a fresh open against the same file.
    _resetDbCache();
    const db2 = openDb(join(dir, "decisions.db"))!;
    expect(db2.count()).toBe(2);
  });

  test("no-op when JSONL is missing", () => {
    if (!isSqliteAvailable()) return;
    const db = openDb(join(dir, "decisions.db"))!;
    expect(db.count()).toBe(0);
  });
});
