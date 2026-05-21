// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

/**
 * Known Claude Code slash commands. These are interactive-session commands that
 * Maestro should NOT attempt to classify or route — they're meant for the
 * underlying Claude CLI to interpret. The list is documented and exported so
 * callers (and contributors) can audit additions.
 *
 * Source: `claude --help` plus inspection of the interactive Claude Code REPL.
 * Custom skills (anything matching `/<word>` not on this list) are also treated
 * as passthrough by `isSlashPrefix`.
 */
export const KNOWN_SLASH_COMMANDS: ReadonlyArray<string> = [
  "/model",
  "/effort",
  "/help",
  "/clear",
  "/cost",
  "/compact",
  "/exit",
  "/quit",
  "/agents",
  "/plugins",
  "/mcp",
  "/login",
  "/logout",
  "/resume",
  "/continue",
  "/think",
  "/bug",
  "/feedback",
  "/release-notes",
];

/** Strict: is the first token of the prompt one of the documented slash commands? */
export function isKnownSlashCommand(prompt: string): boolean {
  const head = firstToken(prompt);
  return head !== null && KNOWN_SLASH_COMMANDS.includes(head);
}

/**
 * Loose: does the prompt start with `/<word>`? Used by the wrapper to decide
 * "skip classification, forward unmodified". Catches custom skills like
 * `/skill-name` that aren't in the known list but still belong to Claude.
 */
export function isSlashPrefix(prompt: string): boolean {
  const head = firstToken(prompt);
  if (head === null) return false;
  // Must be a slash followed by a non-empty token (rejects "/" alone)
  return head.length > 1 && /^\/[a-zA-Z][\w-]*$/.test(head);
}

function firstToken(prompt: string): string | null {
  if (typeof prompt !== "string") return null;
  const trimmed = prompt.trimStart();
  if (trimmed.length === 0) return null;
  const match = trimmed.match(/^(\S+)/);
  return match?.[1] ?? null;
}
