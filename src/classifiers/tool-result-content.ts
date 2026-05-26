// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0
// budget: 1ms

import { createClassifier } from "../core/classifier.js";
import type { ClassifyFn, Request } from "../core/types.js";

const ERROR_PATTERN = /error:|failed:|exception:|traceback|diff conflict|merge conflict/i;

const classify: ClassifyFn = (req: Request) => {
  const meta = req.metadata;
  if (meta === undefined || meta === null) return null;

  const contentLength = meta["toolResultContentLength"];
  const contentSample = meta["toolResultContentSample"];

  if (typeof contentLength !== "number") return null;

  // Empty result
  if (contentLength === 0) {
    return {
      class: "trivial",
      confidence: 0.65,
      diagnostics: [
        { severity: "info", code: "tool_result_content.empty", message: "empty tool result" },
      ],
    };
  }

  // Very large content — hard synthesis
  if (contentLength >= 20_000) {
    return {
      class: "hard",
      confidence: 0.75,
      diagnostics: [
        {
          severity: "info",
          code: "tool_result_content.large",
          message: `tool result ${contentLength} chars`,
        },
      ],
    };
  }

  // Error/conflict patterns in sample — bump to standard
  if (typeof contentSample === "string" && ERROR_PATTERN.test(contentSample)) {
    return {
      class: "standard",
      confidence: 0.8,
      diagnostics: [
        {
          severity: "info",
          code: "tool_result_content.error_pattern",
          message: "error/conflict pattern in tool result",
        },
      ],
    };
  }

  // Large content — standard
  if (contentLength >= 5_000) {
    return {
      class: "standard",
      confidence: 0.7,
      diagnostics: [
        {
          severity: "info",
          code: "tool_result_content.medium",
          message: `tool result ${contentLength} chars`,
        },
      ],
    };
  }

  // Below threshold — no signal
  return null;
};

export const toolResultContentClassifier = createClassifier({
  name: "tool-result-content",
  weight: 0.8,
  classify,
});
