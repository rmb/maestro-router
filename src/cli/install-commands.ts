// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0
//
// `maestro install-commands` writes a set of Claude Code slash commands
// into ~/.claude/commands/ so the user can type /maestro-stats, /maestro-tune,
// etc. directly in the panel UI. Each slash command is a markdown file with
// YAML frontmatter that tells Claude to invoke the corresponding maestro
// subcommand via the Bash tool.

import type { Command } from "commander";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { bold, cyan, dim, green, header, yellow } from "./render.js";

const COMMANDS_DIR = join(homedir(), ".claude", "commands");

type SlashCommand = {
  name: string;
  description: string;
  body: string;
};

const COMMANDS: ReadonlyArray<SlashCommand> = [
  {
    name: "maestro-stats",
    description: "Show Maestro routing stats: cost vs Opus baseline, cache hit, per-class distribution",
    body: `Run \`maestro stats\` via the Bash tool and show the output to the user. Use the \`--since\` flag if the user mentions a different time window (e.g., \`--since 30\` for last 30 days).`,
  },
  {
    name: "maestro-tune",
    description: "Analyze telemetry and suggest heuristic patterns Maestro keeps mis-classifying",
    body: `Run \`maestro tune\` via the Bash tool. If the user asks to apply the suggestions, run \`maestro tune --apply\`. If they ask to mine override patterns specifically, run \`maestro tune --learn\`.`,
  },
  {
    name: "maestro-bench",
    description: "Run the Maestro eval suite against the current pipeline",
    body: `Run \`maestro bench\` via the Bash tool. If the user mentions a proposed overrides file, run \`maestro bench --propose <file>\`. Do NOT run \`--tournament\` flags without explicit user confirmation — they cost real money.`,
  },
  {
    name: "maestro-telemetry",
    description: "Inspect recent Maestro routing decisions",
    body: `Run \`maestro telemetry show --limit 20\` via the Bash tool and show the output to the user. If they ask for status, run \`maestro telemetry status\` instead.`,
  },
  {
    name: "maestro-guide",
    description: "Show the post-install checklist (Now / This Week / Ongoing)",
    body: `Run \`maestro guide\` via the Bash tool and show the output to the user verbatim — it's already formatted.`,
  },
];

function renderMarkdown(cmd: SlashCommand): string {
  return `---
description: ${cmd.description}
---

${cmd.body}
`;
}

export function registerInstallCommandsCommand(program: Command): void {
  program
    .command("install-commands")
    .description(
      "Install Claude Code slash commands (/maestro-stats, /maestro-tune, ...) into ~/.claude/commands/",
    )
    .option("--dry-run", "list what would be written without touching the filesystem")
    .option("--uninstall", "remove the Maestro slash commands")
    .action(async (cmdOpts: { dryRun?: boolean; uninstall?: boolean }) => {
      const lines: string[] = [];
      lines.push("");
      lines.push(
        header(cmdOpts.uninstall ? "Uninstalling Maestro slash commands" : "Installing Maestro slash commands"),
      );
      lines.push(dim(`  target: ${COMMANDS_DIR}`));
      lines.push("");

      if (cmdOpts.uninstall) {
        for (const cmd of COMMANDS) {
          const path = join(COMMANDS_DIR, `${cmd.name}.md`);
          if (cmdOpts.dryRun) {
            lines.push(`  ${yellow("would remove")} ${dim(path)}`);
          } else {
            try {
              await rm(path);
              lines.push(`  ${green("✓ removed")} ${dim(path)}`);
            } catch (err) {
              if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
                lines.push(`  ${yellow("⚠")} could not remove ${path}: ${(err as Error).message}`);
              } else {
                lines.push(`  ${dim("·")} ${dim("not present")} ${dim(path)}`);
              }
            }
          }
        }
        lines.push("");
        lines.push(dim("  reload your VSCode window for the change to take effect"));
        process.stdout.write(lines.join("\n") + "\n");
        return;
      }

      if (!cmdOpts.dryRun) {
        await mkdir(COMMANDS_DIR, { recursive: true });
      }

      for (const cmd of COMMANDS) {
        const path = join(COMMANDS_DIR, `${cmd.name}.md`);
        const content = renderMarkdown(cmd);
        if (cmdOpts.dryRun) {
          lines.push(`  ${yellow("would write")} ${cyan("/" + cmd.name)} ${dim("→ " + path)}`);
        } else {
          await writeFile(path, content, "utf8");
          lines.push(`  ${green("✓")} ${cyan("/" + cmd.name)} ${dim("→ " + path)}`);
          lines.push(`      ${dim(cmd.description)}`);
        }
      }

      lines.push("");
      lines.push(`  ${bold("Next:")} ${dim("reload your VSCode window")} (${cyan("Cmd+Shift+P → Developer: Reload Window")})`);
      lines.push(`  ${dim("Then in the Claude Code panel, type")} ${cyan("/")} ${dim("and see the new commands in the picker.")}`);

      process.stdout.write(lines.join("\n") + "\n");
    });
}
