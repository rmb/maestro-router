// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import type { Writable } from "node:stream";

// ---------------------------------------------------------------------------
// Constants (mirrors sdk-host.ts)
// ---------------------------------------------------------------------------

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SpinnerHandle = { stop: () => void };

export type SpinnerOptions = {
  output: Writable;
  text?: string;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start a thinking spinner. Returns a handle with `stop()`.
 *
 * Uses the raw-ANSI setInterval implementation. Non-TTY outputs return
 * a no-op handle (matches original behavior).
 */
export async function startSpinner(opts: SpinnerOptions): Promise<SpinnerHandle> {
  const { output, text = "thinking" } = opts;
  const isTTY = (output as { isTTY?: boolean }).isTTY === true;
  if (!isTTY) {
    // Non-TTY: no spinner at all (matches original behavior — useColor gate).
    return { stop() {} };
  }

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
