// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { parseOutput } from "./output.js";

// Real envelope captured in planning spike 2 (see docs/router-observations.md)
const SPIKE_JSON = `{"type":"result","subtype":"success","is_error":false,"api_error_status":null,"duration_ms":3828,"duration_api_ms":3807,"num_turns":1,"result":"hi","stop_reason":"end_turn","session_id":"89274142-7508-42b0-acb4-957a8363c389","total_cost_usd":0.04850775,"usage":{"input_tokens":9,"cache_creation_input_tokens":37863,"cache_read_input_tokens":0,"output_tokens":234,"service_tier":"standard"},"modelUsage":{"claude-haiku-4-5-20251001":{"inputTokens":9,"outputTokens":234,"cacheReadInputTokens":0,"cacheCreationInputTokens":37863,"costUSD":0.04850775}}}`;

describe("parseOutput", () => {
  test("parses spike-2 envelope into cost breakdown", () => {
    const r = parseOutput(SPIKE_JSON);
    expect(r).not.toBeNull();
    expect(r!.cost.totalCostUsd).toBeCloseTo(0.04850775);
    expect(r!.cost.inputTokens).toBe(9);
    expect(r!.cost.outputTokens).toBe(234);
    expect(r!.cost.cacheCreationInputTokens).toBe(37863);
    expect(r!.cost.cacheReadInputTokens).toBe(0);
    expect(r!.cost.durationMs).toBe(3828);
    expect(r!.cost.durationApiMs).toBe(3807);
    expect(r!.cost.stopReason).toBe("end_turn");
    expect(r!.cost.serviceTier).toBe("standard");
    expect(r!.cost.modelUsed).toBe("claude-haiku-4-5-20251001");
    expect(r!.sessionId).toBe("89274142-7508-42b0-acb4-957a8363c389");
  });

  test("emits compact_recommended when cache_creation exceeds default threshold", () => {
    const r = parseOutput(SPIKE_JSON);
    expect(r!.diagnostics.map((d) => d.code)).toContain("info.compact_recommended");
  });

  test("respects custom autoCompactThresholdTokens", () => {
    const r = parseOutput(SPIKE_JSON, { autoCompactThresholdTokens: 100_000 });
    expect(r!.diagnostics.map((d) => d.code)).not.toContain("info.compact_recommended");
  });

  test("no compact diagnostic when below threshold", () => {
    const cheap = JSON.stringify({
      type: "result",
      total_cost_usd: 0.001,
      stop_reason: "end_turn",
      session_id: "abc",
      usage: { input_tokens: 5, output_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 5000 },
      modelUsage: { sonnet: { costUSD: 0.001 } },
    });
    const r = parseOutput(cheap);
    expect(r!.diagnostics.map((d) => d.code)).not.toContain("info.compact_recommended");
  });

  test("emits claude.is_error when is_error true", () => {
    const errEnvelope = JSON.stringify({
      type: "result",
      is_error: true,
      stop_reason: "max_tokens",
      usage: {},
      modelUsage: {},
    });
    const r = parseOutput(errEnvelope);
    expect(r!.diagnostics.map((d) => d.code)).toContain("claude.is_error");
  });

  test("returns null for non-result type", () => {
    const other = JSON.stringify({ type: "system", message: "info" });
    expect(parseOutput(other)).toBeNull();
  });

  test("returns null for malformed JSON", () => {
    expect(parseOutput("not json at all")).toBeNull();
  });

  test("handles missing fields with safe defaults", () => {
    const minimal = JSON.stringify({ type: "result" });
    const r = parseOutput(minimal);
    expect(r).not.toBeNull();
    expect(r!.cost.totalCostUsd).toBe(0);
    expect(r!.cost.modelUsed).toBe("unknown");
    expect(r!.cost.stopReason).toBe("unknown");
    expect(r!.cost.serviceTier).toBe("unknown");
    expect(r!.sessionId).toBeNull();
  });

  test("extracts JSON from surrounding text", () => {
    const wrapped = `Some prose before\n${SPIKE_JSON}\nMore prose after`;
    const r = parseOutput(wrapped);
    expect(r).not.toBeNull();
    expect(r!.cost.inputTokens).toBe(9);
  });

  test("picks first model from modelUsage", () => {
    const multi = JSON.stringify({
      type: "result",
      usage: {},
      modelUsage: { "claude-sonnet": {}, "claude-opus": {} },
    });
    const r = parseOutput(multi);
    expect(r!.cost.modelUsed).toBe("claude-sonnet");
  });
});
