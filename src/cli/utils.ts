// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { loadUserHeuristics } from "../classifiers/heuristic.js";
import type {
  Class,
  ClassSpec,
  HeuristicRule,
  ProfileOverride,
  UserConfig,
} from "../core/types.js";

/**
 * Resolves the user-global maestro config root. Honors $MAESTRO_HOME so
 * tests (and ephemeral sandboxes) can pin a clean directory; falls back to
 * `~/.maestro` for normal use.
 */
function resolveConfigDir(): string {
  const override = process.env.MAESTRO_HOME;
  if (override && override.length > 0) return override;
  return join(homedir(), ".maestro");
}

export const DEFAULT_CONFIG_DIR = resolveConfigDir();
export const DEFAULT_USER_CONFIG = join(DEFAULT_CONFIG_DIR, "config.json");
export const DEFAULT_PROFILE_OVERRIDES = join(DEFAULT_CONFIG_DIR, "profile-overrides.json");
export const DEFAULT_HEURISTICS = join(DEFAULT_CONFIG_DIR, "heuristics.json");
export const DEFAULT_TELEMETRY_PATH = join(DEFAULT_CONFIG_DIR, "decisions.jsonl");

export type LoadedCliConfig = {
  userConfig: UserConfig;
  profileOverrides: ProfileOverride;
  userHeuristics: HeuristicRule[];
  configPath: string;
  /** F2: directory of the discovered `.maestro/` project config, or null. */
  projectConfigDir: string | null;
};

export type LoadCliConfigOptions = {
  /** Override the user-global config path. */
  overridePath?: string;
  /** Starting directory for per-project config discovery. Defaults to process.cwd(). */
  cwd?: string;
  /** Skip per-project discovery (F2). */
  noProject?: boolean;
};

/**
 * Layered config loader (F2). Reads in priority order, project overrides global:
 *
 *   1. User-global  — ~/.maestro/{config,profile-overrides,heuristics}.json
 *   2. Per-project  — <walk-up>/.maestro/{config,profile-overrides,heuristics}.json
 *
 * Per-project values override user-global values key-by-key for UserConfig and
 * per-class for ProfileOverride. Heuristic rule lists concatenate (global
 * first, then project) so the project's rules take precedence in the pipeline.
 *
 * All files are optional; missing files yield empty defaults. The user-global
 * `.maestro/` directory (same as DEFAULT_CONFIG_DIR) is never selected as a
 * project root, so cwd inside $HOME doesn't double-count.
 */
export async function loadCliConfig(
  optsOrPath?: string | LoadCliConfigOptions,
): Promise<LoadedCliConfig> {
  const opts: LoadCliConfigOptions =
    typeof optsOrPath === "string"
      ? { overridePath: optsOrPath }
      : (optsOrPath ?? {});
  // Re-resolve at call time so $MAESTRO_HOME set after module load (e.g.
  // by test beforeEach) is honored. The exported DEFAULT_* constants
  // remain stable for callers that compute paths up-front.
  const configDir = resolveConfigDir();
  const configPath = opts.overridePath ?? join(configDir, "config.json");
  const overridesPath = join(configDir, "profile-overrides.json");
  const heuristicsPath = join(configDir, "heuristics.json");

  const userGlobal = (await readJsonOrNull<UserConfig>(configPath)) ?? {};
  const overridesGlobal =
    (await readJsonOrNull<ProfileOverride>(overridesPath)) ?? {};
  const heuristicsGlobal = await loadUserHeuristics(heuristicsPath);

  let projectConfigDir: string | null = null;
  let userProject: UserConfig = {};
  let overridesProject: ProfileOverride = {};
  let heuristicsProject: HeuristicRule[] = [];

  if (!opts.noProject) {
    projectConfigDir = await findProjectConfigDir(opts.cwd ?? process.cwd());
    if (projectConfigDir) {
      userProject =
        (await readJsonOrNull<UserConfig>(join(projectConfigDir, "config.json"))) ?? {};
      overridesProject =
        (await readJsonOrNull<ProfileOverride>(
          join(projectConfigDir, "profile-overrides.json"),
        )) ?? {};
      heuristicsProject = await loadUserHeuristics(
        join(projectConfigDir, "heuristics.json"),
      );
    }
  }

  return {
    userConfig: { ...userGlobal, ...userProject },
    profileOverrides: mergeProfileOverrides(overridesGlobal, overridesProject),
    userHeuristics: [...heuristicsGlobal, ...heuristicsProject],
    configPath,
    projectConfigDir,
  };
}

async function findProjectConfigDir(start: string): Promise<string | null> {
  let dir = resolve(start);
  const root = parse(dir).root;
  const userGlobalDir = resolve(DEFAULT_CONFIG_DIR);
  while (true) {
    const candidate = join(dir, ".maestro");
    // Skip user-global to avoid double-counting when cwd is inside $HOME.
    if (resolve(candidate) !== userGlobalDir) {
      try {
        const s = await stat(candidate);
        if (s.isDirectory()) return candidate;
      } catch {
        /* not present */
      }
    }
    if (dir === root) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function mergeProfileOverrides(
  base: ProfileOverride,
  overlay: ProfileOverride,
): ProfileOverride {
  const result: ProfileOverride = { ...base };
  for (const [cls, spec] of Object.entries(overlay) as [Class, Partial<ClassSpec>][]) {
    result[cls] = { ...result[cls], ...spec };
  }
  return result;
}

async function readJsonOrNull<T>(path: string): Promise<T | null> {
  try {
    const data = await readFile(path, "utf8");
    const parsed: unknown = JSON.parse(data);
    return parsed as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

export type FormatOptions = {
  json?: boolean;
  quiet?: boolean;
};

/**
 * Single output entry-point. JSON mode produces stable schema; quiet
 * suppresses everything; otherwise renders human-readable.
 */
export function format(value: unknown, opts: FormatOptions = {}): string {
  if (opts.quiet) return "";
  if (opts.json) return JSON.stringify(value, null, 2);
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

export type CommandHandler = (...args: unknown[]) => unknown;

/**
 * Error boundary around a Commander action handler.
 * - CommanderError → exit 2 (usage)
 * - Anything else  → exit 1 (runtime)
 */
export function wrap<T extends CommandHandler>(handler: T): T {
  return (async (...args: unknown[]) => {
    try {
      return await handler(...args);
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      process.stderr.write(`Error: ${message}\n`);
      process.exit(isUsageError(err) ? 2 : 1);
    }
  }) as T;
}

function isUsageError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown };
  return typeof e.code === "string" && e.code.startsWith("commander.");
}

export async function writeProfileOverrides(overrides: ProfileOverride): Promise<void> {
  await mkdir(dirname(DEFAULT_PROFILE_OVERRIDES), { recursive: true });
  await writeFile(DEFAULT_PROFILE_OVERRIDES, JSON.stringify(overrides, null, 2), "utf8");
}

export async function writeUserHeuristics(rules: ReadonlyArray<HeuristicRule>): Promise<void> {
  await mkdir(dirname(DEFAULT_HEURISTICS), { recursive: true });
  await writeFile(DEFAULT_HEURISTICS, JSON.stringify(rules, null, 2), "utf8");
}

export async function writeUserConfig(config: UserConfig, path?: string): Promise<void> {
  const target = path ?? DEFAULT_USER_CONFIG;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(config, null, 2), "utf8");
}
