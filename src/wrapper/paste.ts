// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

const HEAD_CHARS = 350;
const TAIL_CHARS = 150;
const MIN_PROMPT_CHARS = 800;
const MIN_SAVINGS_CHARS = 200;

/**
 * Heuristic: is this prompt dominated by pasted structured data (analytics
 * dumps, log output, tables) rather than natural-language instructions?
 *
 * Triggers when:
 *   - prompt is long enough to bother (≥800 chars)
 *   - at least 10 non-empty lines exist
 *   - code-keyword density is low (≤5 matches — avoids condensing code context)
 *   - ≥65% of lines are short (<60 chars, typical of table rows / log entries)
 */
export function isPasteHeavy(prompt: string): boolean {
  if (prompt.length < MIN_PROMPT_CHARS) return false;
  const lines = prompt.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 10) return false;
  const codeKeywords = (
    prompt.match(/\b(function|class|const|let|var|def|import|export|return|=>|async|await|interface|type|struct|fn|pub)\b/g) ?? []
  ).length;
  if (codeKeywords > 5) return false;
  const shortLines = lines.filter((l) => l.trim().length < 60).length;
  return shortLines / lines.length > 0.65;
}

export type CondenseResult = {
  condensed: string;
  savedChars: number;
};

/**
 * Truncate the middle of a paste-heavy prompt, preserving head and tail.
 * Returns null when the prompt is not paste-heavy or savings are too small.
 *
 * Example: a 2000-char analytics dashboard paste becomes:
 *   [first 350 chars]
 *   [... 1445 chars of structured data truncated ...]
 *   [last 150 chars]
 */
export function condensePaste(prompt: string): CondenseResult | null {
  if (!isPasteHeavy(prompt)) return null;
  const middle = prompt.length - HEAD_CHARS - TAIL_CHARS;
  if (middle < MIN_SAVINGS_CHARS) return null;
  const head = prompt.slice(0, HEAD_CHARS);
  const tail = prompt.slice(-TAIL_CHARS);
  const marker = `\n[... ${middle} chars of structured data truncated ...]\n`;
  const condensed = head + marker + tail;
  const savedChars = prompt.length - condensed.length;
  if (savedChars < MIN_SAVINGS_CHARS) return null;
  return { condensed, savedChars };
}
