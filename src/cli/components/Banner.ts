// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BannerInfo = { cwd: string; resumed: boolean };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatCwd(cwd: string): string {
  const home = process.env["HOME"] ?? "";
  const withTilde = home && cwd.startsWith(home) ? "~" + cwd.slice(home.length) : cwd;
  const rest = withTilde.startsWith("~/") ? withTilde.slice(2) : withTilde.replace(/^\//, "");
  const parts = rest.split("/").filter(Boolean);
  if (parts.length <= 2) return withTilde;
  return `~/…/${parts.slice(-2).join("/")}`;
}

// ---------------------------------------------------------------------------
// ANSI implementation
// ---------------------------------------------------------------------------

export function printBannerAnsi(info?: BannerInfo): void {
  const isTTY = (process.stdout as { isTTY?: boolean }).isTTY === true;
  const D = isTTY ? "\x1b[2m" : "";
  const B = isTTY ? "\x1b[1m" : "";
  const R = isTTY ? "\x1b[0m" : "";
  const G = isTTY ? "\x1b[32m" : "";
  const C = isTTY ? "\x1b[36m" : "";
  const M = isTTY ? "\x1b[35m" : "";
  const W = 44;
  const topInner = `══ ${R}${B}maestro shell${R}${D} ${"═".repeat(W - 17)}`;
  const emptyInner = " ".repeat(W);
  const divInner = "═".repeat(W);

  const routeText = "auto-route · cheapest model that works";
  const routeInner = "  " + routeText + " ".repeat(W - 2 - routeText.length);

  const haikuVisible = "haiku  ·  sonnet  ·  opus";
  const haikuInner = `  ${G}haiku${R}${D}  ·  ${R}${C}sonnet${R}${D}  ·  ${R}${M}opus${R}${D}${" ".repeat(W - 2 - haikuVisible.length)}`;

  const hintsVisible = "@fast · @think · @deep  ·  /help";
  const hintsInner = `  ${G}@fast${R}${D} · ${R}${C}@think${R}${D} · ${R}${M}@deep${R}${D}  ·  /help${" ".repeat(W - 2 - hintsVisible.length)}`;

  const cwdStr = info ? formatCwd(info.cwd) : formatCwd(process.cwd());
  const sessionStr = info?.resumed ? "resumed" : "new";
  const statusVisible = `${cwdStr}  ·  ${sessionStr}`;
  const maxStatusVisible = W - 2;
  const statusTrunc =
    statusVisible.length > maxStatusVisible
      ? statusVisible.slice(0, maxStatusVisible - 1) + "…"
      : statusVisible;
  const statusPad = " ".repeat(maxStatusVisible - statusTrunc.length);
  const statusInner = `  ${D}${statusTrunc}${statusPad}${R}`;

  const lines = [
    "",
    ` ${D}╔${topInner}╗${R}`,
    ` ${D}║${R}${emptyInner}${D}║${R}`,
    ` ${D}║${R}${routeInner}${D}║${R}`,
    ` ${D}║${R}${emptyInner}${D}║${R}`,
    ` ${D}╠${divInner}╣${R}`,
    ` ${D}║${R}${haikuInner}${D}║${R}`,
    ` ${D}║${R}${hintsInner}${D}║${R}`,
    ` ${D}╠${divInner}╣${R}`,
    ` ${D}║${statusInner}${D}║${R}`,
    ` ${D}╚${divInner}╝${R}`,
    "",
  ];
  process.stdout.write(lines.join("\n") + "\n");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render the startup banner using ANSI output.
 */
export async function renderBanner(info?: BannerInfo): Promise<void> {
  printBannerAnsi(info);
}
