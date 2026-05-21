// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0
//
// `maestro install-defaults` writes two things at first-install time:
//   1. ~/.maestro/config.json — sensible cost-saving defaults (only if missing)
//   2. Appends a Maestro routing-discipline section to ~/.claude/CLAUDE.md
//      so future Claude Code sessions know how to cooperate with Maestro
//      (only if the marker isn't already present — idempotent).
//
// Both writes are reversible via `maestro install-defaults --uninstall`.

import type { Command } from "commander";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { bold, cyan, dim, gray, green, header, yellow } from "./render.js";

const CONFIG_DIR = join(homedir(), ".maestro");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const CLAUDE_CONFIG_PATH = join(homedir(), ".claude", "CLAUDE.md");

const DEFAULT_CONFIG = {
  profile: "balanced",
  aggressiveness: "balanced",
  dailyCostCapUsd: 10.0,
  excludeDynamicSections: true,
  useLlmClassifier: true,
  useEmbeddingClassifier: true,
  autoCompact: false,
  autoCompactThresholdTokens: 8000,
  feedbackPrompts: "occasional",
  feedbackSampleRate: 0.15,
  autoLearn: true,
};

const MARKER_BEGIN = "<!-- maestro:routing-discipline:begin -->";
const MARKER_END = "<!-- maestro:routing-discipline:end -->";

const CLAUDE_SNIPPET = `${MARKER_BEGIN}

## Maestro routing (cost discipline)

This machine runs Maestro (https://github.com/rmb/maestro-router) as the
\`claudeProcessWrapper\`. Every prompt is auto-routed to the cheapest model
that will produce the right answer.

To cooperate with Maestro:

- Prefer **one comprehensive prompt** to many small ones. Each fresh session
  pays a ~$0.02–$0.05 \`cache_creation\` hit on its first turn; piling
  questions into one turn amortizes that cost.
- Use override hints inline when complexity is obvious:
  \`@fast format this file\` (Haiku), \`@think design the cache layer\`
  (Opus), \`@deep find the root cause of this race condition\` (Opus max).
- Don't manually call \`/model\`; Maestro routes per-turn. Manual overrides
  may break session continuity and waste the cache_creation hit.
- Avoid spawning new sessions for follow-up work in the same cwd — Maestro
  reuses sessions automatically via \`--session-id\`/\`--resume\`.
- When iterating, batch tool calls (Read/Grep/Edit) — fewer turns means
  fewer \`cache_creation\` events.
- For research / planning, use \`@think\` once on the big question rather
  than many small \`@fast\` follow-ups; the thinking budget amortizes
  better in one turn than across ten.

Inspect savings: \`maestro stats\`. Tune routing: \`maestro tune\`. Full
workflow: \`maestro guide\`.

${MARKER_END}
`;

type InstallDefaultsOptions = {
  dryRun?: boolean;
  uninstall?: boolean;
  force?: boolean;
};

export function registerInstallDefaultsCommand(program: Command): void {
  program
    .command("install-defaults")
    .description(
      "Write ~/.maestro/config.json and append the Maestro routing section to ~/.claude/CLAUDE.md (idempotent)",
    )
    .option("--dry-run", "show what would change without writing")
    .option("--uninstall", "revert: remove the Maestro section from ~/.claude/CLAUDE.md")
    .option("--force", "overwrite existing ~/.maestro/config.json (skips missing-only check)")
    .action(async (opts: InstallDefaultsOptions) => {
      const lines: string[] = [];
      lines.push("");
      lines.push(header(opts.uninstall ? "Reverting Maestro defaults" : "Installing Maestro defaults"));
      lines.push("");

      // 1. ~/.maestro/config.json (skip if exists unless --force)
      if (opts.uninstall) {
        lines.push(`  ${dim("(config.json left in place — delete it manually if you want it gone)")}`);
      } else {
        const existing = await tryReadJson(CONFIG_PATH);
        if (existing && !opts.force) {
          lines.push(
            `  ${gray("·")} ${cyan(CONFIG_PATH)} ${dim("already exists; left untouched")}`,
          );
          lines.push(`      ${dim("re-run with --force to overwrite")}`);
        } else if (opts.dryRun) {
          lines.push(`  ${yellow("would write")} ${cyan(CONFIG_PATH)} ${dim("with cost-saving defaults")}`);
        } else {
          await mkdir(CONFIG_DIR, { recursive: true });
          await writeFile(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", "utf8");
          lines.push(`  ${green("✓ wrote")} ${cyan(CONFIG_PATH)}`);
        }
      }

      // 2. ~/.claude/CLAUDE.md (append section, idempotent via markers)
      const claudeMd = await tryReadText(CLAUDE_CONFIG_PATH);
      const alreadyPresent = claudeMd !== null && claudeMd.includes(MARKER_BEGIN);

      if (opts.uninstall) {
        if (!alreadyPresent) {
          lines.push(`  ${gray("·")} ${cyan(CLAUDE_CONFIG_PATH)} ${dim("Maestro section not present")}`);
        } else if (opts.dryRun) {
          lines.push(`  ${yellow("would remove")} Maestro section from ${cyan(CLAUDE_CONFIG_PATH)}`);
        } else {
          const next = removeMaestroSection(claudeMd ?? "");
          await mkdir(dirname(CLAUDE_CONFIG_PATH), { recursive: true });
          await writeFile(CLAUDE_CONFIG_PATH, next, "utf8");
          lines.push(`  ${green("✓ removed")} Maestro section from ${cyan(CLAUDE_CONFIG_PATH)}`);
        }
      } else if (alreadyPresent) {
        lines.push(
          `  ${gray("·")} ${cyan(CLAUDE_CONFIG_PATH)} ${dim("Maestro section already present; left untouched")}`,
        );
      } else if (opts.dryRun) {
        lines.push(`  ${yellow("would append")} Maestro routing section to ${cyan(CLAUDE_CONFIG_PATH)}`);
      } else {
        const next = (claudeMd ?? "") + (claudeMd && !claudeMd.endsWith("\n") ? "\n\n" : "\n") + CLAUDE_SNIPPET;
        await mkdir(dirname(CLAUDE_CONFIG_PATH), { recursive: true });
        await writeFile(CLAUDE_CONFIG_PATH, next, "utf8");
        lines.push(`  ${green("✓ appended")} Maestro routing section to ${cyan(CLAUDE_CONFIG_PATH)}`);
      }

      lines.push("");
      if (!opts.uninstall && !opts.dryRun) {
        lines.push(`  ${bold("Next:")} ${dim("any new Claude Code session will read the appended section and route via Maestro.")}`);
      }
      process.stdout.write(lines.join("\n") + "\n");
    });
}

async function tryReadText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function tryReadJson(path: string): Promise<unknown> {
  const text = await tryReadText(path);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function removeMaestroSection(source: string): string {
  const begin = source.indexOf(MARKER_BEGIN);
  if (begin === -1) return source;
  const end = source.indexOf(MARKER_END, begin);
  if (end === -1) return source;
  const after = end + MARKER_END.length;
  // Eat a trailing newline pair if present so we don't leave double-blank gaps.
  let cut = after;
  if (source[cut] === "\n") cut++;
  if (source[cut] === "\n") cut++;
  return source.slice(0, begin) + source.slice(cut);
}
