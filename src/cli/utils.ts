// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { loadUserHeuristics } from "../classifiers/heuristic.js";
import type {
  HeuristicRule,
  ProfileOverride,
  UserConfig,
} from "../core/types.js";

export const DEFAULT_CONFIG_DIR = join(homedir(), ".maestro");
export const DEFAULT_USER_CONFIG = join(DEFAULT_CONFIG_DIR, "config.json");
export const DEFAULT_PROFILE_OVERRIDES = join(DEFAULT_CONFIG_DIR, "profile-overrides.json");
export const DEFAULT_HEURISTICS = join(DEFAULT_CONFIG_DIR, "heuristics.json");
export const DEFAULT_TELEMETRY_PATH = join(DEFAULT_CONFIG_DIR, "decisions.jsonl");

export type LoadedCliConfig = {
  userConfig: UserConfig;
  profileOverrides: ProfileOverride;
  userHeuristics: HeuristicRule[];
  configPath: string;
};

/**
 * F2 layered config loader (filesystem side). Reads
 *   ~/.maestro/config.json          → UserConfig
 *   ~/.maestro/profile-overrides.json → ProfileOverride
 *   ~/.maestro/heuristics.json      → HeuristicRule[]
 * All optional; missing files yield empty defaults. An optional
 * `overridePath` redirects the user-config read.
 */
export async function loadCliConfig(overridePath?: string): Promise<LoadedCliConfig> {
  const configPath = overridePath ?? DEFAULT_USER_CONFIG;
  const userConfig = (await readJsonOrNull<UserConfig>(configPath)) ?? {};
  const profileOverrides =
    (await readJsonOrNull<ProfileOverride>(DEFAULT_PROFILE_OVERRIDES)) ?? {};
  const userHeuristics = await loadUserHeuristics(DEFAULT_HEURISTICS);
  return { userConfig, profileOverrides, userHeuristics, configPath };
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
