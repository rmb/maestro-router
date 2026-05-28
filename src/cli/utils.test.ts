// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  embeddingOptionsFromConfig,
  filterProjectConfig,
  format,
  loadCliConfig,
  wrap,
  writeUserConfig,
} from "./utils.js";

let dir: string;
let prevMaestroHome: string | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "maestro-cli-utils-"));
  // Isolate from the real ~/.maestro — any heuristics.json or config.json
  // there would leak into hermetic-empty assertions.
  prevMaestroHome = process.env.MAESTRO_HOME;
  process.env.MAESTRO_HOME = join(dir, "fake-home");
});
afterEach(async () => {
  if (prevMaestroHome === undefined) delete process.env.MAESTRO_HOME;
  else process.env.MAESTRO_HOME = prevMaestroHome;
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

  test("project config does NOT override global telemetryPath", async () => {
    const globalPath = join(dir, "global.json");
    await writeFile(globalPath, JSON.stringify({ telemetryPath: "/global/decisions.jsonl" }));
    const project = join(dir, "myrepo");
    await makeProjectConfig(project, { config: { telemetryPath: "/project/decisions.jsonl" } });
    const c = await loadCliConfig({ overridePath: globalPath, cwd: project });
    expect(c.userConfig.telemetryPath).toBe("/global/decisions.jsonl");
  });

  test("project config does NOT override global feedbackSampleRate", async () => {
    const globalPath = join(dir, "global.json");
    await writeFile(globalPath, JSON.stringify({ feedbackSampleRate: 0.1 }));
    const project = join(dir, "myrepo");
    await makeProjectConfig(project, { config: { feedbackSampleRate: 0.99 } });
    const c = await loadCliConfig({ overridePath: globalPath, cwd: project });
    expect(c.userConfig.feedbackSampleRate).toBe(0.1);
  });

  test("project config does NOT override global useLlmClassifierInWrapper", async () => {
    const globalPath = join(dir, "global.json");
    await writeFile(globalPath, JSON.stringify({ useLlmClassifierInWrapper: false }));
    const project = join(dir, "myrepo");
    await makeProjectConfig(project, { config: { useLlmClassifierInWrapper: true } });
    const c = await loadCliConfig({ overridePath: globalPath, cwd: project });
    expect(c.userConfig.useLlmClassifierInWrapper).toBe(false);
  });

  test("project config does NOT inject disallowed field when global is absent", async () => {
    const project = join(dir, "myrepo");
    await makeProjectConfig(project, { config: { telemetryPath: "/injected/path.jsonl" } });
    const c = await loadCliConfig({
      overridePath: join(dir, "missing-global.json"),
      cwd: project,
    });
    expect(c.userConfig.telemetryPath).toBeUndefined();
  });

  test("project config DOES override global profile", async () => {
    const globalPath = join(dir, "global.json");
    await writeFile(globalPath, JSON.stringify({ profile: "balanced" }));
    const project = join(dir, "myrepo");
    await makeProjectConfig(project, { config: { profile: "quality" } });
    const c = await loadCliConfig({ overridePath: globalPath, cwd: project });
    expect(c.userConfig.profile).toBe("quality");
  });

  test("project config DOES override global excludeDynamicSections", async () => {
    const globalPath = join(dir, "global.json");
    await writeFile(globalPath, JSON.stringify({ excludeDynamicSections: false }));
    const project = join(dir, "myrepo");
    await makeProjectConfig(project, { config: { excludeDynamicSections: true } });
    const c = await loadCliConfig({ overridePath: globalPath, cwd: project });
    expect(c.userConfig.excludeDynamicSections).toBe(true);
  });

  test("project config DOES override global useEmbeddingClassifier", async () => {
    const globalPath = join(dir, "global.json");
    await writeFile(globalPath, JSON.stringify({ useEmbeddingClassifier: true }));
    const project = join(dir, "myrepo");
    await makeProjectConfig(project, { config: { useEmbeddingClassifier: false } });
    const c = await loadCliConfig({ overridePath: globalPath, cwd: project });
    expect(c.userConfig.useEmbeddingClassifier).toBe(false);
  });
});

describe("loadCliConfig — allowed-field integration", () => {
  async function writeJson(path: string, value: object): Promise<void> {
    const { mkdir: mkdirFs, writeFile: wf } = await import("node:fs/promises");
    await mkdirFs(dirname(path), { recursive: true });
    await wf(path, JSON.stringify(value));
  }

  test("full layered merge: allowed fields from project win, disallowed fields stay global", async () => {
    const globalConfigPath = join(dir, "home", "config.json");
    await writeJson(globalConfigPath, {
      profile: "balanced",
      excludeDynamicSections: false,
      useEmbeddingClassifier: false,
      telemetryPath: "/global/decisions.jsonl",
      feedbackSampleRate: 0.1,
      useLlmClassifierInWrapper: false,
      dailyCostCapUsd: 3,
    });
    const projectRoot = join(dir, "workspace", "my-repo");
    const projectMaestro = join(projectRoot, ".maestro");
    await writeJson(join(projectMaestro, "config.json"), {
      profile: "quality",
      excludeDynamicSections: true,
      useEmbeddingClassifier: true,
      telemetryPath: "/project/decisions.jsonl",
      feedbackSampleRate: 0.99,
      useLlmClassifierInWrapper: true,
      dailyCostCapUsd: 99,
    });

    const c = await loadCliConfig({ overridePath: globalConfigPath, cwd: projectRoot });

    expect(c.userConfig.profile).toBe("quality");
    expect(c.userConfig.excludeDynamicSections).toBe(true);
    expect(c.userConfig.useEmbeddingClassifier).toBe(true);

    expect(c.userConfig.telemetryPath).toBe("/global/decisions.jsonl");
    expect(c.userConfig.feedbackSampleRate).toBe(0.1);
    expect(c.userConfig.useLlmClassifierInWrapper).toBe(false);
    expect(c.userConfig.dailyCostCapUsd).toBe(3);
  });

  test("walk-up from deeply nested subdir finds grandparent .maestro/", async () => {
    const repoRoot = join(dir, "monorepo");
    const maestroDir = join(repoRoot, ".maestro");
    await writeJson(join(maestroDir, "config.json"), { profile: "cheap" });
    const deepCwd = join(repoRoot, "packages", "api", "src", "handlers");
    await import("node:fs/promises").then(({ mkdir: mkd }) =>
      mkd(deepCwd, { recursive: true }),
    );

    const c = await loadCliConfig({
      overridePath: join(dir, "missing-global.json"),
      cwd: deepCwd,
    });

    expect(c.projectConfigDir).toBe(maestroDir);
    expect(c.userConfig.profile).toBe("cheap");
  });

  test("user-global ~/.maestro is never selected as project root when cwd is $HOME subdir", async () => {
    const fakeHome = join(dir, "fake-home");
    await writeJson(join(fakeHome, "config.json"), { profile: "global-only" });
    const cwdInsideHome = join(fakeHome, "some-project");
    await import("node:fs/promises").then(({ mkdir: mkd }) =>
      mkd(cwdInsideHome, { recursive: true }),
    );

    const c = await loadCliConfig({
      overridePath: join(fakeHome, "config.json"),
      cwd: cwdInsideHome,
    });

    expect(c.projectConfigDir).toBeNull();
    expect(c.userConfig.profile).toBe("global-only");
  });

  test("no project config at all — projectConfigDir is null and global applies unchanged", async () => {
    const globalConfigPath = join(dir, "home", "config.json");
    await writeJson(globalConfigPath, {
      profile: "balanced",
      telemetryPath: "/global/decisions.jsonl",
    });
    const emptyCwd = join(dir, "no-maestro-here", "sub");
    await import("node:fs/promises").then(({ mkdir: mkd }) =>
      mkd(emptyCwd, { recursive: true }),
    );

    const c = await loadCliConfig({ overridePath: globalConfigPath, cwd: emptyCwd });

    expect(c.projectConfigDir).toBeNull();
    expect(c.userConfig.profile).toBe("balanced");
    expect(c.userConfig.telemetryPath).toBe("/global/decisions.jsonl");
  });

  test("filterProjectConfig returns only allowed keys, strips everything else", () => {
    const input: Parameters<typeof filterProjectConfig>[0] = {
      profile: "quality",
      excludeDynamicSections: true,
      useEmbeddingClassifier: false,
      embeddingMinSimilarity: 0.55,
      telemetryPath: "/should/be/removed",
      feedbackSampleRate: 0.99,
      useLlmClassifierInWrapper: true,
      dailyCostCapUsd: 50,
      aggressiveness: "aggressive",
    };
    const result = filterProjectConfig(input);
    expect(result).toEqual({
      profile: "quality",
      excludeDynamicSections: true,
      useEmbeddingClassifier: false,
      embeddingMinSimilarity: 0.55,
    });
    expect("telemetryPath" in result).toBe(false);
    expect("feedbackSampleRate" in result).toBe(false);
    expect("useLlmClassifierInWrapper" in result).toBe(false);
    expect("dailyCostCapUsd" in result).toBe(false);
    expect("aggressiveness" in result).toBe(false);
  });

  test("filterProjectConfig with empty input returns empty object", () => {
    expect(filterProjectConfig({})).toEqual({});
  });

  test("filterProjectConfig does not mutate the input", () => {
    const input: Parameters<typeof filterProjectConfig>[0] = {
      profile: "quality",
      telemetryPath: "/some/path",
    };
    const original = { ...input };
    filterProjectConfig(input);
    expect(input).toEqual(original);
  });
});

describe("embeddingOptionsFromConfig", () => {
  test("empty config returns empty options", () => {
    expect(embeddingOptionsFromConfig({})).toEqual({});
  });

  test("only embeddingModel set returns { modelId }", () => {
    expect(embeddingOptionsFromConfig({ embeddingModel: "./my-model" })).toEqual({
      modelId: "./my-model",
    });
  });

  test("only embeddingMinSimilarity set returns { minSimilarity }", () => {
    expect(embeddingOptionsFromConfig({ embeddingMinSimilarity: 0.3 })).toEqual({
      minSimilarity: 0.3,
    });
  });

  test("both set returns both keys", () => {
    expect(
      embeddingOptionsFromConfig({ embeddingModel: "./m", embeddingMinSimilarity: 0.7 }),
    ).toEqual({ modelId: "./m", minSimilarity: 0.7 });
  });

  test("does not set keys to undefined", () => {
    const result = embeddingOptionsFromConfig({});
    expect("modelId" in result).toBe(false);
    expect("minSimilarity" in result).toBe(false);
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
