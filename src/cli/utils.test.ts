// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

describe("loadCliConfig (F2 per-project discovery)", () => {
  async function makeProjectConfig(
    root: string,
    files: { config?: object; overrides?: object; heuristics?: unknown[] },
  ): Promise<void> {
    const projectDir = join(root, ".maestro");
    await mkdir(projectDir, { recursive: true });
    if (files.config) {
      await writeFile(join(projectDir, "config.json"), JSON.stringify(files.config));
    }
    if (files.overrides) {
      await writeFile(
        join(projectDir, "profile-overrides.json"),
        JSON.stringify(files.overrides),
      );
    }
    if (files.heuristics) {
      await writeFile(
        join(projectDir, "heuristics.json"),
        JSON.stringify(files.heuristics),
      );
    }
  }

  test("discovers per-project .maestro/ in cwd", async () => {
    const project = join(dir, "myrepo");
    await makeProjectConfig(project, { config: { profile: "quality" } });
    const c = await loadCliConfig({
      overridePath: join(dir, "missing-global.json"),
      cwd: project,
    });
    expect(c.projectConfigDir).toBe(join(project, ".maestro"));
    expect(c.userConfig.profile).toBe("quality");
  });

  test("walks up from a nested cwd to find .maestro/", async () => {
    const project = join(dir, "myrepo");
    await makeProjectConfig(project, { config: { profile: "cheap" } });
    const nested = join(project, "src", "deep", "nested");
    await mkdir(nested, { recursive: true });
    const c = await loadCliConfig({
      overridePath: join(dir, "missing-global.json"),
      cwd: nested,
    });
    expect(c.projectConfigDir).toBe(join(project, ".maestro"));
    expect(c.userConfig.profile).toBe("cheap");
  });

  test("project config overrides user-global key-by-key", async () => {
    const globalPath = join(dir, "global.json");
    await writeFile(
      globalPath,
      JSON.stringify({ profile: "balanced", dailyCostCapUsd: 5 }),
    );
    const project = join(dir, "myrepo");
    await makeProjectConfig(project, { config: { profile: "quality" } });
    const c = await loadCliConfig({ overridePath: globalPath, cwd: project });
    // overridden
    expect(c.userConfig.profile).toBe("quality");
    // preserved from global
    expect(c.userConfig.dailyCostCapUsd).toBe(5);
  });

  test("project profile-overrides merge per-class on top of global", async () => {
    // No user-global overrides for now (use missing path).
    const project = join(dir, "myrepo");
    await makeProjectConfig(project, {
      overrides: { hard: { maxBudgetUsd: 99 } },
    });
    const c = await loadCliConfig({
      overridePath: join(dir, "missing-global.json"),
      cwd: project,
    });
    expect(c.profileOverrides.hard?.maxBudgetUsd).toBe(99);
  });

  test("project heuristics concatenate after global heuristics", async () => {
    const project = join(dir, "myrepo");
    await makeProjectConfig(project, {
      heuristics: [
        { pattern: "deploy", class: "max", confidence: 0.95, source: "manual" },
      ],
    });
    const c = await loadCliConfig({
      overridePath: join(dir, "missing-global.json"),
      cwd: project,
    });
    expect(c.userHeuristics).toHaveLength(1);
    expect(c.userHeuristics[0]!.pattern).toBe("deploy");
  });

  test("noProject: true disables F2 discovery", async () => {
    const project = join(dir, "myrepo");
    await makeProjectConfig(project, { config: { profile: "quality" } });
    const c = await loadCliConfig({
      overridePath: join(dir, "missing-global.json"),
      cwd: project,
      noProject: true,
    });
    expect(c.projectConfigDir).toBeNull();
    expect(c.userConfig.profile).toBeUndefined();
  });

  test("string-style call still works (back-compat)", async () => {
    const c = await loadCliConfig(join(dir, "missing.json"));
    expect(c.userConfig).toEqual({});
    expect(c.profileOverrides).toEqual({});
  });

  test("missing project config dir → projectConfigDir is null", async () => {
    const isolated = join(dir, "isolated");
    await mkdir(isolated, { recursive: true });
    const c = await loadCliConfig({
      overridePath: join(dir, "missing.json"),
      cwd: isolated,
    });
    expect(c.projectConfigDir).toBeNull();
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
