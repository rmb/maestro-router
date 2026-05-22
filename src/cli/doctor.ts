// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0
//
// `maestro doctor` — non-destructive environment checker.
// budget: 30ms

import type { Command } from "commander";
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { platform } from "node:os";
import { parseVersion, satisfiesMinimum } from "../wrapper/preflight.js";
import { defaultSettingsPath } from "./install-vscode.js";
import { DEFAULT_CONFIG_DIR, DEFAULT_USER_CONFIG } from "./utils.js";
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
    ...(ok ? {} : { fix: `upgrade Claude CLI to ≥ ${MIN_CLAUDE_VERSION}: run \`claude install\`` }),
  };
}

async function checkClaudeProcessWrapper(opts: DoctorOptions): Promise<CheckResult> {
  let raw: string;
  try {
    raw = await opts.readFile(opts.vscodeSettingsPath);
  } catch {
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
    ...(ok ? {} : { fix: `upgrade Node.js to ≥ ${MIN_NODE_MAJOR}: https://nodejs.org` }),
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
    lines.push(
      `  ${red(`${failed.length} check${failed.length === 1 ? "" : "s"} failed.`)} Fix the issues above and re-run ${cyan("maestro doctor")}.`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function makePlatformSpawn(): SpawnLike {
  return (cmd, args) => {
    const res = spawnSync(cmd, [...args], { encoding: "utf8" });
    return {
      status: res.status,
      stdout: typeof res.stdout === "string" ? res.stdout : "",
      ...(res.error ? { error: res.error } : {}),
    };
  };
}

function makePlatformWhichPnpm(): () => string | null {
  return () => {
    const res = spawnSync(platform() === "win32" ? "where" : "which", ["pnpm"], {
      encoding: "utf8",
    });
    return res.status === 0 && typeof res.stdout === "string" ? res.stdout.trim() : null;
  };
}

function detectMaestroBinary(): string {
  if (process.argv[1]) {
    try {
      return realpathSync(process.argv[1]);
    } catch {
      return process.argv[1];
    }
  }
  return "maestro";
}

function makeDefaultOpts(): DoctorOptions {
  return {
    spawn: makePlatformSpawn(),
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
    whichPnpm: makePlatformWhichPnpm(),
    maestroBinary: detectMaestroBinary(),
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
