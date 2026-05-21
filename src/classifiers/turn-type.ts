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

const ERROR_INDICATORS: ReadonlyArray<RegExp> = [
  /(?:^|\W)(error|exception|failed|fail|failure|traceback|stack ?trace)(?:\W|$)/i,
  /(?:^|\W)(typeerror|referenceerror|syntaxerror|runtimeerror|valueerror|keyerror)(?:\W|$)/i,
  /(?:^|\W)(econnrefused|enotfound|etimedout|enoent|eacces)(?:\W|$)/i,
  /\b(doesn['’]?t work|won['’]?t work|broken|broke|not working)\b/i,
  /\b(test (?:failed|failing)|build failed|assertion(?:error)?:)/i,
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
