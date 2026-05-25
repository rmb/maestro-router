#!/usr/bin/env node
// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerBenchCommand } from "./bench.js";
import { registerExportPromptsCommand } from "./export-prompts.js";
import { registerDoctorCommand } from "./doctor.js";
import { registerHealthCommand } from "./health.js";
import { registerGuideCommand } from "./guide.js";
import { registerInitCommand } from "./init.js";
import { registerInstallCommandsCommand } from "./install-commands.js";
import { registerInstallDefaultsCommand } from "./install-defaults.js";
import { registerInstallHookCommand } from "./install-hook.js";
import { registerInstallVscodeCommand } from "./install-vscode.js";
import { registerReplayCommand } from "./replay.js";
import { registerRunCommand } from "./run-cmd.js";
import { registerStatsCommand } from "./stats.js";
import { registerTelemetryCommand } from "./telemetry-cmd.js";
import { registerTuneCommand } from "./tune.js";
import { shouldEnterWireCompat, wireCompatMain } from "./wire-compat.js";

export type GlobalOptions = {
  quiet?: boolean;
  verbose?: boolean;
  json?: boolean;
  config?: string;
};

async function readPackageVersion(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  // Walk up to find package.json (works in both src/ and dist/)
  for (const candidate of [
    join(here, "..", "..", "package.json"),
    join(here, "..", "..", "..", "package.json"),
  ]) {
    try {
      const raw = await readFile(candidate, "utf8");
      const pkg = JSON.parse(raw) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch {
      // try next
    }
  }
  return "0.0.0";
}

export async function buildProgram(): Promise<Command> {
  const program = new Command();
  const version = await readPackageVersion();

  program
    .name("maestro")
    .description(
      "Route Claude Code prompts to the optimal model + thinking budget. Works on Pro/Team subscriptions; no API key required.",
    )
    .version(version, "-V, --version")
    .option("-q, --quiet", "suppress informational output")
    .option("-v, --verbose", "verbose output")
    .option("--json", "machine-readable JSON output")
    .option("--config <path>", "config file path override")
    .helpOption("-h, --help", "display help");

  registerRunCommand(program);
  registerTelemetryCommand(program);
  registerStatsCommand(program);
  registerTuneCommand(program);
  registerReplayCommand(program);
  registerExportPromptsCommand(program);
  registerBenchCommand(program);
  registerInstallVscodeCommand(program);
  registerInstallHookCommand(program);
  registerInstallCommandsCommand(program);
  registerInstallDefaultsCommand(program);
  registerGuideCommand(program);
  registerInitCommand(program);
  registerDoctorCommand(program);
  registerHealthCommand(program);

  return program;
}

export async function main(argv: ReadonlyArray<string> = process.argv): Promise<void> {
  if (shouldEnterWireCompat(argv)) {
    const code = await wireCompatMain(argv);
    process.exit(code);
  }
  const program = await buildProgram();
  await program.parseAsync([...argv]);
}

import { realpathSync } from "node:fs";

const isDirectInvocation = (): boolean => {
  if (typeof process === "undefined" || !process.argv[1]) return false;
  try {
    const thisFile = fileURLToPath(import.meta.url);
    const invoked = realpathSync(process.argv[1]);
    return thisFile === invoked;
  } catch {
    return false;
  }
};

if (isDirectInvocation()) {
  main().catch((err: unknown) => {
    process.stderr.write(`maestro: ${(err as Error).message ?? String(err)}\n`);
    process.exit(1);
  });
}
