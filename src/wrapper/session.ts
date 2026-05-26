// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_PATH = join(homedir(), ".maestro", "sessions.json");
const DEFAULT_REUSE_WINDOW_MS = 24 * 60 * 60 * 1000;

export type SessionRecord = {
  sessionId: string;
  cwd: string;
  /** Model alias used for this session. Kept for backward compat and prewarm module. */
  modelTier?: string;
  /**
   * SHA-256 fingerprint of all system-prompt-affecting flags (first 16 hex chars).
   * When set, this is the key used for session reuse. Legacy records without this
   * field are never reused by new code that passes a fingerprint.
   */
  systemPromptFingerprint?: string;
  /** Last ≤5 routing classes, oldest first. Used for Markov prior. */
  recentClasses?: string[];
  createdAt: string;
  lastUsedAt: string;
  /** Truncated prompt from the last turn — used to emit correction events when the next turn uses @deep/@fast. */
  lastPrompt?: string;
  /** Class decided for the last turn — paired with lastPrompt for correction correlation. */
  lastDecisionClass?: string;
  /** ISO timestamp of the last turn — used to bound the correlation window. */
  lastDecisionAt?: string;
  /** Stop reason from the last turn (for E1.escalate and E4 in run-cmd.ts). */
  lastStopReason?: string;
  /** cache_read_input_tokens from the last turn — used for compaction advisory. */
  lastCacheReadTokens?: number;
  /** True if this session has been effort-escalated (for E1.escalate). */
  effortEscalated?: boolean;
  /**
   * P5: cumulative turn count for this session. Incremented on appendClass.
   * Used to log turnIndex on each decision event for per-session analysis.
   */
  turnCount?: number;
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
  /**
   * @deprecated Use `getByFingerprint` for new callers. This legacy overload
   * derives a fingerprint from modelTier via sha256 so existing code compiles
   * without changes, but sessions keyed this way will not be reused by
   * fingerprint-aware callers.
   */
  getOrCreate(cwd: string, modelTier: string, opts?: GetOrCreateOptions): Promise<GetOrCreateResult>;
  /** Fingerprint-keyed session lookup/creation. Preferred over getOrCreate. */
  getByFingerprint(cwd: string, fingerprint: string, opts?: GetOrCreateOptions): Promise<GetOrCreateResult>;
  touch(sessionId: string): Promise<void>;
  appendClass(sessionId: string, cls: string): Promise<void>;
  /** Buffer the last prompt + decided class so the next turn can emit a correction event. */
  updateLastDecision(sessionId: string, prompt: string, cls: string): Promise<void>;
  /** Read the last decision for the given session without side effects. */
  getLastDecision(sessionId: string): Promise<{ prompt: string; cls: string; ts: string } | null>;
  /** Persist stop_reason and cache_read_input_tokens from the last turn in one write. */
  updatePostTurnData(sessionId: string, data: { stopReason: string; lastCacheReadTokens: number }): Promise<void>;
  /** Mark the session as effort-escalated. */
  setEffortEscalated(sessionId: string): Promise<void>;
  /** Return true if the session has been effort-escalated. */
  getEffortEscalated(sessionId: string): Promise<boolean>;
  /** P5: read the cumulative turn count for telemetry. Returns 0 for unknown sessions. */
  getTurnCount(sessionId: string): Promise<number>;
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

  /** Core lookup/create logic keyed by fingerprint. */
  const getOrCreateByFingerprint = async (
    cwd: string,
    fingerprint: string,
    modelTier: string | undefined,
    options: GetOrCreateOptions | undefined,
  ): Promise<GetOrCreateResult> => {
    const records = await read();
    const nowIso = new Date(now()).toISOString();

    if (!options?.newSession) {
      const cutoff = now() - reuseWindowMs;
      const recent = records
        .filter(
          (r) =>
            r.cwd === cwd &&
            r.systemPromptFingerprint === fingerprint &&
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
      ...(modelTier !== undefined ? { modelTier } : {}),
      systemPromptFingerprint: fingerprint,
      createdAt: nowIso,
      lastUsedAt: nowIso,
    };
    await write([...records, created]);
    return { sessionId, isNew: true };
  };

  return {
    async getOrCreate(cwd, modelTier, options) {
      // Deprecated: derive fingerprint from modelTier so old callers keep working
      // but these sessions are NEVER reused by getByFingerprint callers (different key namespace).
      const fingerprint = createHash("sha256").update(modelTier).digest("hex").slice(0, 16);
      return getOrCreateByFingerprint(cwd, fingerprint, modelTier, options);
    },

    async getByFingerprint(cwd, fingerprint, options) {
      return getOrCreateByFingerprint(cwd, fingerprint, undefined, options);
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
        return { ...r, recentClasses: next, turnCount: (r.turnCount ?? 0) + 1 };
      });
      await write(updated);
    },

    async updateLastDecision(sessionId, prompt, cls) {
      const records = await read();
      const updated = records.map((r) =>
        r.sessionId === sessionId
          ? { ...r, lastPrompt: prompt.slice(0, 500), lastDecisionClass: cls, lastDecisionAt: new Date().toISOString() }
          : r,
      );
      await write(updated);
    },

    async getLastDecision(sessionId) {
      const records = await read();
      const r = records.find((s) => s.sessionId === sessionId);
      if (!r?.lastPrompt || !r.lastDecisionClass || !r.lastDecisionAt) return null;
      return { prompt: r.lastPrompt, cls: r.lastDecisionClass, ts: r.lastDecisionAt };
    },

    async updatePostTurnData(sessionId, data) {
      const records = await read();
      const updated = records.map((r) =>
        r.sessionId === sessionId ? { ...r, lastStopReason: data.stopReason, lastCacheReadTokens: data.lastCacheReadTokens } : r,
      );
      await write(updated);
    },

    async setEffortEscalated(sessionId) {
      const records = await read();
      const updated = records.map((r) =>
        r.sessionId === sessionId ? { ...r, effortEscalated: true } : r,
      );
      await write(updated);
    },

    async getEffortEscalated(sessionId) {
      const records = await read();
      const r = records.find((s) => s.sessionId === sessionId);
      return r?.effortEscalated === true;
    },

    async getTurnCount(sessionId) {
      const records = await read();
      const r = records.find((s) => s.sessionId === sessionId);
      return r?.turnCount ?? 0;
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
