// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { Command } from "commander";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { registerTelemetryCommand } from "./telemetry-cmd.js";

// Note: we register only the telemetry subcommand on a fresh Command rather
// than going through buildProgram() — that pulls in run-cmd/replay/bench
// which currently import an embedding classifier that may not be present
// in this branch state. This file only exercises the telemetry feedback
// command path.

function makeProgram(): Command {
  const program = new Command();
  program
    .name("maestro")
    .option("-q, --quiet", "suppress informational output")
    .option("--json", "JSON output")
    .option("--config <path>", "config override");
  registerTelemetryCommand(program);
  return program;
}

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "maestro-fb-"));
}

async function writeUserConfig(dir: string, telemetryPath: string): Promise<string> {
  const path = join(dir, "config.json");
  await writeFile(path, JSON.stringify({ telemetryPath }), "utf8");
  return path;
}

async function readLogged(telemetryPath: string): Promise<unknown[]> {
  const data = await readFile(telemetryPath, "utf8");
  return data
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as unknown);
}

describe("telemetry feedback --auto", () => {
  let workDir = "";
  let telemetryPath = "";
  let configPath = "";

  beforeEach(async () => {
    workDir = await makeTempDir();
    telemetryPath = join(workDir, "decisions.jsonl");
    configPath = await writeUserConfig(workDir, telemetryPath);
  });

  afterEach(() => {
    workDir = "";
  });

  test("records source=manual by default", async () => {
    const program = makeProgram();
    await program.parseAsync(
      [
        "--quiet",
        "--config",
        configPath,
        "telemetry",
        "feedback",
        "sess-1",
        "--rating",
        "4",
      ],
      { from: "user" },
    );
    const events = await readLogged(telemetryPath);
    expect(events).toHaveLength(1);
    const ev = events[0] as { type: string; rating: number; source?: string };
    expect(ev.type).toBe("feedback");
    expect(ev.rating).toBe(4);
    expect(ev.source).toBe("manual");
  });

  test("records source=auto when --auto is passed", async () => {
    const program = makeProgram();
    await program.parseAsync(
      [
        "--quiet",
        "--config",
        configPath,
        "telemetry",
        "feedback",
        "sess-2",
        "--rating",
        "2",
        "--auto",
      ],
      { from: "user" },
    );
    const events = await readLogged(telemetryPath);
    expect(events).toHaveLength(1);
    const ev = events[0] as { source?: string; rating: number; sessionId: string };
    expect(ev.source).toBe("auto");
    expect(ev.rating).toBe(2);
    expect(ev.sessionId).toBe("sess-2");
  });
});
