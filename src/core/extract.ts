// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

/**
 * Extract a JSON object or array from text. Order of attempts (G2):
 *   1. Fenced code block (```json ... ``` or ``` ... ```)
 *   2. Brace-balanced object (string-aware so `{` inside strings doesn't confuse)
 *   3. Bracket-balanced array
 *   4. Direct parse of the whole input
 *
 * Returns null on failure — never throws.
 */
export function extractJSON<T = unknown>(text: string): T | null {
  if (typeof text !== "string" || text.length === 0) return null;

  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenced?.[1]) {
    const parsed = tryParse<T>(fenced[1]);
    if (parsed !== null) return parsed;
  }

  const obj = extractBalanced(text, "{", "}");
  if (obj !== null) {
    const parsed = tryParse<T>(obj);
    if (parsed !== null) return parsed;
  }

  const arr = extractBalanced(text, "[", "]");
  if (arr !== null) {
    const parsed = tryParse<T>(arr);
    if (parsed !== null) return parsed;
  }

  return tryParse<T>(text);
}

function tryParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw.trim()) as T;
  } catch {
    return null;
  }
}

function extractBalanced(text: string, open: string, close: string): string | null {
  const start = text.indexOf(open);
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
