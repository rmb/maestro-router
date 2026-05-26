// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0
// budget: 1ms p95
//
// P7: collapse Claude Code-specific tool_result envelope boilerplate.
// Orthogonal to RTK's line-number/diff/whitespace stripping — these patterns
// are CC-internal acknowledgement strings that RTK (a generic stripper)
// wouldn't touch.
//
// Empirical basis: 2,586 real tool_result blocks from real telemetry.
// Combined savings ≈ 5% of tool-result bytes on top of I1+RTK.

/** C1: full-block replacement for Write/Edit ack-only responses. */
const FILE_ACK_RE =
  /^The file (\S+) has been (updated|created) successfully\. \(file state is current in your context — no need to Read it back\)\.?\s*$/;

/** C3: full-block replacement for TodoWrite ack. */
const TODO_ACK_RE = /^Todos have been modified successfully\..*$/s;

/** C2: trailing footer on Read/Edit results that have an actual body. */
const FILE_STATE_FOOTER_RE =
  /\s*\(file state is current in your context — no need to Read it back\)\.?\s*$/;

/** C6: noise lines from interrupted tool spawns. */
const STREAM_CLOSED_RE = /^Tool permission request failed: Error: Stream closed\s*$/gm;

/**
 * Compress Claude Code-specific tool_result envelope.
 * Pure function, idempotent — safe to call twice (regex won't re-match).
 *
 * Order matters:
 *   1. Try full-block replacements (C1, C3) first — they short-circuit.
 *   2. Otherwise apply line-/footer-level scrubs (C2, C6).
 */
export function compressToolEnvelope(text: string): string {
  const trimmed = text.trim();

  // C1: file ack collapse → "ok u /abs/path" or "ok c /abs/path"
  const ackMatch = trimmed.match(FILE_ACK_RE);
  if (ackMatch) {
    const verb = ackMatch[2]!.startsWith("u") ? "u" : "c";
    return `ok ${verb} ${ackMatch[1]}`;
  }

  // C3: todo ack collapse
  if (TODO_ACK_RE.test(trimmed)) {
    return "ok todo";
  }

  // C2 + C6: line-level scrubs on bodies that DO have content
  let out = text.replace(FILE_STATE_FOOTER_RE, "");
  out = out.replace(STREAM_CLOSED_RE, "");
  // Collapse any double-newlines created by C6 line removal
  out = out.replace(/\n{3,}/g, "\n\n");
  return out;
}
