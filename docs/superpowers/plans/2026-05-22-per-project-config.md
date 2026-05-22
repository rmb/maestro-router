# Per-project Config — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce per-project config field restrictions and add tests/docs for the already-implemented discovery mechanism.

**Architecture:** `loadCliConfig` in `src/cli/utils.ts` already implements walk-up discovery and merging. This plan adds an allowed-fields filter for project config and tests proving the boundaries.

**Tech Stack:** TypeScript strict, ESM, Vitest, Node 20+

---

## Background

`loadCliConfig` in `src/cli/utils.ts` already does the right thing for discovery and merging:

1. `findProjectConfigDir` walks up from `cwd` looking for `.maestro/`.
2. Reads `.maestro/{config,profile-overrides,heuristics}.json` per-project.
3. Merges with `{ ...userGlobal, ...userProject }` — project wins per-key.
4. Returns `projectConfigDir` in the result.

The only gap is that the spread `{ ...userGlobal, ...userProject }` applies **every** `UserConfig` key from the project file, including fields that must be machine-global:

| Field | Why it must stay global |
|---|---|
| `telemetryPath` | Writing decisions to a project-local path silently breaks `maestro stats` and `maestro tune` which always read from the global path. |
| `feedbackSampleRate` | Stop-hook sampling is a personal preference, not a per-repo concern. Setting it per-project would produce confusing, inconsistent feedback frequency. |
| `useLlmClassifierInWrapper` | Cold-cache cost ($0.04/call) and latency (13-20s) impact the hot path for every user of that repo, not just the one who set the flag. Project-level opt-in would surprise teammates. |

The three fields are not the only disallowed ones — the full allowed list is the safe, routing-only subset: `profile`, `profileOverrides` (handled separately via `.maestro/profile-overrides.json`), `excludeDynamicSections`, and `useEmbeddingClassifier`. All other `UserConfig` fields remain global-only.

---

## Task 1: Add `filterProjectConfig` and enforce allowed-field list

**Files:**
- Modify: `src/cli/utils.ts`
- Modify: `src/cli/utils.test.ts`

### Step 1.1 — Write failing tests first

- [ ] Add the following tests to `src/cli/utils.test.ts` inside the existing `describe("loadCliConfig (F2 per-project discovery)")` block:

```typescript
// Append inside describe("loadCliConfig (F2 per-project discovery)")

test("project config does NOT override global telemetryPath", async () => {
  const globalPath = join(dir, "global.json");
  await writeFile(
    globalPath,
    JSON.stringify({ telemetryPath: "/global/decisions.jsonl" }),
  );
  const project = join(dir, "myrepo");
  await makeProjectConfig(project, {
    config: { telemetryPath: "/project/decisions.jsonl" },
  });
  const c = await loadCliConfig({ overridePath: globalPath, cwd: project });
  // project value must be silently discarded
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
  // Global has no telemetryPath; project tries to set one.
  // Result must be undefined, not the project value.
  const project = join(dir, "myrepo");
  await makeProjectConfig(project, {
    config: { telemetryPath: "/injected/path.jsonl" },
  });
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
```

### Step 1.2 — Implement `filterProjectConfig` in `src/cli/utils.ts`

Run `pnpm test src/cli/utils.test.ts` first to confirm the new tests fail (they will, because `{ ...userGlobal, ...userProject }` currently applies all fields).

- [ ] Add the exported constant and function immediately before the `loadCliConfig` function:

```typescript
// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

/**
 * Fields in UserConfig that a per-project .maestro/config.json is allowed
 * to override. Everything not listed here stays global-only.
 *
 * Rationale:
 *   - `profile` / `excludeDynamicSections` / `useEmbeddingClassifier` are
 *     pure routing preferences safe to scope per-repo.
 *   - `telemetryPath` must stay global so `maestro stats` / `maestro tune`
 *     always find the same file regardless of cwd.
 *   - `feedbackSampleRate` is a personal preference; varying it per-repo
 *     produces surprising sampling behaviour for the individual user.
 *   - `useLlmClassifierInWrapper` lives on the hot path and carries cold-cache
 *     cost ($0.04/call) + latency (13-20s); project-level opt-in would silently
 *     penalise every teammate who pulls that repo.
 */
export const PROJECT_CONFIG_ALLOWED_FIELDS: ReadonlySet<keyof UserConfig> = new Set([
  "profile",
  "excludeDynamicSections",
  "useEmbeddingClassifier",
]);

/**
 * Returns a copy of `project` with every key that is not in
 * PROJECT_CONFIG_ALLOWED_FIELDS removed. Called before merging project
 * config over user-global config in `loadCliConfig`.
 */
export function filterProjectConfig(project: UserConfig): UserConfig {
  const result: UserConfig = {};
  for (const key of PROJECT_CONFIG_ALLOWED_FIELDS) {
    if (key in project) {
      // Type-safe cast: key is keyof UserConfig, so project[key] is the
      // correct value type. Object.assign preserves the exact value.
      (result as Record<string, unknown>)[key] = project[key];
    }
  }
  return result;
}
```

- [ ] Replace the merge line inside `loadCliConfig` (line 105 in current `utils.ts`):

```typescript
// BEFORE:
userConfig: { ...userGlobal, ...userProject },

// AFTER:
userConfig: { ...userGlobal, ...filterProjectConfig(userProject) },
```

### Step 1.3 — Verify

- [ ] `pnpm typecheck` — clean
- [ ] `pnpm lint` — clean
- [ ] `pnpm test src/cli/utils.test.ts` — all tests green including the 7 new ones

### Step 1.4 — Commit

```
add filterProjectConfig: enforce allowed-field list for per-project config
```

---

## Task 2: Integration tests for walk-up discovery, override behavior, and field restrictions

The existing `utils.test.ts` already covers discovery (cwd, nested, walk-up, noProject). This task adds a dedicated integration-style describe block that uses `$MAESTRO_HOME` + tmp dirs to exercise the full layered merge in realistic directory trees.

**Files:**
- Modify: `src/cli/utils.test.ts`

### Step 2.1 — Write the integration tests

- [ ] Add the following describe block to `src/cli/utils.test.ts`. Place it after the existing `describe("loadCliConfig (F2 per-project discovery)")` block:

```typescript
describe("loadCliConfig — allowed-field integration", () => {
  // Helpers already available from the outer beforeEach/afterEach (dir is set there).

  async function writeJson(path: string, value: object): Promise<void> {
    const { mkdir: mkdirFs, writeFile: wf } = await import("node:fs/promises");
    await mkdirFs(dirname(path), { recursive: true });
    await wf(path, JSON.stringify(value));
  }

  test("full layered merge: allowed fields from project win, disallowed fields stay global", async () => {
    // Arrange: global has all fields; project tries to override all of them.
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
      profile: "quality",                          // allowed — should win
      excludeDynamicSections: true,                // allowed — should win
      useEmbeddingClassifier: true,                // allowed — should win
      telemetryPath: "/project/decisions.jsonl",   // disallowed — should be ignored
      feedbackSampleRate: 0.99,                    // disallowed — should be ignored
      useLlmClassifierInWrapper: true,             // disallowed — should be ignored
      dailyCostCapUsd: 99,                         // disallowed — should be ignored
    });

    const c = await loadCliConfig({ overridePath: globalConfigPath, cwd: projectRoot });

    // Allowed fields — project value applies
    expect(c.userConfig.profile).toBe("quality");
    expect(c.userConfig.excludeDynamicSections).toBe(true);
    expect(c.userConfig.useEmbeddingClassifier).toBe(true);

    // Disallowed fields — global value preserved
    expect(c.userConfig.telemetryPath).toBe("/global/decisions.jsonl");
    expect(c.userConfig.feedbackSampleRate).toBe(0.1);
    expect(c.userConfig.useLlmClassifierInWrapper).toBe(false);
    expect(c.userConfig.dailyCostCapUsd).toBe(3);
  });

  test("walk-up from deeply nested subdir finds grandparent .maestro/", async () => {
    // Arrange: .maestro/ lives at the repo root, cwd is 4 levels down.
    const repoRoot = join(dir, "monorepo");
    const maestroDir = join(repoRoot, ".maestro");
    await writeJson(join(maestroDir, "config.json"), { profile: "cheap" });
    const deepCwd = join(repoRoot, "packages", "api", "src", "handlers");
    await import("node:fs/promises").then(({ mkdir }) =>
      mkdir(deepCwd, { recursive: true }),
    );

    const c = await loadCliConfig({
      overridePath: join(dir, "missing-global.json"),
      cwd: deepCwd,
    });

    expect(c.projectConfigDir).toBe(maestroDir);
    expect(c.userConfig.profile).toBe("cheap");
  });

  test("user-global ~/.maestro is never selected as project root when cwd is $HOME subdir", async () => {
    // $MAESTRO_HOME is already set to join(dir, "fake-home") by the outer beforeEach.
    // Write a config there (simulates ~/.maestro/config.json).
    const fakeHome = join(dir, "fake-home");
    await writeJson(join(fakeHome, "config.json"), { profile: "global-only" });
    // cwd is a directory directly inside the fake home — simulates ~/Documents.
    const cwdInsideHome = join(fakeHome, "some-project");
    await import("node:fs/promises").then(({ mkdir }) =>
      mkdir(cwdInsideHome, { recursive: true }),
    );

    const c = await loadCliConfig({
      overridePath: join(fakeHome, "config.json"),
      cwd: cwdInsideHome,
    });

    // The fake-home directory itself must NOT be selected as projectConfigDir.
    expect(c.projectConfigDir).toBeNull();
    // The global profile still applies (from overridePath, not project discovery).
    expect(c.userConfig.profile).toBe("global-only");
  });

  test("no project config at all — projectConfigDir is null and global applies unchanged", async () => {
    const globalConfigPath = join(dir, "home", "config.json");
    await writeJson(globalConfigPath, {
      profile: "balanced",
      telemetryPath: "/global/decisions.jsonl",
    });
    // cwd with no .maestro/ anywhere between it and the fs root (well, between
    // it and dir — the walk stops before reaching an actual .maestro/).
    const emptyCwd = join(dir, "no-maestro-here", "sub");
    await import("node:fs/promises").then(({ mkdir }) =>
      mkdir(emptyCwd, { recursive: true }),
    );

    const c = await loadCliConfig({ overridePath: globalConfigPath, cwd: emptyCwd });

    expect(c.projectConfigDir).toBeNull();
    expect(c.userConfig.profile).toBe("balanced");
    expect(c.userConfig.telemetryPath).toBe("/global/decisions.jsonl");
  });

  test("filterProjectConfig returns only allowed keys, strips everything else", () => {
    const input: UserConfig = {
      profile: "quality",
      excludeDynamicSections: true,
      useEmbeddingClassifier: false,
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
    const input: UserConfig = {
      profile: "quality",
      telemetryPath: "/some/path",
    };
    const original = { ...input };
    filterProjectConfig(input);
    expect(input).toEqual(original);
  });
});
```

Note: `filterProjectConfig` must be added to the import line at the top of `utils.test.ts`:

```typescript
// BEFORE:
import { format, loadCliConfig, wrap, writeUserConfig } from "./utils.js";

// AFTER:
import { filterProjectConfig, format, loadCliConfig, wrap, writeUserConfig } from "./utils.js";
```

### Step 2.2 — Verify

- [ ] `pnpm typecheck` — clean
- [ ] `pnpm lint` — clean
- [ ] `pnpm test src/cli/utils.test.ts` — all tests green

### Step 2.3 — Commit

```
test(utils): integration tests for per-project config discovery and field boundaries
```

---

## Task 3: README section on per-project config

The existing README `## Configuration` section already mentions per-project config briefly. This task expands it with a dedicated sub-section that explains the discovery mechanism and the allowed-field boundary.

**Files:**
- Modify: `README.md`

### Step 3.1 — Replace the per-project paragraph in `README.md`

The current README `## Configuration` section ends with:

```
Per-project example — `<your-repo>/.maestro/config.json`:

```json
{
  "profile": "quality",
  "useLlmClassifier": false
}
```

That repo's prompts use the `quality` profile and skip the LLM stage; every
other repo still uses your global defaults.
```

- [ ] Replace that block with the expanded version below (find and replace the exact paragraph):

```markdown
### Per-project config

Place a `.maestro/` directory anywhere in your repo tree. Maestro walks up
from `cwd` on every invocation and loads the nearest `.maestro/` it finds,
merging it on top of your user-global `~/.maestro/`. The user-global
directory itself is never selected as a project root, so working inside
`$HOME` doesn't double-count.

```
<your-repo>/
  .maestro/
    config.json              # per-project routing preferences (allowed fields only)
    profile-overrides.json   # per-class model/effort/budget tweaks for this repo
    heuristics.json          # extra regex rules (appended after global rules)
```

**Allowed fields in `<repo>/.maestro/config.json`:**

| Field | Effect |
|---|---|
| `profile` | Use a different built-in profile for this repo (`balanced`, `cheap`, `quality`) |
| `excludeDynamicSections` | Enable/disable `--exclude-dynamic-system-prompt-sections` for this repo |
| `useEmbeddingClassifier` | Enable/disable the ONNX embedding stage for this repo |

All other `UserConfig` fields (`telemetryPath`, `feedbackSampleRate`,
`useLlmClassifierInWrapper`, `dailyCostCapUsd`, etc.) are silently ignored in
project config — they belong in `~/.maestro/config.json` only. This prevents
a `.maestro/config.json` committed to a shared repo from changing teammates'
telemetry paths or hot-path latency.

`profile-overrides.json` and `heuristics.json` are not field-filtered: every
valid key in those files is applied (per-class for overrides, appended for
heuristics).

**Minimal example** — `<your-repo>/.maestro/config.json`:

```json
{
  "profile": "quality"
}
```

That repo's prompts use the `quality` profile; every other repo still uses
your global defaults. Teammates who pull the same repo are unaffected on
dimensions they control globally (telemetry path, feedback sampling, LLM
wrapper opt-in).
```

### Step 3.2 — Verify

- [ ] Read through the `## Configuration` section and confirm the new sub-section renders correctly (no broken code fences, no duplicate headings).
- [ ] `pnpm typecheck` — clean (README edit can't break types, but run it anyway as a sanity gate before committing)
- [ ] `pnpm lint` — clean

### Step 3.3 — Commit

```
docs: expand README per-project config section with allowed-fields table
```

---

## Completion checklist

- [ ] Task 1 done — `filterProjectConfig` exported, `loadCliConfig` uses it, 7 new unit tests green
- [ ] Task 2 done — integration describe block added, 7 integration tests green
- [ ] Task 3 done — README sub-section expanded with allowed-fields table
- [ ] `pnpm typecheck && pnpm lint && pnpm test` all clean end-to-end
