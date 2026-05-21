// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0
//
// `maestro install-hook` — write Maestro's Stop-event hook into Claude
// Code's user settings (~/.claude/settings.json) so the panel asks for
// quality feedback after each response. Sampling controlled by
// userConfig.feedbackPrompts + feedbackSampleRate (see hooks/stop-feedback.sh).

import type { Command } from "commander";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Tag we embed in the hook command so we can find / dedupe / uninstall ours. */
export const HOOK_MARKER = "# maestro-stop-feedback-hook";

export const DEFAULT_CLAUDE_SETTINGS = join(homedir(), ".claude", "settings.json");
export const DEFAULT_HOOK_INSTALL_PATH = join(
  homedir(),
  ".maestro",
  "hooks",
  "stop-feedback.sh",
);

export function registerInstallHookCommand(program: Command): void {
  program
    .command("install-hook")
    .description(
      "Install Maestro's Stop-event feedback hook into Claude Code's settings.json (~/.claude/settings.json).",
    )
    .option("--dry-run", "show what would change without writing")
    .option(
      "--path <p>",
      "explicit Claude Code settings.json path (overrides default)",
    )
    .option(
      "--hook-path <p>",
      "explicit path where stop-feedback.sh should be installed/referenced (defaults to ~/.maestro/hooks/stop-feedback.sh)",
    )
    .option("--uninstall", "remove Maestro's Stop hook entry instead of adding")
    .action(
      async (cmdOpts: {
        dryRun?: boolean;
        path?: string;
        hookPath?: string;
        uninstall?: boolean;
      }) => {
        const settingsPath = cmdOpts.path ?? DEFAULT_CLAUDE_SETTINGS;
        const hookPath = cmdOpts.hookPath ?? DEFAULT_HOOK_INSTALL_PATH;

        process.stdout.write(`Claude Code settings: ${settingsPath}\n`);
        if (cmdOpts.uninstall) {
          process.stdout.write(`Action: remove Maestro Stop hook\n`);
        } else {
          process.stdout.write(`Hook script:          ${hookPath}\n`);
        }

        // Resolve the bundled script and copy it to a stable location if
        // we're installing (and not just dry-running).
        if (!cmdOpts.uninstall) {
          const bundled = locateBundledHook();
          if (!bundled) {
            process.stderr.write(
              "Could not locate bundled hooks/stop-feedback.sh next to the maestro binary.\n",
            );
            process.exit(1);
          }
          if (!cmdOpts.dryRun) {
            await ensureHookScript(bundled, hookPath);
          }
        }

        const existing = await readSettingsOrEmpty(settingsPath);
        const next = cmdOpts.uninstall
          ? removeMaestroStopHook(existing)
          : addMaestroStopHook(existing, hookPath);

        if (next === existing) {
          process.stdout.write("No change needed (already up to date).\n");
          return;
        }

        if (cmdOpts.dryRun) {
          process.stdout.write("\n--- Proposed settings.json ---\n");
          process.stdout.write(next + "\n");
          process.stdout.write(
            "--- end ---\n\nDry run; no file written. Re-run without --dry-run to apply.\n",
          );
          return;
        }

        await mkdir(dirname(settingsPath), { recursive: true });
        await writeFile(settingsPath, next, "utf8");
        process.stdout.write("Wrote settings.json.\n\n");
        if (!cmdOpts.uninstall) {
          process.stdout.write(
            "Next: open ~/.maestro/config.json and set feedbackPrompts to\n",
          );
          process.stdout.write(
            "  \"occasional\" (default 1-in-5 sampling) or \"always\".\n",
          );
        }
      },
    );
}

async function readSettingsOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "{}\n";
    throw err;
  }
}

/**
 * Locate hooks/stop-feedback.sh shipped with the package. Searches relative
 * to this module's URL (works from src/ and dist/).
 */
export function locateBundledHook(): string | null {
  let here: string;
  try {
    here = dirname(fileURLToPath(import.meta.url));
  } catch {
    return null;
  }
  for (const candidate of [
    // dist/cli/install-hook.js → ../../hooks/stop-feedback.sh
    resolve(here, "..", "..", "hooks", "stop-feedback.sh"),
    // src/cli/install-hook.ts → ../../hooks/stop-feedback.sh
    resolve(here, "..", "..", "..", "hooks", "stop-feedback.sh"),
  ]) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      /* try next */
    }
  }
  return null;
}

async function ensureHookScript(source: string, dest: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  let needsCopy = true;
  try {
    const [src, dst] = await Promise.all([readFile(source, "utf8"), readFile(dest, "utf8")]);
    needsCopy = src !== dst;
  } catch {
    needsCopy = true;
  }
  if (needsCopy) {
    await copyFile(source, dest);
  }
  // Always ensure executable (no-op if already +x).
  try {
    const s = await stat(dest);
    // 0o111 = +x bits. OR them in without disturbing other modes.
    await chmod(dest, s.mode | 0o111);
  } catch {
    /* best effort */
  }
}

// ---- Pure JSON helpers (tested directly) ----

type StopHookEntry = {
  matcher?: string;
  hooks?: Array<{ type?: string; command?: string }>;
};

type SettingsShape = {
  hooks?: { Stop?: StopHookEntry[] } & Record<string, unknown>;
} & Record<string, unknown>;

function maestroEntry(hookPath: string): StopHookEntry {
  return {
    matcher: "",
    hooks: [
      {
        type: "command",
        // Embed a marker so we can find ours later. Sh: anything after `#`
        // on a command line is a comment.
        command: `${hookPath} ${HOOK_MARKER}`,
      },
    ],
  };
}

function isMaestroEntry(entry: StopHookEntry): boolean {
  if (!entry || !Array.isArray(entry.hooks)) return false;
  return entry.hooks.some(
    (h) => typeof h?.command === "string" && h.command.includes(HOOK_MARKER),
  );
}

/**
 * Insert (or refresh path of) Maestro's Stop hook into settings.json text.
 * Idempotent: re-running yields the same content.
 *
 * Unlike install-vscode we use full JSON parse/stringify here because the
 * hooks block is nested and Claude Code's settings.json is documented as
 * JSON, not JSONC. If the file is unparseable we fall back to a fresh shape.
 */
export function addMaestroStopHook(source: string, hookPath: string): string {
  const parsed = safeParseSettings(source);
  const settings: SettingsShape = parsed ?? {};
  const hooks = (settings.hooks ??= {});
  const stopArr: StopHookEntry[] = Array.isArray(hooks.Stop) ? [...hooks.Stop] : [];
  const desired = maestroEntry(hookPath);

  let changed = false;
  const existingIdx = stopArr.findIndex(isMaestroEntry);
  if (existingIdx === -1) {
    stopArr.push(desired);
    changed = true;
  } else {
    // Refresh path if it diverged.
    const cur = stopArr[existingIdx];
    const desiredCmd = desired.hooks?.[0]?.command;
    const curCmd = cur?.hooks?.[0]?.command;
    if (curCmd !== desiredCmd) {
      stopArr[existingIdx] = desired;
      changed = true;
    }
  }
  if (!changed) return source;
  hooks.Stop = stopArr;
  return JSON.stringify(settings, null, 2) + "\n";
}

/** Remove only Maestro's entry from hooks.Stop. Leaves the rest intact. */
export function removeMaestroStopHook(source: string): string {
  const parsed = safeParseSettings(source);
  if (!parsed) return source;
  const stopArr = parsed.hooks?.Stop;
  if (!Array.isArray(stopArr)) return source;
  const filtered = stopArr.filter((e) => !isMaestroEntry(e));
  if (filtered.length === stopArr.length) return source;

  const settings: SettingsShape = { ...parsed };
  const hooks: { Stop?: StopHookEntry[] } & Record<string, unknown> = {
    ...(parsed.hooks ?? {}),
  };
  if (filtered.length === 0) {
    delete hooks.Stop;
  } else {
    hooks.Stop = filtered;
  }
  if (Object.keys(hooks).length === 0) {
    delete settings.hooks;
  } else {
    settings.hooks = hooks;
  }
  return JSON.stringify(settings, null, 2) + "\n";
}

function safeParseSettings(source: string): SettingsShape | null {
  const trimmed = source.trim();
  if (!trimmed) return {};
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as SettingsShape;
    }
    return null;
  } catch {
    return null;
  }
}
