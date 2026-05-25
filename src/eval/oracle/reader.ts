// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0
// budget: loadWindow is I/O-bound; groupBySession and pairDecisionsWithOutcomes are 0ms (pure)

import { readFile } from "node:fs/promises";
import type { TelemetryEvent } from "../../core/types.js";

export const PAIR_WINDOW_MS = 60_000;

/**
 * Load TelemetryEvent[] from a decisions.jsonl path, filtered to events
 * with ts >= sinceMs (epoch ms). Blank lines and parse errors are skipped.
 */
export async function loadWindow(
  path: string,
  sinceMs: number,
): Promise<TelemetryEvent[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const events: TelemetryEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let event: TelemetryEvent;
    try {
      event = JSON.parse(trimmed) as TelemetryEvent;
    } catch {
      continue;
    }
    if (new Date(event.ts).getTime() >= sinceMs) {
      events.push(event);
    }
  }
  return events;
}

/**
 * Group events by sessionId. Outcome, feedback, and correction events carry
 * a top-level sessionId. Decision and override events don't — they are placed
 * under "no-session".
 */
export function groupBySession(
  events: TelemetryEvent[],
): Map<string, TelemetryEvent[]> {
  const map = new Map<string, TelemetryEvent[]>();

  const push = (key: string, event: TelemetryEvent): void => {
    let bucket = map.get(key);
    if (!bucket) {
      bucket = [];
      map.set(key, bucket);
    }
    bucket.push(event);
  };

  for (const event of events) {
    if (
      event.type === "outcome" ||
      event.type === "feedback" ||
      event.type === "correction"
    ) {
      push(event.sessionId, event);
    } else {
      // decision, override, and any future types without a top-level sessionId
      push("no-session", event);
    }
  }

  return map;
}

type DecisionEvent = Extract<TelemetryEvent, { type: "decision" }>;
type OutcomeEvent = Extract<TelemetryEvent, { type: "outcome" }>;

/**
 * Pair decision events with their matching outcome event.
 * Greedy outcome-anchored match — finds the closest unmatched decision within
 * ±60 s of each outcome's ts. Decision events carry no sessionId, so sessionId
 * is not a match criterion. Returns only pairs where both sides exist.
 *
 * When multiple decisions could match an outcome, the closest-in-time decision
 * wins. Each decision and outcome is used at most once.
 */
export function pairDecisionsWithOutcomes(
  events: TelemetryEvent[],
): Array<{ decision: DecisionEvent; outcome: OutcomeEvent }> {
  const decisions = events.filter(
    (e): e is DecisionEvent => e.type === "decision",
  );
  const outcomes = events.filter(
    (e): e is OutcomeEvent => e.type === "outcome",
  );

  // Build a map of outcomes by sessionId for efficient lookup.
  // Multiple outcomes can share a sessionId (multi-turn sessions).
  const outcomesBySession = new Map<string, OutcomeEvent[]>();
  for (const outcome of outcomes) {
    let bucket = outcomesBySession.get(outcome.sessionId);
    if (!bucket) {
      bucket = [];
      outcomesBySession.set(outcome.sessionId, bucket);
    }
    bucket.push(outcome);
  }

  // For each outcome, find the closest decision within ±60s (outcome-anchored
  // matching ensures the nearest decision wins when multiple decisions compete).
  const usedDecisions = new Set<DecisionEvent>();

  const pairs: Array<{ decision: DecisionEvent; outcome: OutcomeEvent }> = [];

  for (const outcomeList of outcomesBySession.values()) {
    for (const outcome of outcomeList) {
      const outcomeTs = new Date(outcome.ts).getTime();

      let bestDecision: DecisionEvent | null = null;
      let bestDelta = Infinity;

      for (const decision of decisions) {
        if (usedDecisions.has(decision)) continue;
        const delta = Math.abs(new Date(decision.ts).getTime() - outcomeTs);
        if (delta <= PAIR_WINDOW_MS && delta < bestDelta) {
          bestDelta = delta;
          bestDecision = decision;
        }
      }

      if (bestDecision !== null) {
        usedDecisions.add(bestDecision);
        pairs.push({ decision: bestDecision, outcome });
      }
    }
  }

  return pairs;
}
