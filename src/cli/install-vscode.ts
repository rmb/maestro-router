// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0
//
// `maestro install-vscode` — write the path of this maestro binary into the
// official Claude Code VSCode extension's `claudeProcessWrapper` setting,
// so every panel-UI prompt is auto-routed through Maestro.

import type { Command } from "commander";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SETTING_KEY = "claudeCode.claudeProcessWrapper";

export function registerInstallVscodeCommand(program: Command): void {
  program
    .command("install-vscode")
    .description(
      "Wire the official Claude Code VSCode extension to route through Maestro (sets claudeCode.claudeProcessWrapper).",
    )
    .option("--dry-run", "show what would change without writing")
    .option(
      "--path <p>",
      "explicit VSCode user settings.json path (overrides OS default)",
    )
    .option(
      "--wrapper <p>",
      "explicit maestro binary path to write (defaults to detecting this binary)",
    )
    .option("--uninstall", "remove the claudeProcessWrapper setting instead of adding")
    .action(
      async (cmdOpts: {
        dryRun?: boolean;
        path?: string;
        wrapper?: string;
        uninstall?: boolean;
      }) => {
        const settingsPath = cmdOpts.path ?? defaultSettingsPath();
        const wrapperPath = cmdOpts.wrapper ?? detectMaestroBinary();
        if (!wrapperPath) {
          process.stderr.write(
            "Could not detect maestro binary path. Pass --wrapper <path> explicitly.\n",
          );
          process.exit(1);
        }

        process.stdout.write(`VSCode settings file: ${settingsPath}\n`);
        if (cmdOpts.uninstall) {
          process.stdout.write(`Action: remove ${SETTING_KEY}\n`);
        } else {
          process.stdout.write(`Setting:  ${SETTING_KEY} = ${wrapperPath}\n`);
        }

        const existing = await readSettingsOrEmpty(settingsPath);
        const next = cmdOpts.uninstall
          ? removeSetting(existing, SETTING_KEY)
          : setSetting(existing, SETTING_KEY, wrapperPath);

        if (next === existing) {
          process.stdout.write("No change needed (already up to date).\n");
          return;
        }

        if (cmdOpts.dryRun) {
          process.stdout.write("\n--- Proposed settings.json ---\n");
          process.stdout.write(next + "\n");
          process.stdout.write("--- end ---\n\nDry run; no file written. Re-run without --dry-run to apply.\n");
          return;
        }

        await mkdir(dirname(settingsPath), { recursive: true });
        await writeFile(settingsPath, next, "utf8");
        process.stdout.write("Wrote settings.json.\n\n");
        process.stdout.write("Next: reload your VSCode window:\n");
        process.stdout.write("  Cmd+Shift+P (macOS) or Ctrl+Shift+P (Linux/Win) → 'Developer: Reload Window'\n");
        process.stdout.write("Then every prompt in the Claude Code panel will route through Maestro.\n");
      },
    );
}

export function defaultSettingsPath(): string {
  switch (platform()) {
    case "darwin":
      return join(homedir(), "Library", "Application Support", "Code", "User", "settings.json");
    case "win32":
      return join(process.env.APPDATA ?? homedir(), "Code", "User", "settings.json");
    default:
      return join(homedir(), ".config", "Code", "User", "settings.json");
  }
}

function detectMaestroBinary(): string | null {
  // 1. The realpath of our own running script (resolves through bin/ symlink)
  try {
    if (process.argv[1]) {
      const resolved = realpathSync(process.argv[1]);
      if (resolved.endsWith("cli/index.js") || resolved.endsWith("cli\\index.js")) {
        // We were invoked via `maestro …` from the bin shim. argv[1] IS the bin
        // path on macOS/Linux when the shim is a symlink to dist/cli/index.js.
        // Use argv[1] (the user-facing path) if it's not the realpath itself.
        return process.argv[1];
      }
    }
  } catch {
    // ignore
  }
  // 2. fileURLToPath import.meta.url — but that's the realpath inside node_modules
  try {
    return fileURLToPath(import.meta.url);
  } catch {
    return null;
  }
}

async function readSettingsOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "{\n}\n";
    throw err;
  }
}

/**
 * Insert or update a string setting in a JSONC settings file. We avoid a
 * full JSONC parser and operate textually so comments and formatting are
 * preserved. If the key already exists, replace its value; otherwise
 * append before the closing brace.
 */
export function setSetting(source: string, key: string, value: string): string {
  const escaped = JSON.stringify(value);
  const keyRegex = new RegExp(
    `("${escapeRegex(key)}"\\s*:\\s*)(?:"(?:[^"\\\\]|\\\\.)*"|true|false|null|-?\\d+(?:\\.\\d+)?)`,
    "m",
  );
  if (keyRegex.test(source)) {
    return source.replace(keyRegex, `$1${escaped}`);
  }
  // Insert before the final closing brace
  const closingIdx = source.lastIndexOf("}");
  if (closingIdx === -1) {
    // Not a JSON object; rewrite as fresh.
    return `{\n  "${key}": ${escaped}\n}\n`;
  }
  const head = source.slice(0, closingIdx).trimEnd();
  const tail = source.slice(closingIdx);
  const separator = head.endsWith("{") ? "" : ",";
  const indent = "  ";
  return `${head}${separator}\n${indent}"${key}": ${escaped}\n${tail}`;
}

export function removeSetting(source: string, key: string): string {
  // Remove a top-level "key": value, plus its trailing comma if present.
  const escaped = escapeRegex(key);
  const re = new RegExp(
    `(?:,\\s*)?"${escaped}"\\s*:\\s*(?:"(?:[^"\\\\]|\\\\.)*"|true|false|null|-?\\d+(?:\\.\\d+)?)(?:,)?\\s*`,
    "m",
  );
  return source.replace(re, "");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
