// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0
//
// Tiny ANSI styling helpers for CLI output. No deps. Detects whether stdout
// is a TTY and silently falls back to plain text when piped or NO_COLOR is set.

const isTTY: boolean =
  typeof process !== "undefined" &&
  process.stdout !== undefined &&
  process.stdout.isTTY === true &&
  process.env.NO_COLOR === undefined;

const wrap =
  (open: string, close: string) =>
  (s: string | number): string =>
    isTTY ? `\x1b[${open}m${s}\x1b[${close}m` : String(s);

export const bold = wrap("1", "22");
export const dim = wrap("2", "22");
export const underline = wrap("4", "24");
export const red = wrap("31", "39");
export const green = wrap("32", "39");
export const yellow = wrap("33", "39");
export const blue = wrap("34", "39");
export const magenta = wrap("35", "39");
export const cyan = wrap("36", "39");
export const gray = wrap("90", "39");

/**
 * Inline horizontal-bar visualization. Filled portion = filledChar, rest = emptyChar.
 * `pct` is clamped to [0, 1]. Default width = 20 columns.
 */
export function bar(pct: number, width = 20, filledChar = "█", emptyChar = "·"): string {
  const p = Math.max(0, Math.min(1, pct));
  const filled = Math.round(p * width);
  return filledChar.repeat(filled) + emptyChar.repeat(width - filled);
}

/** Section header with a horizontal rule and bold title. */
export function header(title: string): string {
  return `${bold(title)}\n${dim("─".repeat(Math.max(title.length, 8)))}`;
}

/** Aligned two-column row: `label  ........  value` */
export function row(label: string, value: string, labelWidth = 24): string {
  const padded = label.padEnd(labelWidth);
  return `  ${padded}  ${value}`;
}

/** Pick a color for an accuracy-like percentage. */
export function accuracyColor(pct: number): (s: string | number) => string {
  if (pct >= 0.9) return green;
  if (pct >= 0.7) return cyan;
  if (pct >= 0.5) return yellow;
  return red;
}

/** Pick a color for a savings percentage. */
export function savingsColor(pct: number): (s: string | number) => string {
  if (pct >= 0.6) return green;
  if (pct >= 0.3) return cyan;
  if (pct >= 0.0) return yellow;
  return red;
}

/** Format a USD amount. */
export function usd(value: number): string {
  if (value >= 100) return `$${value.toFixed(2)}`;
  if (value >= 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(4)}`;
}

/** Format a percentage. */
export function pct(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}
