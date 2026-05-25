// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { buildReport, printReport } from "./report.js";
import type { DimensionResult } from "./telemetry-correctness.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const passingDim: DimensionResult = {
  dimension: "tool",
  pass: true,
  checks: [
    { name: "tool-check-1", pass: true, value: "100.0%", gate: "≥90%" },
    { name: "tool-check-2", pass: true, value: "99.0%", gate: "≥90%" },
  ],
};

const failingDim: DimensionResult = {
  dimension: "quality",
  pass: false,
  checks: [
    { name: "e1-quality-probe", pass: false, value: "54.0%", gate: "≥60%", detail: "E1 savings below expected. Consider reverting standard effort for hard sub-types." },
    { name: "quality-check-2", pass: true, value: "80.0%", gate: "≥70%" },
  ],
};

const allPassDimensions: DimensionResult[] = [
  passingDim,
  { dimension: "telemetry", pass: true, checks: [{ name: "cost-reconciliation", pass: true, value: "$0.100", gate: "±1%" }] },
];

const mixedDimensions: DimensionResult[] = [
  passingDim,
  failingDim,
];

// ---------------------------------------------------------------------------
// buildReport
// ---------------------------------------------------------------------------

describe("buildReport", () => {
  it("sets generatedAt to provided value", () => {
    const ts = "2026-05-25T10:00:00.000Z";
    const report = buildReport({ generatedAt: ts, windowDays: 7, totalEvents: 100, dimensions: allPassDimensions });
    expect(report.generatedAt).toBe(ts);
  });

  it("defaults generatedAt to a valid ISO string when not provided", () => {
    const before = Date.now();
    const report = buildReport({ windowDays: 7, totalEvents: 100, dimensions: allPassDimensions });
    const after = Date.now();
    const ts = new Date(report.generatedAt).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("sets overallPass = true when all dimensions pass", () => {
    const report = buildReport({ windowDays: 7, totalEvents: 140, dimensions: allPassDimensions });
    expect(report.overallPass).toBe(true);
  });

  it("sets overallPass = false when any dimension fails", () => {
    const report = buildReport({ windowDays: 7, totalEvents: 140, dimensions: mixedDimensions });
    expect(report.overallPass).toBe(false);
  });

  it("preserves windowDays and totalEvents", () => {
    const report = buildReport({ windowDays: 14, totalEvents: 300, dimensions: allPassDimensions });
    expect(report.windowDays).toBe(14);
    expect(report.totalEvents).toBe(300);
  });

  it("preserves dimensions array reference", () => {
    const report = buildReport({ windowDays: 7, totalEvents: 50, dimensions: allPassDimensions });
    expect(report.dimensions).toBe(allPassDimensions);
  });
});

// ---------------------------------------------------------------------------
// printReport — json mode
// ---------------------------------------------------------------------------

describe("printReport json mode", () => {
  it("returns valid JSON", () => {
    const report = buildReport({ generatedAt: "2026-05-25T00:00:00.000Z", windowDays: 7, totalEvents: 140, dimensions: mixedDimensions });
    const out = printReport(report, { json: true });
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it("JSON output matches report shape", () => {
    const report = buildReport({ generatedAt: "2026-05-25T00:00:00.000Z", windowDays: 7, totalEvents: 140, dimensions: mixedDimensions });
    const out = printReport(report, { json: true });
    const parsed = JSON.parse(out);
    expect(parsed.generatedAt).toBe(report.generatedAt);
    expect(parsed.windowDays).toBe(report.windowDays);
    expect(parsed.totalEvents).toBe(report.totalEvents);
    expect(parsed.overallPass).toBe(report.overallPass);
    expect(Array.isArray(parsed.dimensions)).toBe(true);
    expect(parsed.dimensions).toHaveLength(report.dimensions.length);
  });
});

// ---------------------------------------------------------------------------
// printReport — quiet mode
// ---------------------------------------------------------------------------

describe("printReport quiet mode", () => {
  it("returns empty string", () => {
    const report = buildReport({ windowDays: 7, totalEvents: 100, dimensions: allPassDimensions });
    expect(printReport(report, { quiet: true })).toBe("");
  });
});

// ---------------------------------------------------------------------------
// printReport — human mode
// ---------------------------------------------------------------------------

describe("printReport human mode", () => {
  it("contains the date from generatedAt", () => {
    const report = buildReport({ generatedAt: "2026-05-25T10:00:00.000Z", windowDays: 7, totalEvents: 140, dimensions: mixedDimensions });
    const out = printReport(report);
    expect(out).toContain("2026-05-25");
  });

  it("contains window and event count", () => {
    const report = buildReport({ generatedAt: "2026-05-25T00:00:00.000Z", windowDays: 7, totalEvents: 140, dimensions: mixedDimensions });
    const out = printReport(report);
    expect(out).toContain("7d");
    expect(out).toContain("140 events");
  });

  it("contains all dimension names", () => {
    const report = buildReport({ generatedAt: "2026-05-25T00:00:00.000Z", windowDays: 7, totalEvents: 140, dimensions: mixedDimensions });
    const out = printReport(report);
    expect(out).toContain("tool");
    expect(out).toContain("quality");
  });

  it("shows ✓ for passing dimensions and ✗ for failing", () => {
    const report = buildReport({ generatedAt: "2026-05-25T00:00:00.000Z", windowDays: 7, totalEvents: 140, dimensions: mixedDimensions });
    const out = printReport(report);
    expect(out).toContain("✓");
    expect(out).toContain("✗");
  });

  it("shows failure detail block for failing dimension", () => {
    const report = buildReport({ generatedAt: "2026-05-25T00:00:00.000Z", windowDays: 7, totalEvents: 140, dimensions: mixedDimensions });
    const out = printReport(report);
    expect(out).toContain("e1-quality-probe");
    expect(out).toContain("54.0%");
    expect(out).toContain("≥60%");
    expect(out).toContain("E1 savings below expected");
  });

  it("does not show detail block for passing dimension", () => {
    const report = buildReport({ generatedAt: "2026-05-25T00:00:00.000Z", windowDays: 7, totalEvents: 140, dimensions: mixedDimensions });
    const out = printReport(report);
    // tool is passing — its individual check names should not appear in detail
    expect(out).not.toContain("tool-check-1");
    expect(out).not.toContain("tool-check-2");
  });

  it("shows overall pass count", () => {
    const report = buildReport({ generatedAt: "2026-05-25T00:00:00.000Z", windowDays: 7, totalEvents: 140, dimensions: mixedDimensions });
    const out = printReport(report);
    expect(out).toContain("1/2 dimensions passed");
  });

  it("includes exit 1 marker when overallPass is false", () => {
    const report = buildReport({ generatedAt: "2026-05-25T00:00:00.000Z", windowDays: 7, totalEvents: 140, dimensions: mixedDimensions });
    const out = printReport(report);
    expect(out).toContain("exit 1");
  });

  it("does not include exit 1 marker when all pass", () => {
    const report = buildReport({ generatedAt: "2026-05-25T00:00:00.000Z", windowDays: 7, totalEvents: 50, dimensions: allPassDimensions });
    const out = printReport(report);
    expect(out).not.toContain("exit 1");
  });

  it("check passes count per dimension in summary", () => {
    const report = buildReport({ generatedAt: "2026-05-25T00:00:00.000Z", windowDays: 7, totalEvents: 140, dimensions: mixedDimensions });
    const out = printReport(report);
    // tool: 2/2, quality: 1/2
    expect(out).toContain("2/2 checks passed");
    expect(out).toContain("1/2 checks passed");
  });
});
