// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

/**
 * T4 auto-resume on max_tokens tests.
 *
 * Strategy:
 * - Pure helper functions (resolveT4UpgradeModel, buildT4ResumeArgs) are unit
 *   tested directly — no mocks needed.
 * - The full registerRunCommand integration is tested via vitest module mocking
 *   of the heavy I/O boundaries (preflight, loadCliConfig, createSessionStore,
 *   pipeline, streamClaude). The injectable _streamFn parameter wires the mock
 *   stream function into the action handler.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CostBreakdown } from "../core/types.js";

// ---------------------------------------------------------------------------
// Helpers under test (no mocking required)
// ---------------------------------------------------------------------------

import {
  resolveT4UpgradeModel,
  buildT4ResumeArgs,
  _resetT4RetryState,
} from "./run-cmd.js";

describe("resolveT4UpgradeModel", () => {
  test("haiku → sonnet", () => {
    expect(resolveT4UpgradeModel("haiku")).toBe("sonnet");
  });

  test("sonnet → opus", () => {
    expect(resolveT4UpgradeModel("sonnet")).toBe("opus");
  });

  test("opus → null (already top)", () => {
    expect(resolveT4UpgradeModel("opus")).toBeNull();
  });

  test("full model name containing haiku → sonnet", () => {
    expect(resolveT4UpgradeModel("claude-haiku-4-5")).toBe("sonnet");
  });

  test("full model name containing sonnet → opus", () => {
    expect(resolveT4UpgradeModel("claude-sonnet-4-6")).toBe("opus");
  });

  test("full model name containing opus → null", () => {
    expect(resolveT4UpgradeModel("claude-opus-4-7")).toBeNull();
  });

  test("unknown model → null (safe default, no retry)", () => {
    expect(resolveT4UpgradeModel("some-unknown-model")).toBeNull();
  });
});

describe("buildT4ResumeArgs", () => {
  test("builds correct --resume args", () => {
    const args = buildT4ResumeArgs("session-abc", "sonnet");
    expect(args).toEqual([
      "--print",
      "--output-format",
      "json",
      "--resume",
      "session-abc",
      "--model",
      "sonnet",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Integration tests for registerRunCommand T4 retry logic
// ---------------------------------------------------------------------------

// We mock all I/O-heavy dependencies so no real claude subprocess is spawned.

vi.mock("../wrapper/preflight.js", () => ({
  preflight: () => ({
    ok: true,
    version: "2.1.0",
    binary: "claude",
    missingFlags: [],
    authMethod: "claude.ai",
    bareSupported: false,
  }),
}));

vi.mock("./utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./utils.js")>();
  return {
    ...actual,
    loadCliConfig: vi.fn().mockResolvedValue({
      userConfig: {},
      profileOverrides: {},
      userHeuristics: [],
    }),
    readState: vi.fn().mockResolvedValue({ autoTuneLastRunAt: new Date().toISOString() }),
  };
});

// createPipeline is a vi.fn so per-test overrides work via mockImplementation
const mockRoute = vi.fn().mockResolvedValue({
  class: "standard",
  classifier: "heuristic",
  confidence: 0.9,
  spec: {
    model: "haiku",
    effort: "low",
    maxBudgetUsd: 0.05,
    excludeDynamicSections: true,
  },
  latencyMs: 5,
  diagnostics: [],
});

vi.mock("../core/pipeline.js", () => ({
  createPipeline: () => ({ route: mockRoute }),
}));

vi.mock("../wrapper/session.js", () => ({
  createSessionStore: () => ({
    list: vi.fn().mockResolvedValue([]),
    getOrCreate: vi.fn().mockResolvedValue({ sessionId: "test-session-id", isNew: true }),
    getByFingerprint: vi.fn().mockResolvedValue({ sessionId: "test-session-id", isNew: true }),
    appendClass: vi.fn().mockResolvedValue(undefined),
    appendTurnType: vi.fn().mockResolvedValue(undefined),
    updateLastDecision: vi.fn().mockResolvedValue(undefined),
    getTurnCount: vi.fn().mockResolvedValue(1),
    getEffortEscalated: vi.fn().mockResolvedValue(false),
    updateStopReason: vi.fn().mockResolvedValue(undefined),
    setEffortEscalated: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("../wrapper/prewarm.js", () => ({
  computeFingerprint: vi.fn().mockReturnValue("test-fingerprint"),
  prewarmFingerprints: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../wrapper/continuation.js", () => ({
  detectContinuation: vi.fn().mockReturnValue(null),
}));

// telemetryLog is a vi.fn so per-test overrides work
const telemetryLog = vi.fn().mockResolvedValue(undefined);

vi.mock("../core/telemetry.js", () => ({
  createTelemetry: () => ({ log: telemetryLog }),
}));

vi.mock("../core/posthog.js", () => ({
  createPostHogClient: () => ({
    capture: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("../core/classifier-cache.js", () => ({
  classifierCache: {
    promptHash: vi.fn().mockReturnValue("test-hash"),
    get: vi.fn().mockReturnValue(null),
    set: vi.fn(),
    invalidate: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface CostJsonOptions {
  cost?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  durationMs?: number;
  durationApiMs?: number;
}

function makeCostJson(stopReason: string, model: string, options: number | CostJsonOptions = 0.001): string {
  const opts: CostJsonOptions = typeof options === "number" ? { cost: options } : options;
  const cost = opts.cost ?? 0.001;
  const inputTokens = opts.inputTokens ?? 100;
  const outputTokens = opts.outputTokens ?? 200;
  const cacheCreationInputTokens = opts.cacheCreationInputTokens ?? 0;
  const cacheReadInputTokens = opts.cacheReadInputTokens ?? 0;
  const durationMs = opts.durationMs ?? 1000;
  const durationApiMs = opts.durationApiMs ?? 800;

  const costBreakdown = {
    type: "result",
    total_cost_usd: cost,
    duration_ms: durationMs,
    duration_api_ms: durationApiMs,
    stop_reason: stopReason,
    session_id: "test-session-id",
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_creation_input_tokens: cacheCreationInputTokens,
      cache_read_input_tokens: cacheReadInputTokens,
    },
    modelUsage: {
      [model]: {
        inputTokens,
        outputTokens,
        cacheReadInputTokens,
        cacheCreationInputTokens,
        costUSD: cost,
      },
    },
  };
  return JSON.stringify(costBreakdown);
}

/** Build a mock StreamFn that returns a given capturedStdout. */
function makeStreamFn(responses: Array<{ capturedStdout: string; exitCode?: number }>) {
  let callIndex = 0;
  return vi.fn().mockImplementation(async () => {
    const resp = responses[callIndex] ?? responses[responses.length - 1]!;
    callIndex++;
    return { capturedStdout: resp.capturedStdout, exitCode: resp.exitCode ?? 0 };
  });
}

/** Run the 'run' subcommand with a given prompt + injectable streamFn. */
async function runCmd(
  prompt: string,
  streamFn: ReturnType<typeof makeStreamFn>,
  extra: { userConfig?: Record<string, unknown> } = {},
): Promise<{ stderrOutput: string }> {
  const { loadCliConfig } = await import("./utils.js");
  vi.mocked(loadCliConfig).mockResolvedValue({
    userConfig: extra.userConfig ?? {},
    profileOverrides: {},
    userHeuristics: [],
  } as Parameters<typeof loadCliConfig>[0] extends never ? never : Awaited<ReturnType<typeof loadCliConfig>>);

  const { Command } = await import("commander");
  const { registerRunCommand } = await import("./run-cmd.js");

  const program = new Command();
  program
    .name("maestro")
    .option("-q, --quiet", "suppress informational output")
    .option("--json", "JSON output")
    .option("--config <path>", "config override")
    .exitOverride();

  // Pass the injectable stream function
  registerRunCommand(program, streamFn as Parameters<typeof registerRunCommand>[1]);

  const stderrChunks: string[] = [];
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderrChunks.push(String(chunk));
    return true;
  });
  // Suppress stdout writes (Claude output)
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

  try {
    await program.parseAsync(["node", "maestro", "run", prompt], { from: "node" });
  } catch {
    // exitOverride throws on process.exit — expected in some paths
  } finally {
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
  }

  return { stderrOutput: stderrChunks.join("") };
}

// ---------------------------------------------------------------------------
// T4 integration tests
// ---------------------------------------------------------------------------

describe("T4 auto-resume on max_tokens", () => {
  beforeEach(() => {
    _resetT4RetryState();
    vi.clearAllMocks();
    // Restore default pipeline mock (haiku, standard)
    mockRoute.mockResolvedValue({
      class: "standard",
      classifier: "heuristic",
      confidence: 0.9,
      spec: { model: "haiku", effort: "low", maxBudgetUsd: 0.05, excludeDynamicSections: true },
      latencyMs: 5,
      diagnostics: [],
    });
    telemetryLog.mockResolvedValue(undefined);
  });

  afterEach(() => {
    _resetT4RetryState();
    process.exitCode = undefined;
  });

  test("1. end_turn completion → no retry, streamFn called once", async () => {
    const streamFn = makeStreamFn([
      { capturedStdout: makeCostJson("end_turn", "claude-haiku-4-5") },
    ]);

    await runCmd("hello world", streamFn);

    expect(streamFn).toHaveBeenCalledTimes(1);
  });

  test("2. max_tokens on haiku → retry on sonnet fires (streamFn called twice)", async () => {
    const streamFn = makeStreamFn([
      { capturedStdout: makeCostJson("max_tokens", "claude-haiku-4-5", 0.001) },
      { capturedStdout: makeCostJson("end_turn", "claude-sonnet-4-6", 0.003) },
    ]);

    const { stderrOutput } = await runCmd("complex question", streamFn);

    expect(streamFn).toHaveBeenCalledTimes(2);
    // Second call should have --resume and --model sonnet
    const secondCall = streamFn.mock.calls[1]![0] as { args: string[] };
    expect(secondCall.args).toContain("--resume");
    expect(secondCall.args).toContain("sonnet");
    expect(stderrOutput).toMatch(/max_tokens detected on haiku.*auto-retrying on sonnet/i);
  });

  test("3. max_tokens on sonnet → retry on opus fires", async () => {
    // Override the pipeline to return sonnet for this test
    mockRoute.mockResolvedValue({
      class: "hard",
      classifier: "heuristic",
      confidence: 0.9,
      spec: { model: "sonnet", effort: "medium", maxBudgetUsd: 0.10, excludeDynamicSections: true },
      latencyMs: 5,
      diagnostics: [],
    });

    const streamFn = makeStreamFn([
      { capturedStdout: makeCostJson("max_tokens", "claude-sonnet-4-6", 0.003) },
      { capturedStdout: makeCostJson("end_turn", "claude-opus-4-7", 0.015) },
    ]);

    const { stderrOutput } = await runCmd("very hard question", streamFn);

    expect(streamFn).toHaveBeenCalledTimes(2);
    const secondCall = streamFn.mock.calls[1]![0] as { args: string[] };
    expect(secondCall.args).toContain("--resume");
    expect(secondCall.args).toContain("opus");
    expect(stderrOutput).toMatch(/max_tokens detected on sonnet.*auto-retrying on opus/i);
  });

  test("4. max_tokens on opus → no retry, diagnostic on stderr", async () => {
    mockRoute.mockResolvedValue({
      class: "max",
      classifier: "heuristic",
      confidence: 0.9,
      spec: { model: "opus", effort: "high", maxBudgetUsd: 0.5, excludeDynamicSections: true },
      latencyMs: 5,
      diagnostics: [],
    });

    const streamFn = makeStreamFn([
      { capturedStdout: makeCostJson("max_tokens", "claude-opus-4-7", 0.05) },
    ]);

    // disableFirstTurnGuard=true so opus reaches spawn unmodified (guard disabled).
    // This tests T4's own no-retry-at-top-model behaviour in isolation.
    const { stderrOutput } = await runCmd("max question", streamFn, {
      userConfig: { disableFirstTurnGuard: true },
    });

    expect(streamFn).toHaveBeenCalledTimes(1);
    expect(stderrOutput).toMatch(/already top model/);
  });

  test("5. autoResumeOnMaxTokens: false → no retry even on max_tokens", async () => {
    const streamFn = makeStreamFn([
      { capturedStdout: makeCostJson("max_tokens", "claude-haiku-4-5", 0.001) },
    ]);

    await runCmd("some prompt", streamFn, { userConfig: { autoResumeOnMaxTokens: false } });

    expect(streamFn).toHaveBeenCalledTimes(1);
  });

  test("6. summed cost (original + retry) appears in telemetry", async () => {
    // Use distinguishable values so any field that stops summing fails the test.
    const streamFn = makeStreamFn([
      {
        capturedStdout: makeCostJson("max_tokens", "claude-haiku-4-5", {
          cost: 0.001,
          inputTokens: 100,
          outputTokens: 50,
          cacheCreationInputTokens: 20,
          cacheReadInputTokens: 10,
          durationMs: 1200,
          durationApiMs: 900,
        }),
      },
      {
        capturedStdout: makeCostJson("end_turn", "claude-sonnet-4-6", {
          cost: 0.003,
          inputTokens: 150,
          outputTokens: 75,
          cacheCreationInputTokens: 30,
          cacheReadInputTokens: 15,
          durationMs: 1800,
          durationApiMs: 1300,
        }),
      },
    ]);

    await runCmd("complex question 2", streamFn);

    // Find the decision event logged via telemetryLog
    const decisionCall = telemetryLog.mock.calls.find(
      (c) => (c[0] as { type: string }).type === "decision",
    );
    expect(decisionCall).toBeDefined();
    const decisionEvent = decisionCall![0] as { cost?: CostBreakdown; decision?: { diagnostics?: Array<{ code: string }> } };
    const cost = decisionEvent.cost!;

    // All fields must be sums of original + retry
    expect(cost.totalCostUsd).toBeCloseTo(0.001 + 0.003, 5);
    expect(cost.inputTokens).toBe(100 + 150);
    expect(cost.outputTokens).toBe(50 + 75);
    expect(cost.cacheCreationInputTokens).toBe(20 + 30);
    expect(cost.cacheReadInputTokens).toBe(10 + 15);
    expect(cost.durationMs).toBe(1200 + 1800);
    expect(cost.durationApiMs).toBe(900 + 1300);

    // Exactly ONE t4.auto_resume diagnostic on the decision event
    const diagnostics = decisionEvent.decision?.diagnostics ?? [];
    const t4Diags = diagnostics.filter((d) => d.code === "t4.auto_resume");
    expect(t4Diags).toHaveLength(1);
  });

  test("7. stopReason in final cost reflects retry's stop reason (end_turn, not max_tokens)", async () => {
    const streamFn = makeStreamFn([
      { capturedStdout: makeCostJson("max_tokens", "claude-haiku-4-5", 0.001) },
      { capturedStdout: makeCostJson("end_turn", "claude-sonnet-4-6", 0.003) },
    ]);

    await runCmd("complex question 3", streamFn);

    const decisionCall = telemetryLog.mock.calls.find(
      (c) => (c[0] as { type: string }).type === "decision",
    );
    expect(decisionCall).toBeDefined();
    const decisionEvent = decisionCall![0] as { cost?: CostBreakdown };
    expect(decisionEvent.cost?.stopReason).toBe("end_turn");
  });

  test("8. cycle-breaker: same prompt retrying twice in one execution is blocked", async () => {
    // First run fires the retry (2 calls total)
    const streamFn1 = makeStreamFn([
      { capturedStdout: makeCostJson("max_tokens", "claude-haiku-4-5", 0.001) },
      { capturedStdout: makeCostJson("end_turn", "claude-sonnet-4-6", 0.003) },
    ]);
    await runCmd("cycle test prompt", streamFn1);
    expect(streamFn1).toHaveBeenCalledTimes(2);

    // Second run with the same prompt: cycle-breaker blocks the retry (1 call)
    const streamFn2 = makeStreamFn([
      { capturedStdout: makeCostJson("max_tokens", "claude-haiku-4-5", 0.001) },
    ]);
    const { stderrOutput } = await runCmd("cycle test prompt", streamFn2);

    expect(streamFn2).toHaveBeenCalledTimes(1);
    expect(stderrOutput).toMatch(/already retried/i);
  });
});

// ---------------------------------------------------------------------------
// Stripped-prompt tests — verifies the @deep/@fast prefix is removed before
// classification and before the prompt is forwarded to claude.
// ---------------------------------------------------------------------------

describe("override prefix stripping", () => {
  beforeEach(() => {
    _resetT4RetryState();
    vi.clearAllMocks();
    mockRoute.mockResolvedValue({
      class: "hard",
      classifier: "override",
      confidence: 1.0,
      spec: { model: "opus", effort: "max", maxBudgetUsd: 1.0, excludeDynamicSections: true },
      latencyMs: 0,
      diagnostics: [{ severity: "info" as const, code: "override.matched", message: "@deep" }],
    });
    telemetryLog.mockResolvedValue(undefined);
  });

  afterEach(() => {
    _resetT4RetryState();
    process.exitCode = undefined;
  });

  test("pipeline.route receives stripped prompt — no @deep prefix in route call", async () => {
    const streamFn = makeStreamFn([
      { capturedStdout: makeCostJson("end_turn", "claude-opus-4-7") },
    ]);

    await runCmd("@deep explain this algorithm", streamFn);

    const routeArg = mockRoute.mock.calls[0]?.[0] as { prompt?: string } | undefined;
    expect(routeArg?.prompt).toBe("explain this algorithm");
    expect(routeArg?.prompt).not.toContain("@deep");
  });

  test("prompt forwarded to claude (doStream) is stripped — no @fast prefix", async () => {
    mockRoute.mockResolvedValue({
      class: "trivial",
      classifier: "override",
      confidence: 1.0,
      spec: { model: "haiku", effort: "low", maxBudgetUsd: 0.05, excludeDynamicSections: true },
      latencyMs: 0,
      diagnostics: [{ severity: "info" as const, code: "override.matched", message: "@fast" }],
    });
    const streamFn = makeStreamFn([
      { capturedStdout: makeCostJson("end_turn", "claude-haiku-4-5") },
    ]);

    await runCmd("@fast format this file", streamFn);

    const firstCallPrompt = (streamFn.mock.calls[0]?.[0] as { prompt?: string })?.prompt;
    expect(firstCallPrompt).toBeDefined();
    expect(firstCallPrompt).not.toContain("@fast");
    expect(firstCallPrompt).toBe("format this file");
  });
});
