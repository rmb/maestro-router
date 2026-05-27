// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createLangfuseClient, __resetLangfuseCachesForTest } from "./langfuse.js";
import type { TelemetryEvent } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDecisionEvent(): TelemetryEvent {
  return {
    type: "decision",
    ts: "2026-05-27T10:00:00.000Z",
    decision: {
      class: "standard",
      classifier: "heuristic",
      confidence: 0.8,
      spec: { model: "sonnet", effort: "medium", maxBudgetUsd: 0.5 },
      latencyMs: 12,
      diagnostics: [],
    },
    prompt: "write me a test",
    sessionId: "sess-abc",
    turnIndex: 1,
    isNewSession: false,
  };
}

function makeOutcomeEvent(): TelemetryEvent {
  return {
    type: "outcome",
    ts: "2026-05-27T10:00:01.000Z",
    sessionId: "sess-abc",
    decidedClass: "standard",
    stopReason: "end_turn",
    outputTokens: 200,
    cacheCreationTokens: 5000,
    totalCostUsd: 0.001,
    durationApiMs: 3000,
  };
}

function makeCorrectionEvent(): TelemetryEvent {
  return {
    type: "correction",
    ts: "2026-05-27T10:00:02.000Z",
    sessionId: "sess-abc",
    prevClass: "simple",
    correctedToClass: "hard",
    hint: "deep",
    prevPrompt: "rewrite this function",
  };
}

function makeFeedbackEvent(): TelemetryEvent {
  return {
    type: "feedback",
    ts: "2026-05-27T10:00:03.000Z",
    sessionId: "sess-abc",
    rating: 4,
    source: "manual",
  };
}

// ---------------------------------------------------------------------------
// Fake Langfuse constructor factory
// ---------------------------------------------------------------------------

type FakeTrace = {
  name: string;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
};

type FakeMod = {
  Ctor: new (opts: object) => { trace(args: FakeTrace): void };
  traceCallArgs: FakeTrace[];
  constructorCallArgs: object[];
};

function makeFakeLangfuse(): FakeMod {
  const traceCallArgs: FakeTrace[] = [];
  const constructorCallArgs: object[] = [];

  class FakeLangfuse {
    constructor(opts: object) {
      constructorCallArgs.push(opts);
    }
    trace(args: FakeTrace): void {
      traceCallArgs.push(args);
    }
  }

  return { Ctor: FakeLangfuse, traceCallArgs, constructorCallArgs };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  __resetLangfuseCachesForTest();
});

afterEach(() => {
  __resetLangfuseCachesForTest();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests — with injected fake constructor
// ---------------------------------------------------------------------------

describe("createLangfuseClient — peer installed (injected fake)", () => {
  test("creates a Langfuse instance with the supplied keys", async () => {
    const { Ctor, constructorCallArgs } = makeFakeLangfuse();

    const client = createLangfuseClient({
      publicKey: "pk-lf-test",
      secretKey: "sk-lf-test",
      _ctor: Ctor,
    });

    client.flush(makeDecisionEvent());
    await new Promise((r) => setTimeout(r, 10));

    expect(constructorCallArgs).toHaveLength(1);
    const ctorArgs = constructorCallArgs[0] as Record<string, unknown>;
    expect(ctorArgs.publicKey).toBe("pk-lf-test");
    expect(ctorArgs.secretKey).toBe("sk-lf-test");
    expect(ctorArgs.baseUrl).toBeUndefined();
  });

  test("passes host as baseUrl when provided", async () => {
    const { Ctor, constructorCallArgs } = makeFakeLangfuse();

    const client = createLangfuseClient({
      publicKey: "pk-lf-test",
      secretKey: "sk-lf-test",
      host: "https://my.langfuse.example.com",
      _ctor: Ctor,
    });

    client.flush(makeDecisionEvent());
    await new Promise((r) => setTimeout(r, 10));

    const ctorArgs = constructorCallArgs[0] as Record<string, unknown>;
    expect(ctorArgs.baseUrl).toBe("https://my.langfuse.example.com");
  });

  test("calls trace with maestro-decision for decision events", async () => {
    const { Ctor, traceCallArgs } = makeFakeLangfuse();

    const client = createLangfuseClient({ publicKey: "pk", secretKey: "sk", _ctor: Ctor });
    client.flush(makeDecisionEvent());
    await new Promise((r) => setTimeout(r, 10));

    expect(traceCallArgs).toHaveLength(1);
    const t = traceCallArgs[0]!;
    expect(t.name).toBe("maestro-decision");
    expect(t.input).toBe("write me a test");
    expect((t.metadata as Record<string, unknown>)["class"]).toBe("standard");
    expect((t.metadata as Record<string, unknown>)["classifier"]).toBe("heuristic");
    expect((t.metadata as Record<string, unknown>)["model"]).toBe("sonnet");
    expect((t.metadata as Record<string, unknown>)["sessionId"]).toBe("sess-abc");
  });

  test("calls trace with maestro-outcome for outcome events", async () => {
    const { Ctor, traceCallArgs } = makeFakeLangfuse();

    const client = createLangfuseClient({ publicKey: "pk", secretKey: "sk", _ctor: Ctor });
    client.flush(makeOutcomeEvent());
    await new Promise((r) => setTimeout(r, 10));

    expect(traceCallArgs).toHaveLength(1);
    const t = traceCallArgs[0]!;
    expect(t.name).toBe("maestro-outcome");
    expect((t.output as Record<string, unknown>)["stopReason"]).toBe("end_turn");
    expect((t.output as Record<string, unknown>)["outputTokens"]).toBe(200);
    expect((t.metadata as Record<string, unknown>)["sessionId"]).toBe("sess-abc");
  });

  test("calls trace with maestro-correction for correction events", async () => {
    const { Ctor, traceCallArgs } = makeFakeLangfuse();

    const client = createLangfuseClient({ publicKey: "pk", secretKey: "sk", _ctor: Ctor });
    client.flush(makeCorrectionEvent());
    await new Promise((r) => setTimeout(r, 10));

    expect(traceCallArgs).toHaveLength(1);
    const t = traceCallArgs[0]!;
    expect(t.name).toBe("maestro-correction");
    expect((t.metadata as Record<string, unknown>)["prevClass"]).toBe("simple");
    expect((t.metadata as Record<string, unknown>)["correctedToClass"]).toBe("hard");
    expect((t.metadata as Record<string, unknown>)["hint"]).toBe("deep");
  });

  test("does not call trace for feedback events", async () => {
    const { Ctor, traceCallArgs } = makeFakeLangfuse();

    const client = createLangfuseClient({ publicKey: "pk", secretKey: "sk", _ctor: Ctor });
    client.flush(makeFeedbackEvent());
    await new Promise((r) => setTimeout(r, 10));

    expect(traceCallArgs).toHaveLength(0);
  });

  test("flush never throws when trace throws", async () => {
    class ThrowingLangfuse {
      constructor(_opts: object) {}
      trace(_args: FakeTrace): void {
        throw new Error("langfuse internal error");
      }
    }

    const client = createLangfuseClient({
      publicKey: "pk",
      secretKey: "sk",
      _ctor: ThrowingLangfuse,
    });
    // Must not throw synchronously
    expect(() => client.flush(makeDecisionEvent())).not.toThrow();
    // Must not throw asynchronously either
    await new Promise((r) => setTimeout(r, 10));
  });

  test("reuses the same Langfuse instance across multiple flushes", async () => {
    const { Ctor, constructorCallArgs, traceCallArgs } = makeFakeLangfuse();

    const client = createLangfuseClient({ publicKey: "pk", secretKey: "sk", _ctor: Ctor });
    client.flush(makeDecisionEvent());
    client.flush(makeOutcomeEvent());
    await new Promise((r) => setTimeout(r, 20));

    // Constructor called once, trace called twice
    expect(constructorCallArgs).toHaveLength(1);
    expect(traceCallArgs).toHaveLength(2);
  });

  test("flush never throws when constructor throws", async () => {
    class BadCtor {
      constructor(_opts: object) {
        throw new Error("constructor failed");
      }
      trace(_args: FakeTrace): void {}
    }

    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const client = createLangfuseClient({
      publicKey: "pk",
      secretKey: "sk",
      _ctor: BadCtor,
    });
    expect(() => client.flush(makeDecisionEvent())).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
  });
});

// ---------------------------------------------------------------------------
// Tests — peer missing (simulated via _ctor: null)
// ---------------------------------------------------------------------------

describe("createLangfuseClient — peer missing", () => {
  test("silently no-ops and writes a one-time warning to stderr", async () => {
    // _ctor: null simulates "langfuse peer not installed"
    const stderrChunks: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrChunks.push(String(chunk));
      return true;
    });

    const client = createLangfuseClient({ publicKey: "pk", secretKey: "sk", _ctor: null });
    // Must not throw synchronously
    expect(() => client.flush(makeDecisionEvent())).not.toThrow();
    await new Promise((r) => setTimeout(r, 20));

    const warning = stderrChunks.join("");
    expect(warning).toContain("langfuse peer not installed");
  });

  test("only emits the warning once across multiple flushes", async () => {
    const stderrChunks: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrChunks.push(String(chunk));
      return true;
    });

    const client = createLangfuseClient({ publicKey: "pk", secretKey: "sk", _ctor: null });
    client.flush(makeDecisionEvent());
    client.flush(makeOutcomeEvent());
    await new Promise((r) => setTimeout(r, 20));

    const warningCount = stderrChunks
      .join("")
      .split("langfuse peer not installed")
      .length - 1;
    expect(warningCount).toBe(1);
  });

  test("flush never throws when peer is missing", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const client = createLangfuseClient({ publicKey: "pk", secretKey: "sk", _ctor: null });
    expect(() => client.flush(makeDecisionEvent())).not.toThrow();
    expect(() => client.flush(makeOutcomeEvent())).not.toThrow();
    expect(() => client.flush(makeCorrectionEvent())).not.toThrow();
    await new Promise((r) => setTimeout(r, 20));
  });
});
