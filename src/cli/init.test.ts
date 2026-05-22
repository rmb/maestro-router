// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, expect, test, vi } from "vitest";
import { runInit, type InitDependencies } from "./init.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSteps(overrides: Partial<InitDependencies> = {}): InitDependencies {
  return {
    installDefaults: vi.fn().mockResolvedValue({ status: "written" as const }),
    installVscode: vi.fn().mockResolvedValue({ status: "written" as const }),
    installCommands: vi.fn().mockResolvedValue({ status: "written" as const }),
    installHook: vi.fn().mockResolvedValue({ status: "written" as const }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runInit", () => {
  test("calls all four install steps in order", async () => {
    const callOrder: string[] = [];
    const deps: InitDependencies = {
      installDefaults: vi.fn().mockImplementation(async () => {
        callOrder.push("defaults");
        return { status: "written" as const };
      }),
      installVscode: vi.fn().mockImplementation(async () => {
        callOrder.push("vscode");
        return { status: "written" as const };
      }),
      installCommands: vi.fn().mockImplementation(async () => {
        callOrder.push("commands");
        return { status: "written" as const };
      }),
      installHook: vi.fn().mockImplementation(async () => {
        callOrder.push("hook");
        return { status: "written" as const };
      }),
    };
    await runInit(deps);
    expect(callOrder).toEqual(["defaults", "vscode", "commands", "hook"]);
  });

  test("returns written status for all steps when everything is new", async () => {
    const result = await runInit(makeSteps());
    expect(result.steps.every((s) => s.status === "written")).toBe(true);
  });

  test("returns already-present status when steps are already done", async () => {
    const result = await runInit(
      makeSteps({
        installDefaults: vi.fn().mockResolvedValue({ status: "already-present" as const }),
        installVscode: vi.fn().mockResolvedValue({ status: "already-present" as const }),
        installCommands: vi.fn().mockResolvedValue({ status: "already-present" as const }),
        installHook: vi.fn().mockResolvedValue({ status: "already-present" as const }),
      }),
    );
    expect(result.steps.every((s) => s.status === "already-present")).toBe(true);
  });

  test("returns failed status and continues when a step throws", async () => {
    const result = await runInit(
      makeSteps({
        installVscode: vi.fn().mockRejectedValue(new Error("permission denied")),
      }),
    );
    const vscodeStep = result.steps.find((s) => s.name === "vscode");
    expect(vscodeStep?.status).toBe("failed");
    expect(vscodeStep?.error).toMatch(/permission denied/);
    // Other steps still ran
    expect(result.steps.find((s) => s.name === "defaults")?.status).toBe("written");
    expect(result.steps.find((s) => s.name === "commands")?.status).toBe("written");
    expect(result.steps.find((s) => s.name === "hook")?.status).toBe("written");
  });

  test("result.ok is false when any step failed", async () => {
    const result = await runInit(
      makeSteps({
        installHook: vi.fn().mockRejectedValue(new Error("oops")),
      }),
    );
    expect(result.ok).toBe(false);
  });

  test("result.ok is true when all steps are written or already-present", async () => {
    const result = await runInit(
      makeSteps({
        installDefaults: vi.fn().mockResolvedValue({ status: "already-present" as const }),
        installVscode: vi.fn().mockResolvedValue({ status: "written" as const }),
        installCommands: vi.fn().mockResolvedValue({ status: "already-present" as const }),
        installHook: vi.fn().mockResolvedValue({ status: "written" as const }),
      }),
    );
    expect(result.ok).toBe(true);
  });

  test("step names match expected labels", async () => {
    const result = await runInit(makeSteps());
    const names = result.steps.map((s) => s.name);
    expect(names).toEqual(["defaults", "vscode", "commands", "hook"]);
  });

  test("idempotent: running twice returns already-present on second call", async () => {
    // Simulate: first call writes, second call sees existing state
    let callCount = 0;
    const deps: InitDependencies = {
      installDefaults: vi.fn().mockImplementation(async () => {
        callCount++;
        return callCount === 1
          ? { status: "written" as const }
          : { status: "already-present" as const };
      }),
      installVscode: vi.fn().mockResolvedValue({ status: "written" as const }),
      installCommands: vi.fn().mockResolvedValue({ status: "written" as const }),
      installHook: vi.fn().mockResolvedValue({ status: "written" as const }),
    };
    const first = await runInit(deps);
    expect(first.ok).toBe(true);
    // Simulate second run with all already-present
    const result2 = await runInit(
      makeSteps({
        installDefaults: vi.fn().mockResolvedValue({ status: "already-present" as const }),
        installVscode: vi.fn().mockResolvedValue({ status: "already-present" as const }),
        installCommands: vi.fn().mockResolvedValue({ status: "already-present" as const }),
        installHook: vi.fn().mockResolvedValue({ status: "already-present" as const }),
      }),
    );
    expect(result2.ok).toBe(true);
    expect(result2.steps.every((s) => s.status === "already-present")).toBe(true);
  });
});
