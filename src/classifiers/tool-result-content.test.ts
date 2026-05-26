// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { toolResultContentClassifier } from "./tool-result-content.js";
import type { Request } from "../core/types.js";

function makeReq(meta?: Record<string, unknown>): Request {
  return meta !== undefined ? { prompt: "", metadata: meta } : { prompt: "" };
}

describe("toolResultContentClassifier", () => {
  it("returns trivial (conf 0.65) for empty content", () => {
    const result = toolResultContentClassifier.classify(
      makeReq({ toolResultContentLength: 0, toolResultContentSample: "" }),
    );
    expect(result).not.toBeNull();
    expect(result!.class).toBe("trivial");
    expect(result!.confidence).toBe(0.65);
  });

  it("returns null for 4999 chars (below threshold)", () => {
    const result = toolResultContentClassifier.classify(
      makeReq({ toolResultContentLength: 4999, toolResultContentSample: "x".repeat(500) }),
    );
    expect(result).toBeNull();
  });

  it("returns standard (conf 0.7) for 5000 chars", () => {
    const result = toolResultContentClassifier.classify(
      makeReq({ toolResultContentLength: 5000, toolResultContentSample: "x".repeat(500) }),
    );
    expect(result).not.toBeNull();
    expect(result!.class).toBe("standard");
    expect(result!.confidence).toBe(0.7);
  });

  it("returns hard (conf 0.75) for 20000 chars", () => {
    const result = toolResultContentClassifier.classify(
      makeReq({ toolResultContentLength: 20000, toolResultContentSample: "x".repeat(500) }),
    );
    expect(result).not.toBeNull();
    expect(result!.class).toBe("hard");
    expect(result!.confidence).toBe(0.75);
  });

  it("returns standard (conf 0.8) for error pattern in sample (below 5k chars)", () => {
    const result = toolResultContentClassifier.classify(
      makeReq({
        toolResultContentLength: 100,
        toolResultContentSample: "Error: failed: something went wrong",
      }),
    );
    expect(result).not.toBeNull();
    expect(result!.class).toBe("standard");
    expect(result!.confidence).toBe(0.8);
  });

  it("returns standard (conf 0.8) for 'Traceback' pattern", () => {
    const result = toolResultContentClassifier.classify(
      makeReq({
        toolResultContentLength: 200,
        toolResultContentSample: "Traceback (most recent call last):",
      }),
    );
    expect(result).not.toBeNull();
    expect(result!.class).toBe("standard");
    expect(result!.confidence).toBe(0.8);
  });

  it("returns null when no metadata", () => {
    const result = toolResultContentClassifier.classify(makeReq());
    expect(result).toBeNull();
  });

  it("returns null when toolResultContentLength is missing", () => {
    const result = toolResultContentClassifier.classify(
      makeReq({ toolResultContentSample: "some content" }),
    );
    expect(result).toBeNull();
  });

  it("large content (20k) takes precedence over error pattern (hard, not standard)", () => {
    const result = toolResultContentClassifier.classify(
      makeReq({
        toolResultContentLength: 25000,
        toolResultContentSample: "error: something failed",
      }),
    );
    expect(result).not.toBeNull();
    expect(result!.class).toBe("hard");
    expect(result!.confidence).toBe(0.75);
  });

  it("returns null with explicit null metadata value", () => {
    const req: Request = { prompt: "", metadata: undefined };
    const result = toolResultContentClassifier.classify(req);
    expect(result).toBeNull();
  });
});
