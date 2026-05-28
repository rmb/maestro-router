// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

/**
 * Tests for registerShellCommand — focused on F9 session reuse behaviour:
 * whether --resume is present/absent in claudeArgs passed to runShellHost.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Injectable mocks defined before vi.mock calls (closures captured at runtime).
const mockGetByFingerprint = vi.fn().mockResolvedValue({ sessionId: "prior-session-id", isNew: false });
const mockRunShellHost = vi.fn().mockResolvedValue(0);

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
      userConfig: { useEmbeddingClassifier: false, useLlmClassifierInWrapper: false },
      profileOverrides: {},
      userHeuristics: [],
    }),
  };
});

vi.mock("../wrapper/session.js", () => ({
  createSessionStore: () => ({
    list: vi.fn().mockResolvedValue([]),
    getByFingerprint: mockGetByFingerprint,
  }),
}));

vi.mock("../wrapper/prewarm.js", () => ({
  computeFingerprint: vi.fn().mockReturnValue("test-fp"),
  prewarmFingerprints: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../wrapper/sdk-host.js", () => ({
  runShellHost: mockRunShellHost,
  installGhostText: vi.fn(),
}));

vi.mock("./components/Banner.js", () => ({
  renderBanner: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./wire-compat.js", () => ({
  resolveRealClaude: () => "/usr/local/bin/claude",
}));

vi.mock("../core/telemetry.js", () => ({
  createTelemetry: () => ({
    log: vi.fn().mockResolvedValue(undefined),
    logFallback: vi.fn().mockResolvedValue(undefined),
    readAll: async (): Promise<never[]> => [],
  }),
}));

async function runShell(args: string[] = []): Promise<void> {
  const { loadCliConfig } = await import("./utils.js");
  vi.mocked(loadCliConfig).mockResolvedValue({
    userConfig: { useEmbeddingClassifier: false, useLlmClassifierInWrapper: false },
    profileOverrides: {},
    userHeuristics: [],
  } as Parameters<typeof loadCliConfig>[0] extends never ? never : Awaited<ReturnType<typeof loadCliConfig>>);

  const { Command } = await import("commander");
  const { registerShellCommand } = await import("./shell-cmd.js");

  const program = new Command();
  program.name("maestro").exitOverride();
  registerShellCommand(program);

  try {
    await program.parseAsync(["node", "maestro", "shell", ...args], { from: "node" });
  } catch {
    // exitOverride throws on process.exit — expected
  }
}

describe("registerShellCommand — F9 session reuse", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetByFingerprint.mockResolvedValue({ sessionId: "prior-session-id", isNew: false });
    mockRunShellHost.mockResolvedValue(0);
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  test("--resume and prior sessionId included in claudeArgs when session is reused (isNew: false)", async () => {
    await runShell();

    const opts = mockRunShellHost.mock.calls[0]?.[0] as { claudeArgs?: string[] } | undefined;
    expect(opts?.claudeArgs).toContain("--resume");
    expect(opts?.claudeArgs).toContain("prior-session-id");
  });

  test("--resume absent in claudeArgs when session is new (isNew: true)", async () => {
    mockGetByFingerprint.mockResolvedValue({ sessionId: "brand-new-id", isNew: true });

    await runShell();

    const opts = mockRunShellHost.mock.calls[0]?.[0] as { claudeArgs?: string[] } | undefined;
    expect(opts?.claudeArgs).not.toContain("--resume");
    expect(opts?.claudeArgs).toContain("brand-new-id");
  });

  test("--new flag passes newSession: true to getByFingerprint", async () => {
    await runShell(["--new"]);

    expect(mockGetByFingerprint).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ newSession: true }),
    );
  });
});
