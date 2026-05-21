// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import {
  parseVersion,
  preflight,
  satisfiesMinimum,
  type SpawnLike,
} from "./preflight.js";

describe("parseVersion", () => {
  test("extracts semver from real claude output", () => {
    expect(parseVersion("2.1.112 (Claude Code)")).toBe("2.1.112");
  });
  test("extracts when prefixed", () => {
    expect(parseVersion("claude 3.0.0-beta")).toBe("3.0.0");
  });
  test("returns null when no version", () => {
    expect(parseVersion("no number here")).toBeNull();
  });
});

describe("satisfiesMinimum", () => {
  test("equal versions pass", () => {
    expect(satisfiesMinimum("2.1.0", "2.1.0")).toBe(true);
  });
  test("greater patch passes", () => {
    expect(satisfiesMinimum("2.1.5", "2.1.0")).toBe(true);
  });
  test("greater minor passes", () => {
    expect(satisfiesMinimum("2.2.0", "2.1.0")).toBe(true);
  });
  test("greater major passes", () => {
    expect(satisfiesMinimum("3.0.0", "2.1.0")).toBe(true);
  });
  test("lower patch fails", () => {
    expect(satisfiesMinimum("2.0.99", "2.1.0")).toBe(false);
  });
  test("lower major fails", () => {
    expect(satisfiesMinimum("1.99.0", "2.1.0")).toBe(false);
  });
});

const okSpawn: SpawnLike = (_cmd, args) => {
  if (args[0] === "--version") {
    return { status: 0, stdout: "2.1.112 (Claude Code)\n" };
  }
  if (args[0] === "--help") {
    return {
      status: 0,
      stdout: [
        "--print",
        "--model",
        "--effort",
        "--max-budget-usd",
        "--session-id",
        "--resume",
        "--output-format",
        "--bare",
        "--exclude-dynamic-system-prompt-sections",
        "--tools",
        "--strict-mcp-config",
        "--mcp-config",
      ].join("\n"),
    };
  }
  return { status: 1, stdout: "" };
};

describe("preflight", () => {
  test("returns ok=true when binary, version, and flags are all good", () => {
    const r = preflight({ binary: "claude", spawn: okSpawn });
    expect(r.ok).toBe(true);
    expect(r.version).toBe("2.1.112");
    expect(r.missingFlags).toEqual([]);
  });

  test("binary not found → ok=false", () => {
    const fail: SpawnLike = () => ({
      status: null,
      stdout: "",
      error: new Error("ENOENT"),
    });
    const r = preflight({ binary: "no-claude", spawn: fail });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not found/);
  });

  test("version below minimum → ok=false", () => {
    const old: SpawnLike = (_c, args) =>
      args[0] === "--version"
        ? { status: 0, stdout: "2.0.0\n" }
        : { status: 0, stdout: "" };
    const r = preflight({ binary: "claude", spawn: old });
    expect(r.ok).toBe(false);
    expect(r.version).toBe("2.0.0");
    expect(r.reason).toMatch(/below the required minimum/);
  });

  test("missing flag → ok=false with list", () => {
    const incomplete: SpawnLike = (_c, args) => {
      if (args[0] === "--version") return { status: 0, stdout: "2.1.0\n" };
      if (args[0] === "--help") return { status: 0, stdout: "--print --model" }; // omits many
      return { status: 1, stdout: "" };
    };
    const r = preflight({ binary: "claude", spawn: incomplete });
    expect(r.ok).toBe(false);
    expect(r.missingFlags.length).toBeGreaterThan(0);
    expect(r.missingFlags).toContain("--max-budget-usd");
    expect(r.missingFlags).toContain("--bare");
    expect(r.reason).toMatch(/not exposed/);
  });

  test("unparseable version → ok=false", () => {
    const weird: SpawnLike = (_c, args) =>
      args[0] === "--version"
        ? { status: 0, stdout: "no version info\n" }
        : { status: 0, stdout: "" };
    const r = preflight({ binary: "claude", spawn: weird });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Could not parse/);
  });

  test("help fails → ok=false", () => {
    const helpFails: SpawnLike = (_c, args) =>
      args[0] === "--version"
        ? { status: 0, stdout: "2.1.0\n" }
        : { status: 1, stdout: "" };
    const r = preflight({ binary: "claude", spawn: helpFails });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Could not retrieve/);
  });

  // Integration: real claude binary on PATH (skipped if not available)
  test("real claude binary passes preflight", () => {
    const r = preflight();
    if (!r.ok && r.reason?.includes("not found")) {
      // Claude CLI not installed in this environment; skip
      return;
    }
    expect(r.ok).toBe(true);
    expect(r.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
