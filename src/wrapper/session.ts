// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_PATH = join(homedir(), ".maestro", "sessions.json");
const DEFAULT_REUSE_WINDOW_MS = 24 * 60 * 60 * 1000;

export type SessionRecord = {
  sessionId: string;
  cwd: string;
  /** Model alias used for this session. Legacy records missing this field are never reused (treated as unknown tier). */
  modelTier?: string;
  /** Last ≤5 routing classes, oldest first. Used for Markov prior. */
  recentClasses?: string[];
  createdAt: string;
  lastUsedAt: string;
};

export type SessionStoreOptions = {
  path?: string;
  reuseWindowMs?: number;
  now?: () => number;
};

export type GetOrCreateOptions = {
  /** Force a fresh session id even if a recent one exists for this cwd. */
  newSession?: boolean;
};

export type GetOrCreateResult = {
  sessionId: string;
  /** true if a new session was created; false if an existing one was reused. */
  isNew: boolean;
};

export type SessionStore = {
  getOrCreate(cwd: string, modelTier: string, opts?: GetOrCreateOptions): Promise<GetOrCreateResult>;
  touch(sessionId: string): Promise<void>;
  appendClass(sessionId: string, cls: string): Promise<void>;
  list(): Promise<SessionRecord[]>;
};

/**
 * Filesystem-backed session store. Aggressively reuses the most recent
 * session for a given cwd (F9 — amortizes Claude Code's ~37k cache_creation
 * cost per session bootstrap). Records expire from the reuse pool after
 * `reuseWindowMs` (24h default), though they remain in the file.
 */
export function createSessionStore(opts: SessionStoreOptions = {}): SessionStore {
  const path = opts.path ?? DEFAULT_PATH;
  const reuseWindowMs = opts.reuseWindowMs ?? DEFAULT_REUSE_WINDOW_MS;
  const now = opts.now ?? Date.now;

  const read = async (): Promise<SessionRecord[]> => {
    try {
      const data = await readFile(path, "utf8");
      const parsed: unknown = JSON.parse(data);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isValidSession);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      return [];
    }
  };

  const write = async (records: ReadonlyArray<SessionRecord>): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(records, null, 2), "utf8");
  };

  return {
    async getOrCreate(cwd, modelTier, options) {
      const records = await read();
      const nowIso = new Date(now()).toISOString();

      if (!options?.newSession) {
        const cutoff = now() - reuseWindowMs;
        const recent = records
          .filter(
            (r) =>
              r.cwd === cwd &&
              r.modelTier === modelTier &&
              Date.parse(r.lastUsedAt) >= cutoff,
          )
          .sort((a, b) => Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt));
        if (recent.length > 0) {
          const reused = recent[0]!;
          const updated = records.map((r) =>
            r.sessionId === reused.sessionId ? { ...r, lastUsedAt: nowIso } : r,
          );
          await write(updated);
          return { sessionId: reused.sessionId, isNew: false };
        }
      }

      const sessionId = randomUUID();
      const created: SessionRecord = {
        sessionId,
        cwd,
        modelTier,
        createdAt: nowIso,
        lastUsedAt: nowIso,
      };
      await write([...records, created]);
      return { sessionId, isNew: true };
    },

    async touch(sessionId) {
      const records = await read();
      const nowIso = new Date(now()).toISOString();
      const updated = records.map((r) =>
        r.sessionId === sessionId ? { ...r, lastUsedAt: nowIso } : r,
      );
      await write(updated);
    },

    async appendClass(sessionId, cls) {
      const records = await read();
      const updated = records.map((r) => {
        if (r.sessionId !== sessionId) return r;
        const prev = r.recentClasses ?? [];
        const next = [...prev, cls].slice(-5); // keep last 5
        return { ...r, recentClasses: next };
      });
      await write(updated);
    },

    async list() {
      return read();
    },
  };
}

function isValidSession(value: unknown): value is SessionRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.sessionId === "string" &&
    typeof r.cwd === "string" &&
    typeof r.createdAt === "string" &&
    typeof r.lastUsedAt === "string"
  );
}
