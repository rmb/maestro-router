// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0
// budget: 5ms

import { createClassifier } from "../core/classifier.js";
import type {
  Class,
  Classification,
  ClassifyFn,
  Diagnostic,
  Message,
  Request,
} from "../core/types.js";

// Tightened: bare "error" / "failure" appears in plenty of benign prompts
// ("update the error message", "add error handling", "cascading failure"
// when used as a max-class signal). Match only when the surrounding text
// implies an actual incident: a colon/code-error after the word, a stack
// trace marker, or paired with "got"/"raises"/"throws"/"thrown".
const ERROR_INDICATORS: ReadonlyArray<RegExp> = [
  /\b(?:got|raised?|raises?|throws?|thrown|hit|hitting|getting)\s+(?:an?\s+)?(error|exception|traceback|stack ?trace)\b/i,
  /\b(error|exception|stacktrace):\s/i,
  // Stack-trace / traceback context — strong incident signal even without
  // a verb. Bare "error" is too noisy (matches "error message", "error
  // handling"), so it's intentionally NOT in this set.
  /\b(stack ?trace|traceback)\b/i,
  /\b(typeerror|referenceerror|syntaxerror|runtimeerror|valueerror|keyerror|nullpointerexception)\b/i,
  /\b(econnrefused|enotfound|etimedout|enoent|eacces)\b/i,
  /\b(doesn['’]?t work|won['’]?t work|broken|broke|not working)\b/i,
  /\b(test (?:failed|failing)|build failed|assertion(?:error)?:|panic:|fatal:)/i,
];

const STRUCTURED_OUTPUT_TOOLS = new Set(["Read", "Grep", "LS", "Glob"]);

export type DetectedTurnType =
  | "user_prompt"
  | "tool_result"
  | "error_recovery"
  | "continuation";

/** Public for tests and the heuristic classifier; otherwise prefer the classifier. */
export function detectTurnType(req: Request): DetectedTurnType {
  const msgs = req.messages;
  if (!msgs || msgs.length === 0) {
    return hasError(req.prompt) ? "error_recovery" : "user_prompt";
  }
  const last = msgs[msgs.length - 1]!;
  if (last.role === "tool") return "tool_result";
  if (last.role === "assistant") return "continuation";
  const text = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
  return hasError(text) ? "error_recovery" : "user_prompt";
}

function hasError(text: string): boolean {
  return ERROR_INDICATORS.some((re) => re.test(text));
}

function priorToolName(msgs: ReadonlyArray<Message>): string | null {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.role !== "assistant") continue;
    if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (
          typeof block === "object" &&
          block !== null &&
          "type" in block &&
          (block as { type: unknown }).type === "tool_use" &&
          "name" in block &&
          typeof (block as { name: unknown }).name === "string"
        ) {
          return (block as { name: string }).name;
        }
      }
    }
    break;
  }
  return null;
}

const classify: ClassifyFn = (req: Request) => {
  const type = detectTurnType(req);
  const diagnostics: Diagnostic[] = [
    { severity: "info", code: `turn_type.${type}`, message: type },
  ];

  if (type === "user_prompt" || type === "continuation") return null;

  if (type === "tool_result") {
    let cls: Class = "simple";
    if (req.messages) {
      const toolName = priorToolName(req.messages);
      if (toolName && STRUCTURED_OUTPUT_TOOLS.has(toolName)) cls = "trivial";
    }
    return { class: cls, confidence: 0.85, diagnostics } satisfies Classification;
  }

  if (type === "error_recovery") {
    return { class: "hard", confidence: 0.7, diagnostics } satisfies Classification;
  }

  return null;
};

export const turnTypeClassifier = createClassifier({
  name: "turn-type",
  weight: 0.85,
  classify,
});
