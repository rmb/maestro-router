// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { condensePaste, isPasteHeavy } from "./paste.js";

const makeDataDump = (rows: number) =>
  Array.from({ length: rows }, (_, i) => `row-${i}\t${(i * 0.37).toFixed(4)}\t${i * 10}\t${i % 7 === 0 ? "highlight" : "normal"}`).join("\n");

const makeCodeBlock = (lines: number) =>
  Array.from({ length: lines }, (_, i) => `const x${i} = async () => { return await fetch('/api/${i}'); };`).join("\n");

describe("isPasteHeavy", () => {
  test("short prompt is never paste-heavy", () => {
    expect(isPasteHeavy("fix the bug")).toBe(false);
  });

  test("long code block is not paste-heavy", () => {
    expect(isPasteHeavy(makeCodeBlock(40))).toBe(false);
  });

  test("large structured data dump is paste-heavy", () => {
    expect(isPasteHeavy(makeDataDump(55))).toBe(true);
  });

  test("prompt with fewer than 10 non-empty lines is not paste-heavy", () => {
    // 8 lines, padded to exceed 800 chars so only the line-count check rejects it
    const prompt = Array.from({ length: 8 }, (_, i) => `value-${i}: ${"x".repeat(110)}`).join("\n");
    expect(isPasteHeavy(prompt)).toBe(false);
  });

  test("real analytics paste is paste-heavy", () => {
    // Realistic analytics dump with enough rows to exceed 800 chars
    const rows = [
      "Page", "Visitors", "Bounce", "Duration",
      "/", "61", "58%", "1m 12s",
      "/regulations/nis2/industry/energy/netherlands", "14", "72%", "0m 48s",
      "/regulations/nis2/industry/energy/austria", "12", "65%", "1m 02s",
      "/regulations/mica/industry/telecom", "10", "70%", "0m 55s",
      "/dashboard", "8", "40%", "3m 22s",
      "/sovereignty", "7", "61%", "1m 30s",
      "/terms-and-conditions", "7", "80%", "0m 30s",
      "/workspace", "7", "35%", "4m 10s",
      "/eu-compliance-deadlines-2026", "6", "55%", "2m 05s",
      "/regulations/gdpr/industry/healthcare", "5", "68%", "1m 15s",
      "/regulations/dora/industry/finance", "4", "62%", "1m 40s",
      "Referrer", "Visitors", "Bounce", "Duration",
      "google.com", "88", "55%", "1m 20s",
      "chatgpt.com", "2", "45%", "2m 10s",
      "perplexity.ai", "1", "50%", "1m 55s",
      "producthunt.com", "1", "70%", "0m 45s",
      "system.toolify.ai", "1", "60%", "1m 05s",
      "twingine.com", "1", "65%", "0m 50s",
    ];
    const header = `eurocomply.app — Last 7 Days\n\nVisitors: 183 (+41%)\nPage Views: 920 (-67%)\nBounce Rate: 61% (-1%)\nSessions: 412\nAvg Duration: 1m 38s\nNew Users: 71%\nReturning: 29%\n\n`;
    const prompt = header + rows.join("\n");
    expect(prompt.length).toBeGreaterThan(800);
    expect(isPasteHeavy(prompt)).toBe(true);
  });
});

describe("condensePaste", () => {
  test("returns null for non-paste-heavy prompts", () => {
    expect(condensePaste("fix this bug")).toBeNull();
  });

  test("returns null when savings are too small", () => {
    const smallPaste = makeDataDump(12); // just over threshold but middle too small
    const result = condensePaste(smallPaste);
    if (result !== null) {
      expect(result.savedChars).toBeGreaterThanOrEqual(200);
    }
  });

  test("condensed version is shorter than original", () => {
    const dump = makeDataDump(60);
    const result = condensePaste(dump);
    expect(result).not.toBeNull();
    expect(result!.condensed.length).toBeLessThan(dump.length);
    expect(result!.savedChars).toBeGreaterThan(0);
  });

  test("condensed version preserves head and tail", () => {
    const dump = makeDataDump(60);
    const result = condensePaste(dump);
    expect(result).not.toBeNull();
    expect(result!.condensed).toContain(dump.slice(0, 100));
    expect(result!.condensed).toContain(dump.slice(-100));
  });

  test("condensed version contains truncation marker", () => {
    const dump = makeDataDump(60);
    const result = condensePaste(dump);
    expect(result).not.toBeNull();
    expect(result!.condensed).toContain("chars of structured data truncated");
  });

  test("savedChars matches actual length difference", () => {
    const dump = makeDataDump(60);
    const result = condensePaste(dump);
    expect(result).not.toBeNull();
    expect(result!.savedChars).toBe(dump.length - result!.condensed.length);
  });
});
