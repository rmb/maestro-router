// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0
//
// Line-number stripping for tool results. Removes POSIX line-number prefixes
// (e.g., "1\tfunction foo() {" → "function foo() {") to reduce token inflation
// from location metadata that doesn't help routing decisions.
//
// Budget: <1ms (regex only)

/** Regex matching ^\d+\t at line start (digit + tab). Does NOT match space-padded format (e.g., "     1\t"). */
const LINE_NUMBER_REGEX = /^\d+\t/gm;

/**
 * Strip POSIX line-number prefixes from text.
 * Example: "1\timport foo;\n2\tconst x = 1;" → "import foo;\nconst x = 1;"
 *
 * Idempotent: running twice gives same result as once.
 * Preserves all other whitespace and content.
 *
 * @param text - text to strip, possibly with line numbers
 * @returns text with line-number prefixes removed
 */
export function stripLineNumbers(text: string): string {
  return text.replace(LINE_NUMBER_REGEX, "");
}
