# maestro init / maestro doctor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `maestro init` (idempotent setup wizard) and `maestro doctor` (environment checker) CLI commands.

**Architecture:** Two new CLI modules following the existing `register*Command` pattern. `init` orchestrates existing install functions. `doctor` runs non-destructive checks and prints pass/fail with fix instructions.

**Tech Stack:** TypeScript strict, ESM, Vitest, Node 20+

---

## Background

Maestro currently ships four granular install commands:

| Command | What it does |
|---|---|
| `install-defaults` | Writes `~/.maestro/config.json` and appends the routing-discipline section to `~/.claude/CLAUDE.md` |
| `install-vscode` | Sets `claudeCode.claudeProcessWrapper` in VSCode `settings.json` |
| `install-commands` | Writes slash commands into `~/.claude/commands/` |
| `install-hook` | Adds the Stop-event feedback hook to `~/.claude/settings.json` |

A new user running `maestro` for the first time has no obvious starting point. `maestro init` is the single onboarding entry point: it calls each install step in sequence and prints a per-step summary. `maestro doctor` is the diagnostic companion: it runs non-destructive checks and tells the user exactly what is wrong and how to fix it.

Neither command adds new installation logic. `init` is an orchestrator. `doctor` is a reporter. Both are idempotent.

---

## Task 1: `src/cli/doctor.ts` + tests

**Files:**
- Create: `src/cli/doctor.ts`
- Create: `src/cli/doctor.test.ts`

### Step 1.1 — Write failing tests first

- [ ] Create `src/cli/doctor.test.ts` with the following content:

```typescript
// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { runChecks, type CheckResult, type DoctorOptions } from "./doctor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOpts(overrides: Partial<DoctorOptions> = {}): DoctorOptions {
  return {
    spawn: (_cmd, _args) => ({ status: 0, stdout: "claude 2.1.112\n" }),
    readFile: async (_p) => '{ "claudeCode.claudeProcessWrapper": "/usr/local/bin/maestro" }',
    statFile: async (_p) => true,
    getNodeVersion: () => "20.0.0",
    whichPnpm: () => "/usr/local/bin/pnpm",
    maestroBinary: "/usr/local/bin/maestro",
    vscodeSettingsPath: "/tmp/settings.json",
    maestroConfigPath: "/tmp/.maestro/config.json",
    telemetryDir: "/tmp/.maestro",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runChecks", () => {
  test("all green when environment is complete", async () => {
    const results = await runChecks(makeOpts());
    expect(results.every((r) => r.ok)).toBe(true);
  });

  test("fails when claude binary not found", async () => {
    const results = await runChecks(
      makeOpts({
        spawn: (_cmd, _args) => ({ status: 1, stdout: "", error: new Error("not found") }),
      }),
    );
    const check = results.find((r) => r.name === "claude binary");
    expect(check?.ok).toBe(false);
    expect(check?.fix).toMatch(/install/i);
  });

  test("fails when claude version is below minimum", async () => {
    const results = await runChecks(
      makeOpts({
        spawn: (_cmd, _args) => ({ status: 0, stdout: "claude 1.9.0\n" }),
      }),
    );
    const check = results.find((r) => r.name === "claude version");
    expect(check?.ok).toBe(false);
    expect(check?.fix).toMatch(/upgrade/i);
  });

  test("fails when claudeProcessWrapper is not set to maestro binary", async () => {
    const results = await runChecks(
      makeOpts({
        readFile: async (_p) => '{ "claudeCode.claudeProcessWrapper": "/other/wrapper" }',
      }),
    );
    const check = results.find((r) => r.name === "claudeProcessWrapper");
    expect(check?.ok).toBe(false);
    expect(check?.fix).toMatch(/install-vscode/i);
  });

  test("fails when claudeProcessWrapper is absent from settings", async () => {
    const results = await runChecks(
      makeOpts({
        readFile: async (_p) => "{}",
      }),
    );
    const check = results.find((r) => r.name === "claudeProcessWrapper");
    expect(check?.ok).toBe(false);
  });

  test("fails when VSCode settings.json is missing", async () => {
    const results = await runChecks(
      makeOpts({
        readFile: async (_p) => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); },
      }),
    );
    const check = results.find((r) => r.name === "claudeProcessWrapper");
    expect(check?.ok).toBe(false);
    expect(check?.fix).toMatch(/install-vscode/i);
  });

  test("fails when ~/.maestro/config.json is missing", async () => {
    const results = await runChecks(
      makeOpts({
        statFile: async (p) => !p.includes("config.json"),
      }),
    );
    const check = results.find((r) => r.name === "maestro config");
    expect(check?.ok).toBe(false);
    expect(check?.fix).toMatch(/install-defaults/i);
  });

  test("fails when telemetry dir is not writable (stat throws)", async () => {
    const results = await runChecks(
      makeOpts({
        statFile: async (p) => {
          if (p.includes(".maestro") && !p.includes("config.json")) throw new Error("EACCES");
          return true;
        },
      }),
    );
    const check = results.find((r) => r.name === "telemetry dir");
    expect(check?.ok).toBe(false);
  });

  test("fails when Node version is below 20", async () => {
    const results = await runChecks(
      makeOpts({ getNodeVersion: () => "18.20.0" }),
    );
    const check = results.find((r) => r.name === "node version");
    expect(check?.ok).toBe(false);
    expect(check?.fix).toMatch(/20/);
  });

  test("fails when pnpm is not on PATH", async () => {
    const results = await runChecks(
      makeOpts({ whichPnpm: () => null }),
    );
    const check = results.find((r) => r.name === "pnpm");
    expect(check?.ok).toBe(false);
    expect(check?.fix).toMatch(/pnpm/i);
  });

  test("check names are stable (used by init summary)", async () => {
    const results = await runChecks(makeOpts());
    const names = results.map((r) => r.name);
    expect(names).toContain("claude binary");
    expect(names).toContain("claude version");
    expect(names).toContain("claudeProcessWrapper");
    expect(names).toContain("maestro config");
    expect(names).toContain("telemetry dir");
    expect(names).toContain("node version");
    expect(names).toContain("pnpm");
  });
});
```

### Step 1.2 — Implement `src/cli/doctor.ts`

- [ ] Create `src/cli/doctor.ts` with the following content:

```typescript
// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0
//
// `maestro doctor` — non-destructive environment checker.
// budget: 30ms

import type { Command } from "commander";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { parseVersion, satisfiesMinimum } from "../wrapper/preflight.js";
import { defaultSettingsPath } from "./install-vscode.js";
import { DEFAULT_CONFIG_DIR, DEFAULT_USER_CONFIG, DEFAULT_TELEMETRY_PATH } from "./utils.js";
import { bold, cyan, dim, green, header, red } from "./render.js";

const MIN_CLAUDE_VERSION = "2.1.0";
const MIN_NODE_MAJOR = 20;

export type CheckResult = {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
};

// ---------------------------------------------------------------------------
// Injectable dependencies (for testing without touching the filesystem)
// ---------------------------------------------------------------------------

export type SpawnLike = (
  cmd: string,
  args: ReadonlyArray<string>,
) => { status: number | null; stdout: string; error?: Error };

export type DoctorOptions = {
  spawn: SpawnLike;
  /** Read a file, throws on ENOENT or permission error. */
  readFile: (path: string) => Promise<string>;
  /** Returns true if the path exists and is accessible, false if ENOENT, throws on other errors. */
  statFile: (path: string) => Promise<boolean>;
  getNodeVersion: () => string;
  whichPnpm: () => string | null;
  maestroBinary: string;
  vscodeSettingsPath: string;
  maestroConfigPath: string;
  telemetryDir: string;
};

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

async function checkClaudeBinary(opts: DoctorOptions): Promise<CheckResult> {
  const res = opts.spawn("claude", ["--version"]);
  if (res.error || res.status !== 0) {
    return {
      name: "claude binary",
      ok: false,
      detail: "not found",
      fix: "install Claude CLI: https://docs.claude.com",
    };
  }
  const version = parseVersion(res.stdout);
  return {
    name: "claude binary",
    ok: true,
    detail: version ? `claude ${version}` : res.stdout.trim(),
  };
}

async function checkClaudeVersion(opts: DoctorOptions): Promise<CheckResult> {
  const res = opts.spawn("claude", ["--version"]);
  if (res.error || res.status !== 0) {
    return { name: "claude version", ok: false, detail: "could not determine version" };
  }
  const version = parseVersion(res.stdout);
  if (!version) {
    return { name: "claude version", ok: false, detail: "could not parse version" };
  }
  const ok = satisfiesMinimum(version, MIN_CLAUDE_VERSION);
  return {
    name: "claude version",
    ok,
    detail: version,
    fix: ok ? undefined : `upgrade Claude CLI to ≥ ${MIN_CLAUDE_VERSION}: run \`claude install\``,
  };
}

async function checkClaudeProcessWrapper(opts: DoctorOptions): Promise<CheckResult> {
  let raw: string;
  try {
    raw = await opts.readFile(opts.vscodeSettingsPath);
  } catch (err) {
    return {
      name: "claudeProcessWrapper",
      ok: false,
      detail: "VSCode settings.json not found",
      fix: "run: maestro install-vscode",
    };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {
      name: "claudeProcessWrapper",
      ok: false,
      detail: "VSCode settings.json is not valid JSON",
      fix: "run: maestro install-vscode",
    };
  }
  const current = parsed["claudeCode.claudeProcessWrapper"];
  if (typeof current !== "string" || current !== opts.maestroBinary) {
    return {
      name: "claudeProcessWrapper",
      ok: false,
      detail: typeof current === "string" ? `set to: ${current}` : "not set",
      fix: "run: maestro install-vscode",
    };
  }
  return { name: "claudeProcessWrapper", ok: true, detail: current };
}

async function checkMaestroConfig(opts: DoctorOptions): Promise<CheckResult> {
  let present: boolean;
  try {
    present = await opts.statFile(opts.maestroConfigPath);
  } catch {
    present = false;
  }
  if (!present) {
    return {
      name: "maestro config",
      ok: false,
      detail: `${opts.maestroConfigPath} not found`,
      fix: "run: maestro install-defaults",
    };
  }
  return { name: "maestro config", ok: true, detail: opts.maestroConfigPath };
}

async function checkTelemetryDir(opts: DoctorOptions): Promise<CheckResult> {
  try {
    await opts.statFile(opts.telemetryDir);
    return { name: "telemetry dir", ok: true, detail: opts.telemetryDir };
  } catch (err) {
    return {
      name: "telemetry dir",
      ok: false,
      detail: `${opts.telemetryDir}: ${(err as Error).message}`,
      fix: `run: mkdir -p ${opts.telemetryDir}`,
    };
  }
}

function checkNodeVersion(opts: DoctorOptions): CheckResult {
  const version = opts.getNodeVersion();
  const major = parseInt(version.split(".")[0] ?? "0", 10);
  const ok = major >= MIN_NODE_MAJOR;
  return {
    name: "node version",
    ok,
    detail: `v${version}`,
    fix: ok ? undefined : `upgrade Node.js to ≥ ${MIN_NODE_MAJOR}: https://nodejs.org`,
  };
}

function checkPnpm(opts: DoctorOptions): CheckResult {
  const path = opts.whichPnpm();
  if (!path) {
    return {
      name: "pnpm",
      ok: false,
      detail: "not found on PATH",
      fix: "install pnpm: npm i -g pnpm",
    };
  }
  return { name: "pnpm", ok: true, detail: path };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function runChecks(opts: DoctorOptions): Promise<CheckResult[]> {
  return Promise.all([
    checkClaudeBinary(opts),
    checkClaudeVersion(opts),
    checkClaudeProcessWrapper(opts),
    checkMaestroConfig(opts),
    checkTelemetryDir(opts),
    Promise.resolve(checkNodeVersion(opts)),
    Promise.resolve(checkPnpm(opts)),
  ]);
}

function formatResults(results: CheckResult[]): string {
  const lines: string[] = ["", header("maestro doctor"), ""];
  for (const r of results) {
    const icon = r.ok ? green("✓") : red("✗");
    const name = bold(r.name);
    const detail = dim(r.detail);
    lines.push(`  ${icon} ${name}: ${detail}`);
    if (!r.ok && r.fix) {
      lines.push(`      ${dim("→")} ${cyan(r.fix)}`);
    }
  }
  lines.push("");
  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) {
    lines.push(`  ${green("All checks passed.")} Maestro is ready.`);
  } else {
    lines.push(`  ${red(`${failed.length} check${failed.length === 1 ? "" : "s"} failed.`)} Fix the issues above and re-run ${cyan("maestro doctor")}.`);
  }
  lines.push("");
  return lines.join("\n");
}

function makeDefaultOpts(): DoctorOptions {
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
  const { readFile, stat } = require("node:fs/promises") as typeof import("node:fs/promises");
  const { which } = (() => {
    try {
      return require("node:child_process") as never;
    } catch {
      return {};
    }
  })();

  const spawnLike: SpawnLike = (cmd, args) => {
    const res = spawnSync(cmd, [...args], { encoding: "utf8" });
    return {
      status: res.status,
      stdout: typeof res.stdout === "string" ? res.stdout : "",
      ...(res.error ? { error: res.error } : {}),
    };
  };

  const whichPnpm = (): string | null => {
    const res = spawnSync(platform() === "win32" ? "where" : "which", ["pnpm"], { encoding: "utf8" });
    return res.status === 0 && typeof res.stdout === "string" ? res.stdout.trim() : null;
  };

  const getMaestroBinary = (): string => {
    if (process.argv[1]) {
      try {
        const { realpathSync } = require("node:fs") as typeof import("node:fs");
        return realpathSync(process.argv[1]);
      } catch {
        return process.argv[1];
      }
    }
    return "maestro";
  };

  return {
    spawn: spawnLike,
    readFile: (p) => readFile(p, "utf8"),
    statFile: async (p) => {
      try {
        await stat(p);
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw err;
      }
    },
    getNodeVersion: () => process.version.replace(/^v/, ""),
    whichPnpm,
    maestroBinary: getMaestroBinary(),
    vscodeSettingsPath: defaultSettingsPath(),
    maestroConfigPath: DEFAULT_USER_CONFIG,
    telemetryDir: DEFAULT_CONFIG_DIR,
  };
}

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description(
      "Check your Maestro environment and print a pass/fail summary with fix instructions.",
    )
    .action(async () => {
      const opts = makeDefaultOpts();
      const results = await runChecks(opts);
      process.stdout.write(formatResults(results));
      const anyFailed = results.some((r) => !r.ok);
      process.exit(anyFailed ? 1 : 0);
    });
}
```

### Step 1.3 — Verify

- [ ] `pnpm typecheck` — clean
- [ ] `pnpm lint` — clean
- [ ] `pnpm test src/cli/doctor.test.ts` — all tests green

### Step 1.4 — Commit

```
add doctor: non-destructive environment checker with injectable deps
```

---

## Task 2: `src/cli/init.ts` + tests

**Files:**
- Create: `src/cli/init.ts`
- Create: `src/cli/init.test.ts`

### Step 2.1 — Write failing tests first

- [ ] Create `src/cli/init.test.ts` with the following content:

```typescript
// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, expect, test, vi } from "vitest";
import { runInit, type InitDependencies } from "./init.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSteps(overrides: Partial<InitDependencies> = {}): InitDependencies {
  return {
    installDefaults: vi.fn().mockResolvedValue({ status: "written" as const }),
    installVscode: vi.fn().mockResolvedValue({ status: "written" as const }),
    installCommands: vi.fn().mockResolvedValue({ status: "written" as const }),
    installHook: vi.fn().mockResolvedValue({ status: "written" as const }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runInit", () => {
  test("calls all four install steps in order", async () => {
    const callOrder: string[] = [];
    const deps: InitDependencies = {
      installDefaults: vi.fn().mockImplementation(async () => { callOrder.push("defaults"); return { status: "written" as const }; }),
      installVscode: vi.fn().mockImplementation(async () => { callOrder.push("vscode"); return { status: "written" as const }; }),
      installCommands: vi.fn().mockImplementation(async () => { callOrder.push("commands"); return { status: "written" as const }; }),
      installHook: vi.fn().mockImplementation(async () => { callOrder.push("hook"); return { status: "written" as const }; }),
    };
    await runInit(deps);
    expect(callOrder).toEqual(["defaults", "vscode", "commands", "hook"]);
  });

  test("returns written status for all steps when everything is new", async () => {
    const result = await runInit(makeSteps());
    expect(result.steps.every((s) => s.status === "written")).toBe(true);
  });

  test("returns already-present status when steps are already done", async () => {
    const result = await runInit(
      makeSteps({
        installDefaults: vi.fn().mockResolvedValue({ status: "already-present" as const }),
        installVscode: vi.fn().mockResolvedValue({ status: "already-present" as const }),
        installCommands: vi.fn().mockResolvedValue({ status: "already-present" as const }),
        installHook: vi.fn().mockResolvedValue({ status: "already-present" as const }),
      }),
    );
    expect(result.steps.every((s) => s.status === "already-present")).toBe(true);
  });

  test("returns failed status and continues when a step throws", async () => {
    const result = await runInit(
      makeSteps({
        installVscode: vi.fn().mockRejectedValue(new Error("permission denied")),
      }),
    );
    const vscodeStep = result.steps.find((s) => s.name === "vscode");
    expect(vscodeStep?.status).toBe("failed");
    expect(vscodeStep?.error).toMatch(/permission denied/);
    // Other steps still ran
    expect(result.steps.find((s) => s.name === "defaults")?.status).toBe("written");
    expect(result.steps.find((s) => s.name === "commands")?.status).toBe("written");
    expect(result.steps.find((s) => s.name === "hook")?.status).toBe("written");
  });

  test("result.ok is false when any step failed", async () => {
    const result = await runInit(
      makeSteps({
        installHook: vi.fn().mockRejectedValue(new Error("oops")),
      }),
    );
    expect(result.ok).toBe(false);
  });

  test("result.ok is true when all steps are written or already-present", async () => {
    const result = await runInit(
      makeSteps({
        installDefaults: vi.fn().mockResolvedValue({ status: "already-present" as const }),
        installVscode: vi.fn().mockResolvedValue({ status: "written" as const }),
        installCommands: vi.fn().mockResolvedValue({ status: "already-present" as const }),
        installHook: vi.fn().mockResolvedValue({ status: "written" as const }),
      }),
    );
    expect(result.ok).toBe(true);
  });

  test("step names match expected labels", async () => {
    const result = await runInit(makeSteps());
    const names = result.steps.map((s) => s.name);
    expect(names).toEqual(["defaults", "vscode", "commands", "hook"]);
  });

  test("idempotent: running twice returns already-present on second call", async () => {
    // Simulate: first call writes, second call sees existing state
    let callCount = 0;
    const deps: InitDependencies = {
      installDefaults: vi.fn().mockImplementation(async () => {
        callCount++;
        return callCount === 1
          ? { status: "written" as const }
          : { status: "already-present" as const };
      }),
      installVscode: vi.fn().mockResolvedValue({ status: callCount === 1 ? ("written" as const) : ("already-present" as const) }),
      installCommands: vi.fn().mockResolvedValue({ status: "written" as const }),
      installHook: vi.fn().mockResolvedValue({ status: "written" as const }),
    };
    const first = await runInit(deps);
    expect(first.ok).toBe(true);
    // Simulate second run with all already-present
    const result2 = await runInit(
      makeSteps({
        installDefaults: vi.fn().mockResolvedValue({ status: "already-present" as const }),
        installVscode: vi.fn().mockResolvedValue({ status: "already-present" as const }),
        installCommands: vi.fn().mockResolvedValue({ status: "already-present" as const }),
        installHook: vi.fn().mockResolvedValue({ status: "already-present" as const }),
      }),
    );
    expect(result2.ok).toBe(true);
    expect(result2.steps.every((s) => s.status === "already-present")).toBe(true);
  });
});
```

### Step 2.2 — Implement `src/cli/init.ts`

- [ ] Create `src/cli/init.ts` with the following content:

```typescript
// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0
//
// `maestro init` — idempotent setup wizard.
// Orchestrates the four install steps in sequence and prints a per-step summary.
// budget: 200ms (dominated by filesystem writes; all IO is sequential by design
// so the summary reflects actual ordered progress)

import type { Command } from "commander";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { bold, cyan, dim, green, header, red, yellow } from "./render.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StepStatus = "written" | "already-present" | "failed";

export type StepResult = {
  name: string;
  status: StepStatus;
  detail?: string;
  error?: string;
};

export type InitResult = {
  ok: boolean;
  steps: StepResult[];
};

export type InstallStepOutcome = {
  status: "written" | "already-present";
};

export type InitDependencies = {
  installDefaults: () => Promise<InstallStepOutcome>;
  installVscode: () => Promise<InstallStepOutcome>;
  installCommands: () => Promise<InstallStepOutcome>;
  installHook: () => Promise<InstallStepOutcome>;
};

// ---------------------------------------------------------------------------
// Core logic (pure, injectable)
// ---------------------------------------------------------------------------

async function runStep(
  name: string,
  fn: () => Promise<InstallStepOutcome>,
): Promise<StepResult> {
  try {
    const outcome = await fn();
    return { name, status: outcome.status };
  } catch (err) {
    return {
      name,
      status: "failed",
      error: (err as Error).message ?? String(err),
    };
  }
}

export async function runInit(deps: InitDependencies): Promise<InitResult> {
  const steps: StepResult[] = [
    await runStep("defaults", deps.installDefaults),
    await runStep("vscode", deps.installVscode),
    await runStep("commands", deps.installCommands),
    await runStep("hook", deps.installHook),
  ];
  return { ok: steps.every((s) => s.status !== "failed"), steps };
}

// ---------------------------------------------------------------------------
// Default install step adapters (wrap existing CLI command logic)
// ---------------------------------------------------------------------------

/**
 * Each adapter calls the corresponding `maestro install-*` subcommand via
 * spawnSync so we reuse the exact same logic as the standalone commands
 * without importing their internals. This avoids re-implementing idempotency
 * checks and means future changes to each installer are automatically
 * reflected in `maestro init`.
 *
 * Output is captured and discarded — `maestro init` prints its own summary.
 * A non-zero exit code causes the step to be marked "failed".
 */
function makeSpawnAdapter(
  subcommand: string,
  maestroBin: string,
): () => Promise<InstallStepOutcome> {
  return async () => {
    const res = spawnSync(maestroBin, [subcommand], {
      encoding: "utf8",
      // Capture both to suppress noise; we'll report pass/fail ourselves.
      stdio: "pipe",
    });
    if (res.status !== 0) {
      throw new Error(
        (res.stderr ?? "").trim() || `${subcommand} exited with code ${res.status ?? "?"}`,
      );
    }
    // Heuristic: if output contains "already" or "No change", it was a no-op.
    const combined = ((res.stdout ?? "") + (res.stderr ?? "")).toLowerCase();
    const alreadyPresent = combined.includes("already") || combined.includes("no change");
    return { status: alreadyPresent ? "already-present" : "written" };
  };
}

function detectMaestroBinary(): string {
  if (process.argv[1]) return process.argv[1];
  return "maestro";
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

function formatSummary(result: InitResult): string {
  const lines: string[] = ["", header("maestro init"), ""];
  for (const step of result.steps) {
    if (step.status === "written") {
      lines.push(`  ${green("✓ done")}           ${bold(step.name)}`);
    } else if (step.status === "already-present") {
      lines.push(`  ${dim("· already present")} ${dim(step.name)}`);
    } else {
      lines.push(`  ${red("✗ failed")}         ${bold(step.name)}: ${step.error ?? "unknown error"}`);
    }
  }
  lines.push("");
  if (result.ok) {
    lines.push(`  ${green("Maestro is ready.")} Run ${cyan("maestro doctor")} to verify your environment.`);
  } else {
    const failedNames = result.steps.filter((s) => s.status === "failed").map((s) => s.name);
    lines.push(
      `  ${red("Some steps failed:")} ${failedNames.join(", ")}. Run ${cyan("maestro doctor")} for details.`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Commander registration
// ---------------------------------------------------------------------------

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description(
      "Idempotent setup wizard: run all Maestro install steps in sequence and print a per-step summary.",
    )
    .action(async () => {
      const bin = detectMaestroBinary();
      const deps: InitDependencies = {
        installDefaults: makeSpawnAdapter("install-defaults", bin),
        installVscode: makeSpawnAdapter("install-vscode", bin),
        installCommands: makeSpawnAdapter("install-commands", bin),
        installHook: makeSpawnAdapter("install-hook", bin),
      };
      const result = await runInit(deps);
      process.stdout.write(formatSummary(result));
      process.exit(result.ok ? 0 : 1);
    });
}
```

### Step 2.3 — Verify

- [ ] `pnpm typecheck` — clean
- [ ] `pnpm lint` — clean
- [ ] `pnpm test src/cli/init.test.ts` — all tests green

### Step 2.4 — Commit

```
add init: idempotent setup wizard orchestrating all install steps
```

---

## Task 3: Register both commands in `src/cli/index.ts`

**Files:**
- Modify: `src/cli/index.ts`

### Step 3.1 — Add imports and register calls

- [ ] Add the two new imports alongside the existing register imports in `src/cli/index.ts`:

```typescript
// Add after the existing register* imports (line 14 area):
import { registerDoctorCommand } from "./doctor.js";
import { registerInitCommand } from "./init.js";
```

- [ ] Add the two register calls inside `buildProgram()`, immediately after `registerGuideCommand(program)`:

```typescript
// Add after registerGuideCommand(program):
registerInitCommand(program);
registerDoctorCommand(program);
```

### Step 3.2 — Verify

- [ ] `pnpm typecheck` — clean
- [ ] `pnpm lint` — clean
- [ ] `pnpm test` — full suite green (no regressions)
- [ ] Manual smoke: `maestro --help` lists `init` and `doctor`
- [ ] Manual smoke: `maestro doctor` runs and exits 0 (or 1 with actionable output)
- [ ] Manual smoke: `maestro init` runs and prints per-step summary

### Step 3.3 — Commit

```
register init and doctor commands in CLI entry point
```

---

## Verification gate

- [ ] `pnpm typecheck` clean
- [ ] `pnpm lint` clean
- [ ] `pnpm test` green
- [ ] `maestro --help` shows `init` and `doctor`
- [ ] `maestro doctor` exits 0 on a correctly configured machine, exits 1 with fix instructions otherwise
- [ ] `maestro init` on a clean machine runs all four steps and prints a summary
- [ ] `maestro init` on an already-configured machine prints "already present" for all steps and exits 0
