// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { parseOutput, parseStreamJsonOutput } from "./output.js";

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

  // R8 (spike): --max-budget-usd produces this specific envelope
  const BUDGET_EXCEEDED_JSON = `{"type":"result","subtype":"error_max_budget_usd","is_error":true,"duration_ms":25818,"duration_api_ms":0,"stop_reason":"end_turn","session_id":"23c17f62","total_cost_usd":0.06260525,"usage":{"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0,"service_tier":"standard"},"modelUsage":{"claude-haiku-4-5-20251001":{"inputTokens":9,"outputTokens":2441,"cacheReadInputTokens":0,"cacheCreationInputTokens":40313,"costUSD":0.06260525}},"errors":["Reached maximum budget ($0.01)"]}`;

  test("R8: detects error_max_budget_usd subtype and emits claude.budget_exceeded", () => {
    const r = parseOutput(BUDGET_EXCEEDED_JSON);
    expect(r).not.toBeNull();
    const codes = r!.diagnostics.map((d) => d.code);
    expect(codes).toContain("claude.budget_exceeded");
    expect(codes).not.toContain("claude.is_error");
  });

  test("R8: falls back to modelUsage tokens when top-level usage zeroed", () => {
    const r = parseOutput(BUDGET_EXCEEDED_JSON);
    expect(r!.cost.inputTokens).toBe(9);
    expect(r!.cost.outputTokens).toBe(2441);
    expect(r!.cost.cacheCreationInputTokens).toBe(40313);
    expect(r!.cost.totalCostUsd).toBeCloseTo(0.06260525);
  });

  test("R8: budget_exceeded message includes realized cost", () => {
    const r = parseOutput(BUDGET_EXCEEDED_JSON);
    const msg = r!.diagnostics.find((d) => d.code === "claude.budget_exceeded")?.message;
    expect(msg).toMatch(/Reached maximum budget/);
    expect(msg).toMatch(/0\.062605/);
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

describe("parseStreamJsonOutput", () => {
  const turn1 = JSON.stringify({
    type: "result",
    subtype: "success",
    total_cost_usd: 0.05,
    duration_ms: 1000,
    duration_api_ms: 900,
    stop_reason: "end_turn",
    session_id: "abc-123",
    usage: { input_tokens: 10, output_tokens: 100, cache_creation_input_tokens: 500, cache_read_input_tokens: 0, service_tier: "standard" },
    modelUsage: { "claude-sonnet-4-6": { inputTokens: 10, outputTokens: 100, cacheCreationInputTokens: 500, cacheReadInputTokens: 0, costUSD: 0.05 } },
  });
  const turn2 = JSON.stringify({
    type: "result",
    subtype: "success",
    total_cost_usd: 0.02,
    duration_ms: 500,
    duration_api_ms: 480,
    stop_reason: "end_turn",
    session_id: "abc-123",
    usage: { input_tokens: 5, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 400, service_tier: "standard" },
    modelUsage: { "claude-sonnet-4-6": { inputTokens: 5, outputTokens: 40, cacheCreationInputTokens: 0, cacheReadInputTokens: 400, costUSD: 0.02 } },
  });
  const nonResult = JSON.stringify({ type: "assistant", message: { content: "hello" } });

  test("returns null for empty string", () => {
    expect(parseStreamJsonOutput("")).toBeNull();
  });

  test("returns null when no result lines present", () => {
    const raw = [nonResult, nonResult].join("\n");
    expect(parseStreamJsonOutput(raw)).toBeNull();
  });

  test("parses single result turn", () => {
    const raw = [nonResult, turn1, nonResult].join("\n");
    const r = parseStreamJsonOutput(raw);
    expect(r).not.toBeNull();
    expect(r!.cost.totalCostUsd).toBeCloseTo(0.05);
    expect(r!.cost.inputTokens).toBe(10);
    expect(r!.cost.outputTokens).toBe(100);
    expect(r!.cost.cacheCreationInputTokens).toBe(500);
    expect(r!.cost.cacheReadInputTokens).toBe(0);
    expect(r!.cost.durationMs).toBe(1000);
    expect(r!.cost.modelUsed).toBe("claude-sonnet-4-6");
    expect(r!.sessionId).toBe("abc-123");
  });

  test("accumulates cost and tokens across multiple turns", () => {
    const raw = [nonResult, turn1, nonResult, turn2].join("\n");
    const r = parseStreamJsonOutput(raw);
    expect(r).not.toBeNull();
    expect(r!.cost.totalCostUsd).toBeCloseTo(0.07);
    expect(r!.cost.inputTokens).toBe(15);
    expect(r!.cost.outputTokens).toBe(140);
    expect(r!.cost.cacheCreationInputTokens).toBe(500);
    expect(r!.cost.cacheReadInputTokens).toBe(400);
    expect(r!.cost.durationMs).toBe(1500);
  });

  test("skips non-JSON and non-result lines without throwing", () => {
    const raw = ["not json", turn1, "{bad json", turn2].join("\n");
    const r = parseStreamJsonOutput(raw);
    expect(r).not.toBeNull();
    expect(r!.cost.totalCostUsd).toBeCloseTo(0.07);
  });
});
