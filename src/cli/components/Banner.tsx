// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BannerInfo = { cwd: string; resumed: boolean };

// ---------------------------------------------------------------------------
// Helpers (shared by both Ink component and raw-ANSI fallback)
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
// Ink component
// ---------------------------------------------------------------------------

// We use lazy-import so missing ink/react peers don't blow up at load time.
// The component is only referenced inside renderBanner when ink IS available.

type BoxProps = {
  flexDirection?: "row" | "column";
  children?: unknown;
};
type TextProps = {
  bold?: boolean;
  dimColor?: boolean;
  color?: string;
  children?: unknown;
};

// The banner is a static string render, so we produce plain JSX that ink's
// renderToString can serialise.
function BannerComponent({ info }: { info?: BannerInfo }) {
  // We import Box/Text lazily from ink inside renderBanner; here we declare
  // stand-in prop-shapes so the component body compiles. The actual Ink
  // module is injected via the `createBanner` factory below.
  const { Box, Text } = BannerComponent._components as {
    Box: (props: BoxProps) => JSX.Element | null;
    Text: (props: TextProps) => JSX.Element | null;
  };

  const W = 44;
  const cwdStr = info ? formatCwd(info.cwd) : formatCwd(process.cwd());
  const sessionStr = info?.resumed ? "resumed" : "new";
  const statusVisible = `${cwdStr}  ·  ${sessionStr}`;
  const maxStatusVisible = W - 2;
  const statusTrunc =
    statusVisible.length > maxStatusVisible
      ? statusVisible.slice(0, maxStatusVisible - 1) + "…"
      : statusVisible;
  const statusPad = " ".repeat(maxStatusVisible - statusTrunc.length);

  const hLine = "═".repeat(W);
  const emptyRow = " ".repeat(W);
  const routeText = "  auto-route · cheapest model that works";

  return (
    <Box flexDirection="column">
      <Text>{""}</Text>

      {/* Top border ╔══ maestro shell ══…╗ */}
      <Text dimColor>
        {" ╔══ "}
        <Text bold>maestro shell</Text>
        <Text dimColor>{"" + " " + "═".repeat(W - 17) + "╗"}</Text>
      </Text>

      {/* Empty row */}
      <Text dimColor>{" ║" + emptyRow + "║"}</Text>

      {/* Route line */}
      <Text dimColor>
        {" ║"}
        <Text>{routeText + " ".repeat(W - routeText.trim().length - 2)}</Text>
        {"║"}
      </Text>

      {/* Empty row */}
      <Text dimColor>{" ║" + emptyRow + "║"}</Text>

      {/* Divider ╠═══…╣ */}
      <Text dimColor>{" ╠" + hLine + "╣"}</Text>

      {/* Model tiers row */}
      <Text dimColor>
        {" ║  "}
        <Text color="green">haiku</Text>
        <Text dimColor>{"  ·  "}</Text>
        <Text color="cyan">sonnet</Text>
        <Text dimColor>{"  ·  "}</Text>
        <Text color="magenta">opus</Text>
        <Text dimColor>{" ".repeat(W - 2 - 25) + "║"}</Text>
      </Text>

      {/* Hints row */}
      <Text dimColor>
        {" ║  "}
        <Text color="green">@fast</Text>
        <Text dimColor>{" · "}</Text>
        <Text color="cyan">@think</Text>
        <Text dimColor>{" · "}</Text>
        <Text color="magenta">@deep</Text>
        <Text dimColor>{"  ·  /help" + " ".repeat(W - 2 - 32) + "║"}</Text>
      </Text>

      {/* Divider ╠═══…╣ */}
      <Text dimColor>{" ╠" + hLine + "╣"}</Text>

      {/* Status row */}
      <Text dimColor>{" ║  " + statusTrunc + statusPad + "║"}</Text>

      {/* Bottom border ╚═══…╝ */}
      <Text dimColor>{" ╚" + hLine + "╝"}</Text>

      <Text>{""}</Text>
    </Box>
  );
}

// Slot for Ink primitives — injected at render time so the module is
// importable without ink installed.
BannerComponent._components = {} as {
  Box: (props: BoxProps) => JSX.Element | null;
  Text: (props: TextProps) => JSX.Element | null;
};

// ---------------------------------------------------------------------------
// Raw-ANSI fallback (exact copy of original printBanner logic)
// ---------------------------------------------------------------------------

function printBannerAnsi(info?: BannerInfo): void {
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
 * Render the startup banner. Tries Ink (renderToString) when available;
 * falls back to raw-ANSI output otherwise.
 */
export async function renderBanner(info?: BannerInfo): Promise<void> {
  // Fast path: no TTY → ANSI fallback (ink needs a TTY to colour correctly)
  const isTTY = (process.stdout as { isTTY?: boolean }).isTTY === true;
  if (!isTTY) {
    printBannerAnsi(info);
    return;
  }

  try {
    // Dynamic import — safe to fail if ink/react aren't installed.
    const [inkMod, reactMod] = await Promise.all([
      import("ink") as Promise<{
        render: (el: unknown) => { unmount: () => void };
        Box: (props: BoxProps) => JSX.Element | null;
        Text: (props: TextProps) => JSX.Element | null;
      }>,
      import("react") as Promise<{ createElement: (...args: unknown[]) => unknown }>,
    ]);

    // Inject Ink primitives into the component.
    BannerComponent._components = { Box: inkMod.Box, Text: inkMod.Text };

    // render() + immediate unmount is the safest static approach for ink v4/v5.
    const props: { info?: BannerInfo } = info !== undefined ? { info } : {};
    const element = reactMod.createElement(BannerComponent, props);
    const { unmount } = inkMod.render(element);
    // Give Ink one event-loop tick to flush output, then tear down.
    await new Promise<void>((resolve) => setImmediate(resolve));
    unmount();
  } catch {
    // ink/react not installed — fall through to ANSI output.
    printBannerAnsi(info);
  }
}
