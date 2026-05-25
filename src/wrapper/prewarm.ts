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
 * Compute the system-prompt fingerprint from a decision spec.
 * Must match the fingerprint computed in run-cmd.ts and wire-compat.ts.
 * Pure function — no I/O.
 * budget: 0ms (no I/O, pure hash)
 */
export function computeFingerprint(spec: {
  model: string;
  tools?: string;
  mcpConfig?: string;
  bare?: boolean;
  excludeDynamicSections?: boolean;
  appendSystemPrompt?: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        spec.model,
        spec.tools ?? "default",
        spec.mcpConfig ?? "user-default",
        spec.bare ? "bare" : "full",
        spec.excludeDynamicSections ? "exclude" : "include",
        spec.appendSystemPrompt ?? "",
      ]),
    )
    .digest("hex")
    .slice(0, 16);
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
