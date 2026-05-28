// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0
// budget: 5ms per insert

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type * as Sqlite from "node:sqlite";
import type { TelemetryEvent } from "./types.js";

/**
 * Local SQLite query layer for telemetry. Uses Node's built-in `node:sqlite`
 * module (available since Node 22.5). JSONL remains the source of truth and
 * the export format — SQLite is purely an indexed query layer that mirrors
 * every event written to ~/.maestro/decisions.jsonl.
 *
 * When `node:sqlite` is unavailable (Node <22.5) every function in this
 * module degrades to a no-op and `openDb()` returns null — callers always
 * fall back to JSONL full-scan reads.
 */

const DEFAULT_DB_PATH = join(homedir(), ".maestro", "decisions.db");

type DatabaseSync = InstanceType<typeof Sqlite.DatabaseSync>;

let DatabaseSyncCtor: typeof Sqlite.DatabaseSync | null = null;
let SQLITE_AVAILABLE = false;

try {
  // Top-level await — ESM only. If `node:sqlite` is unavailable (Node <22.5)
  // or flagged experimental and not enabled, swallow the error and stay in
  // the "JSONL-only" degraded mode.
  const mod = await import("node:sqlite");
  DatabaseSyncCtor = mod.DatabaseSync;
  SQLITE_AVAILABLE = true;
} catch {
  DatabaseSyncCtor = null;
  SQLITE_AVAILABLE = false;
}

export function isSqliteAvailable(): boolean {
  return SQLITE_AVAILABLE;
}

export type MaestroDb = {
  insert(event: TelemetryEvent): void;
  query(sql: string, params?: ReadonlyArray<unknown>): unknown[];
  count(): number;
  close(): void;
};

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT NOT NULL,
  ts          TEXT NOT NULL,
  session_id  TEXT,
  turn_index  INTEGER,
  class       TEXT,
  classifier  TEXT,
  confidence  REAL,
  model       TEXT,
  effort      TEXT,
  prompt      TEXT,
  is_new_session INTEGER,
  cache_hit   INTEGER,
  total_cost_usd  REAL,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  cache_creation_tokens INTEGER,
  cache_read_tokens     INTEGER,
  duration_api_ms       INTEGER,
  stop_reason TEXT,
  raw_json    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ts         ON events(ts);
CREATE INDEX IF NOT EXISTS idx_type_ts    ON events(type, ts);
CREATE INDEX IF NOT EXISTS idx_session    ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_class      ON events(class);
CREATE INDEX IF NOT EXISTS idx_classifier ON events(classifier);
`;

const INSERT_SQL = `
INSERT INTO events (
  type, ts, session_id, turn_index, class, classifier, confidence,
  model, effort, prompt, is_new_session, cache_hit, total_cost_usd,
  input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
  duration_api_ms, stop_reason, raw_json
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

/** Cache of opened databases keyed by absolute path. */
const instances = new Map<string, MaestroDb>();

/**
 * Open (or reuse) the SQLite database at `path`. Returns null when `node:sqlite`
 * is unavailable. Migration from a sibling `decisions.jsonl` happens on first
 * open if the events table is empty.
 *
 * All errors are caught, logged to stderr, and result in a null return so the
 * caller can fall back to JSONL.
 */
export function openDb(path?: string): MaestroDb | null {
  if (!SQLITE_AVAILABLE || DatabaseSyncCtor === null) return null;
  const resolved = path ?? DEFAULT_DB_PATH;
  const cached = instances.get(resolved);
  if (cached !== undefined) return cached;

  try {
    mkdirSync(dirname(resolved), { recursive: true });
    const db = new DatabaseSyncCtor(resolved);
    db.exec(SCHEMA_SQL);

    const wrapped = wrap(db);
    instances.set(resolved, wrapped);

    // Migrate JSONL → SQLite once. The convention is `decisions.db` next to
    // `decisions.jsonl` — derive the JSONL path by swapping the suffix.
    const jsonlPath = resolved.endsWith(".db")
      ? resolved.slice(0, -3) + ".jsonl"
      : resolved + ".jsonl";
    maybeMigrate(wrapped, jsonlPath);

    return wrapped;
  } catch (err) {
    process.stderr.write(`maestro db: ${(err as Error).message}\n`);
    return null;
  }
}

function wrap(db: DatabaseSync): MaestroDb {
  const insertStmt = db.prepare(INSERT_SQL);
  const countStmt = db.prepare("SELECT COUNT(*) AS n FROM events");

  return {
    insert(event: TelemetryEvent): void {
      try {
        const cols = projectColumns(event);
        insertStmt.run(
          cols.type,
          cols.ts,
          cols.session_id,
          cols.turn_index,
          cols.class,
          cols.classifier,
          cols.confidence,
          cols.model,
          cols.effort,
          cols.prompt,
          cols.is_new_session,
          cols.cache_hit,
          cols.total_cost_usd,
          cols.input_tokens,
          cols.output_tokens,
          cols.cache_creation_tokens,
          cols.cache_read_tokens,
          cols.duration_api_ms,
          cols.stop_reason,
          cols.raw_json,
        );
      } catch (err) {
        process.stderr.write(`maestro db insert: ${(err as Error).message}\n`);
      }
    },

    query(sql: string, params: ReadonlyArray<unknown> = []): unknown[] {
      try {
        const stmt = db.prepare(sql);
        // node:sqlite accepts string | number | bigint | null | Uint8Array
        // as bound values. The caller is expected to pass compatible primitives.
        const args = params as ReadonlyArray<
          string | number | bigint | null | Uint8Array
        >;
        return stmt.all(...args) as unknown[];
      } catch (err) {
        process.stderr.write(`maestro db query: ${(err as Error).message}\n`);
        return [];
      }
    },

    count(): number {
      try {
        const row = countStmt.get() as { n: number } | undefined;
        return row?.n ?? 0;
      } catch (err) {
        process.stderr.write(`maestro db count: ${(err as Error).message}\n`);
        return 0;
      }
    },

    close(): void {
      try {
        db.close();
      } catch (err) {
        process.stderr.write(`maestro db close: ${(err as Error).message}\n`);
      }
    },
  };
}

type ProjectedRow = {
  type: string;
  ts: string;
  session_id: string | null;
  turn_index: number | null;
  class: string | null;
  classifier: string | null;
  confidence: number | null;
  model: string | null;
  effort: string | null;
  prompt: string | null;
  is_new_session: number | null;
  cache_hit: number | null;
  total_cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_creation_tokens: number | null;
  cache_read_tokens: number | null;
  duration_api_ms: number | null;
  stop_reason: string | null;
  raw_json: string;
};

/** Project a typed TelemetryEvent into the flat SQLite row shape. */
function projectColumns(event: TelemetryEvent): ProjectedRow {
  const base: ProjectedRow = {
    type: event.type,
    ts: event.ts,
    session_id: null,
    turn_index: null,
    class: null,
    classifier: null,
    confidence: null,
    model: null,
    effort: null,
    prompt: null,
    is_new_session: null,
    cache_hit: null,
    total_cost_usd: null,
    input_tokens: null,
    output_tokens: null,
    cache_creation_tokens: null,
    cache_read_tokens: null,
    duration_api_ms: null,
    stop_reason: null,
    raw_json: JSON.stringify(event),
  };

  // SQLite's node:sqlite driver refuses `undefined` parameters — every assignment
  // here uses `?? null` to coerce optional/missing fields to a bindable null.
  if (event.type === "decision") {
    base.session_id = event.sessionId ?? null;
    base.turn_index = event.turnIndex ?? null;
    base.class = event.decision.class ?? null;
    base.classifier = event.decision.classifier ?? null;
    base.confidence = event.decision.confidence ?? null;
    base.model = event.decision.spec?.model ?? null;
    base.effort = event.decision.spec?.effort ?? null;
    base.prompt = event.prompt ?? null;
    base.is_new_session = event.isNewSession === true ? 1 : event.isNewSession === false ? 0 : null;
    base.cache_hit = event.decision.cacheHit === true ? 1 : event.decision.cacheHit === false ? 0 : null;
    if (event.cost) {
      base.total_cost_usd = event.cost.totalCostUsd ?? null;
      base.input_tokens = event.cost.inputTokens ?? null;
      base.output_tokens = event.cost.outputTokens ?? null;
      base.cache_creation_tokens = event.cost.cacheCreationInputTokens ?? null;
      base.cache_read_tokens = event.cost.cacheReadInputTokens ?? null;
      base.duration_api_ms = event.cost.durationApiMs ?? null;
      base.stop_reason = event.cost.stopReason ?? null;
      base.model = event.cost.modelUsed ?? base.model;
    }
  } else if (event.type === "override") {
    base.class = event.from ?? null;
    base.prompt = event.prompt ?? null;
  } else if (event.type === "feedback") {
    base.session_id = event.sessionId ?? null;
  } else if (event.type === "outcome") {
    base.session_id = event.sessionId ?? null;
    base.class = event.decidedClass ?? null;
    base.output_tokens = event.outputTokens ?? null;
    base.cache_creation_tokens = event.cacheCreationTokens ?? null;
    base.total_cost_usd = event.totalCostUsd ?? null;
    base.duration_api_ms = event.durationApiMs ?? null;
    base.stop_reason = event.stopReason ?? null;
  } else if (event.type === "correction") {
    base.session_id = event.sessionId ?? null;
    base.class = event.prevClass ?? null;
    base.prompt = event.prevPrompt ?? null;
  } else if (event.type === "compact") {
    base.session_id = event.sessionId ?? null;
    base.cache_read_tokens = event.priorCacheReadTokens ?? null;
  }

  return base;
}

/**
 * Idempotent migration: if `events` table is empty and a JSONL file exists,
 * import every parseable line. Logs progress to stderr.
 */
function maybeMigrate(db: MaestroDb, jsonlPath: string): void {
  if (db.count() > 0) return;
  if (!existsSync(jsonlPath)) return;

  let raw: string;
  try {
    raw = readFileSync(jsonlPath, "utf8");
  } catch (err) {
    process.stderr.write(`maestro db migrate: ${(err as Error).message}\n`);
    return;
  }

  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return;

  process.stderr.write(`[maestro] migrating ${lines.length} events to SQLite...\n`);

  let inserted = 0;
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as TelemetryEvent;
      db.insert(event);
      inserted++;
    } catch {
      // Skip malformed lines silently — the JSONL remains source of truth.
    }
  }

  process.stderr.write(`[maestro] migrated ${inserted}/${lines.length} events\n`);
}

/** Test-only: clear the cached MaestroDb singletons so tests can use isolated dirs. */
export function _resetDbCache(): void {
  for (const db of instances.values()) {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
  instances.clear();
}
