// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import type { Command } from "commander";
import { createTelemetry } from "../core/telemetry.js";
import type { TelemetryEvent } from "../core/types.js";
import {
  DEFAULT_TELEMETRY_PATH,
  DEFAULT_USER_CONFIG,
  format,
  loadCliConfig,
} from "./utils.js";

type ParentOptions = { json?: boolean; quiet?: boolean; config?: string };

const fmtOpts = (p: ParentOptions): { json?: boolean; quiet?: boolean } => {
  const out: { json?: boolean; quiet?: boolean } = {};
  if (p.json !== undefined) out.json = p.json;
  if (p.quiet !== undefined) out.quiet = p.quiet;
  return out;
};

export function registerTelemetryCommand(program: Command): void {
  const telemetry = program
    .command("telemetry")
    .description("Inspect local Maestro telemetry");

  telemetry
    .command("status")
    .description("Print event count, last-write timestamp, file path")
    .action(async () => {
      const parent = program.opts<ParentOptions>();
      const cli = await loadCliConfig(parent.config);
      const path = cli.userConfig.telemetryPath ?? DEFAULT_TELEMETRY_PATH;
      const t = createTelemetry({ path });
      const events = await t.readAll();
      const lastWrite = events.length > 0 ? events[events.length - 1]!.ts : null;

      const out = {
        path,
        configPath: DEFAULT_USER_CONFIG,
        eventsLogged: events.length,
        lastWriteAt: lastWrite,
        profile: cli.userConfig.profile ?? "balanced (default)",
      };
      process.stdout.write(format(out, fmtOpts(parent)) + "\n");
    });

  telemetry
    .command("show")
    .description("Print recent telemetry events as JSONL")
    .option("--limit <n>", "max events to print", "50")
    .action(async (cmdOpts: { limit: string }) => {
      const parent = program.opts<ParentOptions>();
      const cli = await loadCliConfig(parent.config);
      const path = cli.userConfig.telemetryPath ?? DEFAULT_TELEMETRY_PATH;
      const t = createTelemetry({ path });
      const all = await t.readAll();
      const n = Math.max(0, parseInt(cmdOpts.limit, 10));
      const recent = n === 0 ? all : all.slice(-n);
      if (parent.json) {
        process.stdout.write(JSON.stringify(recent, null, 2) + "\n");
      } else {
        for (const e of recent) {
          process.stdout.write(JSON.stringify(e) + "\n");
        }
      }
    });

  telemetry
    .command("feedback <sessionId>")
    .description("Record a 1-5 quality rating for a session")
    .requiredOption("--rating <n>", "rating (1-5)")
    .option("--note <text>", "free-text note")
    .action(
      async (sessionId: string, cmdOpts: { rating: string; note?: string }) => {
        const parent = program.opts<ParentOptions>();
        const cli = await loadCliConfig(parent.config);
        const ratingRaw = parseInt(cmdOpts.rating, 10);
        if (Number.isNaN(ratingRaw) || ratingRaw < 1 || ratingRaw > 5) {
          process.stderr.write("--rating must be an integer 1-5\n");
          process.exit(2);
        }
        const rating = ratingRaw as 1 | 2 | 3 | 4 | 5;
        const path = cli.userConfig.telemetryPath ?? DEFAULT_TELEMETRY_PATH;
        const t = createTelemetry({ path });
        const event: TelemetryEvent = {
          type: "feedback",
          ts: new Date().toISOString(),
          sessionId,
          rating,
          ...(cmdOpts.note ? { note: cmdOpts.note } : {}),
        };
        await t.log(event);
        if (!parent.quiet) {
          process.stdout.write(`Recorded feedback for ${sessionId}: rating=${rating}\n`);
        }
      },
    );
}
