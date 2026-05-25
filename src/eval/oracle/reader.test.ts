// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { TelemetryEvent } from "../../core/types.js";
import {
  groupBySession,
  loadWindow,
  pairDecisionsWithOutcomes,
} from "./reader.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpPath(): string {
  return join(tmpdir(), `maestro-reader-test-${randomUUID()}.jsonl`);
}

async function writeTmp(path: string, events: TelemetryEvent[]): Promise<void> {
  const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await writeFile(path, lines, "utf8");
}

function makeDecision(tsMs: number): Extract<TelemetryEvent, { type: "decision" }> {
  return {
    type: "decision",
    ts: new Date(tsMs).toISOString(),
    decision: {
      class: "standard",
      classifier: "heuristic",
      confidence: 0.8,
      spec: { model: "sonnet", effort: "medium", maxBudgetUsd: 0.1 },
      latencyMs: 5,
      diagnostics: [],
    },
  };
}

function makeOutcome(
  tsMs: number,
  sessionId: string,
): Extract<TelemetryEvent, { type: "outcome" }> {
  return {
    type: "outcome",
    ts: new Date(tsMs).toISOString(),
    sessionId,
    decidedClass: "standard",
    stopReason: "end_turn",
    outputTokens: 100,
    cacheCreationTokens: 0,
    totalCostUsd: 0.001,
    durationApiMs: 1200,
  };
}

function makeOverride(tsMs: number): Extract<TelemetryEvent, { type: "override" }> {
  return {
    type: "override",
    ts: new Date(tsMs).toISOString(),
    from: "standard",
    to: "hard",
    prompt: "do something hard",
  };
}

function makeFeedback(
  tsMs: number,
  sessionId: string,
): Extract<TelemetryEvent, { type: "feedback" }> {
  return {
    type: "feedback",
    ts: new Date(tsMs).toISOString(),
    sessionId,
    rating: 4,
    source: "manual",
  };
}

function makeCorrection(
  tsMs: number,
  sessionId: string,
): Extract<TelemetryEvent, { type: "correction" }> {
  return {
    type: "correction",
    ts: new Date(tsMs).toISOString(),
    sessionId,
    prevClass: "standard",
    correctedToClass: "hard",
    hint: "@deep",
    prevPrompt: "some prompt",
  };
}

// ---------------------------------------------------------------------------
// loadWindow
// ---------------------------------------------------------------------------

describe("loadWindow", () => {
  let path: string;

  beforeEach(() => {
    path = tmpPath();
  });

  afterEach(async () => {
    const { unlink } = await import("node:fs/promises");
    await unlink(path).catch(() => undefined);
  });

  test("returns [] for non-existent file", async () => {
    const result = await loadWindow(path, 0);
    expect(result).toEqual([]);
  });

  test("returns [] for empty file", async () => {
    await writeFile(path, "", "utf8");
    const result = await loadWindow(path, 0);
    expect(result).toEqual([]);
  });

  test("returns single event when it passes the sinceMs filter", async () => {
    const now = Date.now();
    const event = makeDecision(now);
    await writeTmp(path, [event]);
    const result = await loadWindow(path, now - 1000);
    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe("decision");
  });

  test("filters out events older than sinceMs", async () => {
    const now = Date.now();
    const old = makeDecision(now - 10_000);
    const recent = makeDecision(now);
    await writeTmp(path, [old, recent]);
    const result = await loadWindow(path, now - 1000);
    expect(result).toHaveLength(1);
    expect(new Date(result[0]!.ts).getTime()).toBeGreaterThanOrEqual(now - 1000);
  });

  test("includes event exactly at sinceMs boundary", async () => {
    const now = Date.now();
    const event = makeDecision(now);
    await writeTmp(path, [event]);
    const result = await loadWindow(path, now);
    expect(result).toHaveLength(1);
  });

  test("returns all events when sinceMs is 0", async () => {
    const now = Date.now();
    const events = [makeDecision(now - 5000), makeDecision(now - 1000), makeDecision(now)];
    await writeTmp(path, events);
    const result = await loadWindow(path, 0);
    expect(result).toHaveLength(3);
  });

  test("skips blank lines", async () => {
    const now = Date.now();
    const event = makeDecision(now);
    await writeFile(
      path,
      `\n${JSON.stringify(event)}\n\n`,
      "utf8",
    );
    const result = await loadWindow(path, 0);
    expect(result).toHaveLength(1);
  });

  test("skips lines that are not valid JSON", async () => {
    const now = Date.now();
    const event = makeDecision(now);
    await writeFile(
      path,
      `not-json\n${JSON.stringify(event)}\nbroken{json\n`,
      "utf8",
    );
    const result = await loadWindow(path, 0);
    expect(result).toHaveLength(1);
  });

  test("handles mixed event types", async () => {
    const now = Date.now();
    const sessionId = randomUUID();
    const events: TelemetryEvent[] = [
      makeDecision(now),
      makeOutcome(now + 500, sessionId),
      makeFeedback(now + 1000, sessionId),
      makeOverride(now + 2000),
    ];
    await writeTmp(path, events);
    const result = await loadWindow(path, now - 100);
    expect(result).toHaveLength(4);
    const types = result.map((e) => e.type);
    expect(types).toContain("decision");
    expect(types).toContain("outcome");
    expect(types).toContain("feedback");
    expect(types).toContain("override");
  });
});

// ---------------------------------------------------------------------------
// groupBySession
// ---------------------------------------------------------------------------

describe("groupBySession", () => {
  test("returns empty map for empty input", () => {
    const result = groupBySession([]);
    expect(result.size).toBe(0);
  });

  test("groups outcome events by sessionId", () => {
    const now = Date.now();
    const sid1 = "session-1";
    const sid2 = "session-2";
    const events: TelemetryEvent[] = [
      makeOutcome(now, sid1),
      makeOutcome(now + 100, sid2),
      makeOutcome(now + 200, sid1),
    ];
    const result = groupBySession(events);
    expect(result.size).toBe(2);
    expect(result.get(sid1)).toHaveLength(2);
    expect(result.get(sid2)).toHaveLength(1);
  });

  test("groups feedback events by sessionId", () => {
    const now = Date.now();
    const sid = "session-fb";
    const events: TelemetryEvent[] = [makeFeedback(now, sid), makeFeedback(now + 100, sid)];
    const result = groupBySession(events);
    expect(result.get(sid)).toHaveLength(2);
  });

  test("groups correction events by sessionId", () => {
    const now = Date.now();
    const sid = "session-corr";
    const events: TelemetryEvent[] = [makeCorrection(now, sid)];
    const result = groupBySession(events);
    expect(result.get(sid)).toHaveLength(1);
  });

  test("decision events go into no-session group", () => {
    const now = Date.now();
    const events: TelemetryEvent[] = [makeDecision(now), makeDecision(now + 100)];
    const result = groupBySession(events);
    expect(result.get("no-session")).toHaveLength(2);
  });

  test("override events go into no-session group", () => {
    const now = Date.now();
    const events: TelemetryEvent[] = [makeOverride(now)];
    const result = groupBySession(events);
    expect(result.get("no-session")).toHaveLength(1);
  });

  test("mixed events are bucketed correctly", () => {
    const now = Date.now();
    const sid = "session-mixed";
    const events: TelemetryEvent[] = [
      makeDecision(now),
      makeOutcome(now + 500, sid),
      makeOverride(now + 1000),
      makeFeedback(now + 1500, sid),
    ];
    const result = groupBySession(events);
    expect(result.get("no-session")).toHaveLength(2);
    expect(result.get(sid)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// pairDecisionsWithOutcomes
// ---------------------------------------------------------------------------

describe("pairDecisionsWithOutcomes", () => {
  test("returns [] for empty input", () => {
    expect(pairDecisionsWithOutcomes([])).toEqual([]);
  });

  test("returns [] when there are no outcomes", () => {
    const now = Date.now();
    const events: TelemetryEvent[] = [makeDecision(now)];
    expect(pairDecisionsWithOutcomes(events)).toEqual([]);
  });

  test("returns [] when there are no decisions", () => {
    const now = Date.now();
    const events: TelemetryEvent[] = [makeOutcome(now, "sid")];
    expect(pairDecisionsWithOutcomes(events)).toEqual([]);
  });

  test("pairs decision with outcome within 60s", () => {
    const now = Date.now();
    const decision = makeDecision(now);
    const outcome = makeOutcome(now + 30_000, "sid-a"); // 30s later — within window
    const pairs = pairDecisionsWithOutcomes([decision, outcome]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.decision.type).toBe("decision");
    expect(pairs[0]!.outcome.type).toBe("outcome");
  });

  test("exact match at ts boundary (same timestamp)", () => {
    const now = Date.now();
    const decision = makeDecision(now);
    const outcome = makeOutcome(now, "sid-exact");
    const pairs = pairDecisionsWithOutcomes([decision, outcome]);
    expect(pairs).toHaveLength(1);
  });

  test("does not match outcome outside ±60s window", () => {
    const now = Date.now();
    const decision = makeDecision(now);
    const outcome = makeOutcome(now + 61_000, "sid-late"); // 61s — outside window
    const pairs = pairDecisionsWithOutcomes([decision, outcome]);
    expect(pairs).toHaveLength(0);
  });

  test("does not match outcome 60s before decision (outside window)", () => {
    const now = Date.now();
    const decision = makeDecision(now);
    const outcome = makeOutcome(now - 61_000, "sid-early");
    const pairs = pairDecisionsWithOutcomes([decision, outcome]);
    expect(pairs).toHaveLength(0);
  });

  test("matches outcome exactly at 60s boundary", () => {
    const now = Date.now();
    const decision = makeDecision(now);
    const outcome = makeOutcome(now + 60_000, "sid-boundary");
    const pairs = pairDecisionsWithOutcomes([decision, outcome]);
    expect(pairs).toHaveLength(1);
  });

  test("unpaired decisions are excluded from results", () => {
    const now = Date.now();
    const pairedDecision = makeDecision(now);
    const unpairedDecision = makeDecision(now + 200_000); // far in the future, no outcome
    const outcome = makeOutcome(now + 500, "sid-partial");
    const pairs = pairDecisionsWithOutcomes([pairedDecision, unpairedDecision, outcome]);
    expect(pairs).toHaveLength(1);
    expect(new Date(pairs[0]!.decision.ts).getTime()).toBe(now);
  });

  test("unpaired outcomes are excluded from results", () => {
    const now = Date.now();
    const decision = makeDecision(now);
    const matchedOutcome = makeOutcome(now + 1000, "sid-matched");
    const unmatchedOutcome = makeOutcome(now + 150_000, "sid-unmatched"); // too far
    const pairs = pairDecisionsWithOutcomes([decision, matchedOutcome, unmatchedOutcome]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.outcome.sessionId).toBe("sid-matched");
  });

  test("each outcome is used at most once (no double-pairing)", () => {
    const now = Date.now();
    const d1 = makeDecision(now);
    const d2 = makeDecision(now + 1000); // also within 60s of same outcome
    const outcome = makeOutcome(now + 500, "sid-shared");
    const pairs = pairDecisionsWithOutcomes([d1, d2, outcome]);
    // Only one decision should claim the outcome
    expect(pairs).toHaveLength(1);
  });

  test("closest decision wins when multiple decisions compete for same outcome", () => {
    const now = Date.now();
    const dClose = makeDecision(now + 100);  // 400ms from outcome
    const dFar = makeDecision(now + 10_000); // 9.5s from outcome
    const outcome = makeOutcome(now + 500, "sid-compete");
    const pairs = pairDecisionsWithOutcomes([dFar, dClose, outcome]);
    expect(pairs).toHaveLength(1);
    // The closer decision (dClose at now+100) should win
    expect(new Date(pairs[0]!.decision.ts).getTime()).toBe(now + 100);
  });

  test("non-decision/outcome events are ignored", () => {
    const now = Date.now();
    const sid = "sid-noise";
    const events: TelemetryEvent[] = [
      makeDecision(now),
      makeOutcome(now + 1000, sid),
      makeFeedback(now + 2000, sid),
      makeOverride(now + 3000),
      makeCorrection(now + 4000, sid),
    ];
    const pairs = pairDecisionsWithOutcomes(events);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.decision.type).toBe("decision");
    expect(pairs[0]!.outcome.type).toBe("outcome");
  });
});
