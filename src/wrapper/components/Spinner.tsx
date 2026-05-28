// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import React, { useEffect, useState } from "react";
import type { Writable } from "node:stream";

// ---------------------------------------------------------------------------
// Constants (mirrors sdk-host.ts)
// ---------------------------------------------------------------------------

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

// ---------------------------------------------------------------------------
// Ink component
// ---------------------------------------------------------------------------

type TextProps = { dimColor?: boolean; children?: React.ReactNode };

function SpinnerComponent({ text, Text }: { text: string; Text: React.FC<TextProps> }) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setFrame((f) => f + 1), 100);
    return () => clearInterval(id);
  }, []);

  const icon = SPINNER_FRAMES[frame % SPINNER_FRAMES.length]!;

  return (
    <Text dimColor>
      {icon + " " + text + "…"}
    </Text>
  );
}

// ---------------------------------------------------------------------------
// Raw-ANSI fallback (mirrors sdk-host.ts startSpinner / clearSpinner)
// ---------------------------------------------------------------------------

export type SpinnerHandle = { stop: () => void };

function startAnsiSpinner(output: Writable, text: string): SpinnerHandle {
  let idx = 0;
  const timer = setInterval(() => {
    const icon = SPINNER_FRAMES[idx % SPINNER_FRAMES.length]!;
    output.write(`\r${DIM}${icon} ${text}…${RESET}`);
    idx++;
  }, 100);
  return {
    stop() {
      clearInterval(timer);
      output.write("\r\x1b[K");
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type SpinnerOptions = {
  output: Writable;
  text?: string;
};

/**
 * Start a thinking spinner. Returns a handle with `stop()`.
 *
 * Tries Ink when available; falls back to the raw-ANSI setInterval spinner
 * (identical to the original sdk-host.ts implementation).
 */
export async function startSpinner(opts: SpinnerOptions): Promise<SpinnerHandle> {
  const { output, text = "thinking" } = opts;
  const isTTY = (output as { isTTY?: boolean }).isTTY === true;
  if (!isTTY) {
    // Non-TTY: no spinner at all (matches original behavior — useColor gate).
    return { stop() {} };
  }

  try {
    const [inkMod, reactMod] = await Promise.all([
      import("ink") as Promise<{
        render: (el: React.ReactElement) => { unmount: () => void };
        Text: React.FC<TextProps>;
      }>,
      import("react") as Promise<typeof React>,
    ]);

    const element = reactMod.createElement(SpinnerComponent, { text, Text: inkMod.Text });
    const { unmount } = inkMod.render(element);

    return {
      stop() {
        unmount();
        // Clear the spinner line — same as ANSI fallback.
        output.write("\r\x1b[K");
      },
    };
  } catch {
    // ink/react not installed — raw ANSI fallback.
    return startAnsiSpinner(output, text);
  }
}
