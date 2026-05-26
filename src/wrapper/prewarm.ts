// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createSessionStore } from "./session.js";

export type PrewarmOptions = {
  sessionStorePath?: string;
  /** Path to claude binary. Defaults to "claude". */
  binary?: string;
  quiet?: boolean;
};

export type FingerprintSpec = {
  fingerprint: string;
  model: string;   // "haiku" | "sonnet" | "opus"
  effort: string;  // "low" | "medium" | "high"
};

/**
 * Compute the system-prompt fingerprint from ALL stable cache-affecting dimensions.
 * The Anthropic prompt cache is keyed by exact prefix bytes — any of these changes
 * invalidates the cache, so the fingerprint must capture them all.
 *
 * P1: previously only hashed {model, bare, excludeDynamic}, causing silent cache
 * misses on class swaps (different tools/mcpConfig/appendSystemPrompt) that
 * collided into the same fingerprint bucket. Now hashes 6 dimensions with
 * normalization so user-supplied variants don't accidentally invalidate.
 *
 * Pure function — no I/O.
 * budget: 0ms (no I/O, pure hash)
 */
export function computeFingerprint(spec: {
  model: string;
  bare?: boolean;
  excludeDynamicSections?: boolean;
  tools?: string;
  mcpConfig?: string;
  appendSystemPrompt?: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        spec.model,
        spec.bare ? "bare" : "full",
        spec.excludeDynamicSections ? "exclude" : "include",
        normalizeTools(spec.tools),
        normalizeMcpConfig(spec.mcpConfig),
        normalizeAppendPrompt(spec.appendSystemPrompt),
      ]),
    )
    .digest("hex")
    .slice(0, 16);
}

/** Sort tool list so "Read,Edit" and "Edit,Read" produce the same fingerprint. */
function normalizeTools(tools: string | undefined): string {
  if (!tools || tools === "default") return "default";
  return tools.split(",").map((t) => t.trim()).filter(Boolean).sort().join(",");
}

/** Canonicalize JSON so {a:1,b:2} and {b:2,a:1} produce the same fingerprint. */
function normalizeMcpConfig(json: string | undefined): string {
  if (!json) return "inherit";
  try {
    return JSON.stringify(sortKeys(JSON.parse(json) as unknown));
  } catch {
    return json;
  }
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.keys(v as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = sortKeys((v as Record<string, unknown>)[k]);
        return acc;
      }, {});
  }
  return v;
}

/** Collapse whitespace + trim so trivial formatting differences don't bust cache. */
function normalizeAppendPrompt(s: string | undefined): string {
  if (!s) return "";
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Ensure sessions exist (or will exist) for the given set of fingerprints.
 * Called fire-and-forget from run-cmd.ts / wire-compat.ts after a routing decision.
 * Spawns background `claude --print --session-id <new-uuid>` calls for any
 * fingerprint that has no recent session in the store.
 *
 * Does nothing when MAESTRO_DISABLE_TRACK_Z=1 is set.
 * Does nothing when called from inside a prewarm (avoids recursion via MAESTRO_PREWARM_RUNNING).
 */
export async function prewarmFingerprints(
  cwd: string,
  fingerprints: ReadonlyArray<FingerprintSpec>,
  opts?: PrewarmOptions,
): Promise<void> {
  if (process.env["MAESTRO_DISABLE_TRACK_Z"]) return;
  if (process.env["MAESTRO_PREWARM_RUNNING"]) return;
  if (fingerprints.length === 0) return;

  const binary = opts?.binary ?? "claude";
  const storeOpts = opts?.sessionStorePath !== undefined ? { path: opts.sessionStorePath } : {};
  const store = createSessionStore(storeOpts);

  const reuseWindowMs = 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - reuseWindowMs;
  const existing = await store.list();

  const missingSpecs = fingerprints.filter((spec) => {
    return !existing.some(
      (r) =>
        r.cwd === cwd &&
        r.systemPromptFingerprint === spec.fingerprint &&
        Date.parse(r.lastUsedAt) >= cutoff,
    );
  });

  if (missingSpecs.length === 0) return;

  for (const spec of missingSpecs) {
    // Create a placeholder session record so concurrent prewarms don't double-spawn.
    // getByFingerprint creates a new record if none exists for this fingerprint,
    // returning isNew=true only for the winner in a concurrent race.
    const result = await store.getByFingerprint(cwd, spec.fingerprint);
    const activeSessionId = result.sessionId;

    if (!result.isNew) {
      // A session was created concurrently (race with another prewarm) — skip spawn.
      continue;
    }

    // Fire-and-forget: prime the session with a single-char prompt so Claude Code
    // bootstraps its system-prompt cache for this fingerprint.
    const child = spawn(
      binary,
      [
        "--print",
        "--session-id",
        activeSessionId,
        "--resume",
        "--model",
        spec.model,
      ],
      {
        cwd,
        detached: true,
        stdio: ["pipe", "ignore", "ignore"],
        env: {
          ...process.env,
          MAESTRO_PREWARM_RUNNING: "1",
          MAESTRO_DISABLE_TRACK_Z: "1",
        },
      },
    );

    try {
      child.stdin?.write(".");
      child.stdin?.end();
    } catch {
      // stdin may not be writable if spawn failed immediately — ignore
    }

    child.unref();
  }
}
