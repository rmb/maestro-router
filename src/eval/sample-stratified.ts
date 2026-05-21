// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import type { Class } from "../core/types.js";

export type StratifiedSampleOptions = {
  /** Classes to skip entirely (e.g. trivial — no cheaper tier to test). */
  excludeClasses?: ReadonlyArray<Class>;
};

/**
 * Pick up to `size` entries with roughly equal coverage per class.
 *
 * Deterministic: walks each class group in input order and takes the first
 * N per class. No RNG — reproducibility is required so tournament reports
 * can be diffed across runs.
 *
 * Algorithm:
 *   1. Drop any entry whose `expectedClass` is in `excludeClasses`.
 *   2. Group entries by `expectedClass` (preserving input order).
 *   3. Round-robin across classes until `size` is reached or every group is
 *      exhausted. This gives balanced coverage even when a class has fewer
 *      entries than the per-class quota.
 *
 * Returns entries in round-robin interleaved order (class-A[0], class-B[0],
 * class-A[1], class-B[1], …) so partial budget runs still hit every class.
 */
export function stratifiedSample<T extends { expectedClass: Class }>(
  entries: ReadonlyArray<T>,
  size: number,
  opts: StratifiedSampleOptions = {},
): T[] {
  if (size <= 0 || entries.length === 0) return [];
  const exclude = new Set<Class>(opts.excludeClasses ?? []);

  const groups = new Map<Class, T[]>();
  const order: Class[] = [];
  for (const e of entries) {
    if (exclude.has(e.expectedClass)) continue;
    let group = groups.get(e.expectedClass);
    if (!group) {
      group = [];
      groups.set(e.expectedClass, group);
      order.push(e.expectedClass);
    }
    group.push(e);
  }

  const out: T[] = [];
  const cursors = new Map<Class, number>();
  let anyTaken = true;
  while (out.length < size && anyTaken) {
    anyTaken = false;
    for (const cls of order) {
      if (out.length >= size) break;
      const cursor = cursors.get(cls) ?? 0;
      const group = groups.get(cls)!;
      if (cursor >= group.length) continue;
      out.push(group[cursor]!);
      cursors.set(cls, cursor + 1);
      anyTaken = true;
    }
  }
  return out;
}
