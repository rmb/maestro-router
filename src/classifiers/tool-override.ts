// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0
// budget: 1ms

import { createClassifier } from "../core/classifier.js";
import type { Class, ClassifyFn, Request } from "../core/types.js";

/**
 * Per-tool routing table. Keys are exact tool names as returned by
 * the Claude API's tool_use content blocks.
 *
 * Routing rationale:
 *   trivial  — pure reads; no generation needed; Haiku more than sufficient.
 *   simple   — structured writes / shell execs; deterministic, short output.
 *   standard — agentic / network tools; may require multi-step reasoning.
 */
const TOOL_CLASS: ReadonlyMap<string, Class> = new Map([
  ["Read", "trivial"],
  ["Glob", "trivial"],
  ["Grep", "trivial"],
  ["LS", "trivial"],
  ["Edit", "simple"],
  ["Write", "simple"],
  ["MultiEdit", "simple"],
  ["NotebookEdit", "simple"],
  ["Bash", "simple"],
  ["Task", "standard"],
  ["WebFetch", "standard"],
  ["WebSearch", "standard"],
]);

const classify: ClassifyFn = (req: Request) => {
  const toolName = req.metadata?.resolvedToolName;
  if (typeof toolName !== "string" || toolName.length === 0) return null;
  const cls = TOOL_CLASS.get(toolName);
  if (cls === undefined) return null;
  return {
    class: cls,
    confidence: 1.0,
    diagnostics: [
      { severity: "info", code: `tool_override.${toolName}`, message: toolName },
    ],
  };
};

export const toolOverrideClassifier = createClassifier({
  name: "tool-override",
  weight: 1.0,
  classify,
});
