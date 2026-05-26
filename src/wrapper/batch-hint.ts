// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0
//
// P9: detect quick-fire prompt clusters and emit an advisory hint suggesting
// the user batch them. Pure observation — no buffering, no auto-merging.
// Empirical basis: 53 clusters / 160 turns / $293 saved over 5 days in real
// telemetry (sequential cost $388 → batched ~$95, mean 67.5% savings/cluster).

const CLUSTER_WINDOW_MS = 30_000;
const MIN_CLUSTER_SIZE = 3;

type ClusterEvent = { ts: number; cls: string };

export type BatchHintState = {
  /** Ring buffer of recent prompt timestamps and routing classes. */
  events: ClusterEvent[];
  /** Whether we've already emitted the advisory in this proxy run. */
  emitted: boolean;
};

export function createBatchHintState(): BatchHintState {
  return { events: [], emitted: false };
}

/**
 * Update the cluster tracker with a new prompt event.
 * Returns a one-shot hint string when a fresh cluster is detected,
 * or null otherwise.
 *
 * Cluster definition:
 *   - ≥ MIN_CLUSTER_SIZE prompts arriving within CLUSTER_WINDOW_MS
 *   - all classified as trivial or simple (short, low-complexity)
 *   - not already advised in this proxy run
 *
 * The hint is emitted at most once per proxy run to avoid pestering.
 */
export function recordPromptAndMaybeAdvise(
  state: BatchHintState,
  cls: string,
  now: number = Date.now(),
): string | null {
  state.events.push({ ts: now, cls });
  // Prune events outside the window
  const cutoff = now - CLUSTER_WINDOW_MS;
  state.events = state.events.filter((e) => e.ts >= cutoff);

  if (state.emitted) return null;

  // Only count short-class prompts toward the cluster
  const shortPrompts = state.events.filter(
    (e) => e.cls === "trivial" || e.cls === "simple",
  );
  if (shortPrompts.length < MIN_CLUSTER_SIZE) return null;

  state.emitted = true;
  return (
    `maestro: ${shortPrompts.length} short prompts in ${Math.round(CLUSTER_WINDOW_MS / 1000)}s — ` +
    `combining them in one turn would amortize ~$0.05/turn of session-prefix cost. ` +
    `(See maestro guide for details.)`
  );
}
