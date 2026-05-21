// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { format, loadCliConfig, wrap, writeUserConfig } from "./utils.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "maestro-cli-utils-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("format", () => {
  test("returns empty when quiet", () => {
    expect(format({ x: 1 }, { quiet: true })).toBe("");
  });

  test("JSON mode produces stable indented JSON", () => {
    const out = format({ a: 1, b: 2 }, { json: true });
    expect(JSON.parse(out)).toEqual({ a: 1, b: 2 });
    expect(out).toContain("\n");
  });

  test("default mode returns string for string input", () => {
    expect(format("hello")).toBe("hello");
  });

  test("default mode falls back to JSON for objects", () => {
    expect(JSON.parse(format({ a: 1 }))).toEqual({ a: 1 });
  });
});

describe("loadCliConfig", () => {
  test("returns empty defaults when files missing", async () => {
    const c = await loadCliConfig(join(dir, "missing.json"));
    expect(c.userConfig).toEqual({});
    expect(c.profileOverrides).toEqual({});
    expect(c.userHeuristics).toEqual([]);
  });

  test("reads userConfig from override path", async () => {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({ profile: "cheap" }));
    const c = await loadCliConfig(path);
    expect(c.userConfig.profile).toBe("cheap");
  });

  test("handles malformed JSON gracefully", async () => {
    const path = join(dir, "bad.json");
    await writeFile(path, "not valid json {{}");
    const c = await loadCliConfig(path);
    expect(c.userConfig).toEqual({});
  });
});

describe("writeUserConfig", () => {
  test("round-trips through loadCliConfig", async () => {
    const path = join(dir, "config.json");
    await writeUserConfig({ profile: "quality", dailyCostCapUsd: 5 }, path);
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as { profile: string; dailyCostCapUsd: number };
    expect(parsed.profile).toBe("quality");
    expect(parsed.dailyCostCapUsd).toBe(5);
  });
});

describe("wrap", () => {
  test("returns handler result on success", async () => {
    const wrapped = wrap(async (x: unknown) => `got:${String(x)}`);
    const result = await wrapped("ok");
    expect(result).toBe("got:ok");
  });

  test("intercepts errors and exits with 1 (verified via mock process.exit)", async () => {
    const exits: number[] = [];
    const origExit = process.exit;
    // @ts-expect-error mock
    process.exit = (code?: number) => {
      exits.push(code ?? 0);
      throw new Error("__exit__");
    };
    try {
      const wrapped = wrap(async () => {
        throw new Error("boom");
      });
      await expect(wrapped()).rejects.toThrow("__exit__");
      expect(exits).toEqual([1]);
    } finally {
      process.exit = origExit;
    }
  });

  test("CommanderError-like (code starts with 'commander.') exits with 2", async () => {
    const exits: number[] = [];
    const origExit = process.exit;
    // @ts-expect-error mock
    process.exit = (code?: number) => {
      exits.push(code ?? 0);
      throw new Error("__exit__");
    };
    try {
      const wrapped = wrap(async () => {
        const e = new Error("usage error");
        (e as Error & { code?: string }).code = "commander.invalidArgument";
        throw e;
      });
      await expect(wrapped()).rejects.toThrow("__exit__");
      expect(exits).toEqual([2]);
    } finally {
      process.exit = origExit;
    }
  });
});
