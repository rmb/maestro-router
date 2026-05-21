// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0
// budget: 5ms

import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { TelemetryEvent } from "./types.js";

const DEFAULT_PATH = join(homedir(), ".maestro", "decisions.jsonl");
const DEFAULT_CONFIG_PATH = join(homedir(), ".maestro", "config.json");
const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;

export type TelemetryOptions = {
  path?: string;
  configPath?: string;
  maxFileBytes?: number;
};

export type TelemetryWriter = {
  log(event: TelemetryEvent): Promise<void>;
  readAll(): Promise<TelemetryEvent[]>;
};

/** Local JSONL telemetry writer. Errors are swallowed (warn to stderr); never blocks routing. */
export function createTelemetry(opts: TelemetryOptions = {}): TelemetryWriter {
  const path = opts.path ?? DEFAULT_PATH;
  const configPath = opts.configPath ?? DEFAULT_CONFIG_PATH;
  const maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;

  return {
    async log(event: TelemetryEvent): Promise<void> {
      try {
        await mkdir(dirname(path), { recursive: true });
        await rotateIfNeeded(path, maxFileBytes);
        await appendFile(path, JSON.stringify(event) + "\n", "utf8");
        await updateCounters(configPath, event.ts);
      } catch (err) {
        process.stderr.write(`maestro telemetry: ${(err as Error).message}\n`);
      }
    },

    async readAll(): Promise<TelemetryEvent[]> {
      try {
        const data = await readFile(path, "utf8");
        return data
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line) as TelemetryEvent);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw err;
      }
    },
  };
}

async function rotateIfNeeded(path: string, maxBytes: number): Promise<void> {
  try {
    const s = await stat(path);
    if (s.size >= maxBytes) {
      await rename(path, `${path}.${Date.now()}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

type ConfigShape = {
  telemetry?: { eventsLogged?: number; lastWriteAt?: string };
  [key: string]: unknown;
};

async function updateCounters(configPath: string, ts: string): Promise<void> {
  let config: ConfigShape = {};
  try {
    const data = await readFile(configPath, "utf8");
    config = JSON.parse(data) as ConfigShape;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const prior = config.telemetry?.eventsLogged ?? 0;
  config.telemetry = {
    eventsLogged: prior + 1,
    lastWriteAt: ts,
  };
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
}
