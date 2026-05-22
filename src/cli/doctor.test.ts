// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { runChecks, type CheckResult, type DoctorOptions } from "./doctor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOpts(overrides: Partial<DoctorOptions> = {}): DoctorOptions {
  return {
    spawn: (_cmd, _args) => ({ status: 0, stdout: "claude 2.1.112\n" }),
    readFile: async (_p) => '{ "claudeCode.claudeProcessWrapper": "/usr/local/bin/maestro" }',
    statFile: async (_p) => true,
    getNodeVersion: () => "20.0.0",
    whichPnpm: () => "/usr/local/bin/pnpm",
    maestroBinary: "/usr/local/bin/maestro",
    vscodeSettingsPath: "/tmp/settings.json",
    maestroConfigPath: "/tmp/.maestro/config.json",
    telemetryDir: "/tmp/.maestro",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runChecks", () => {
  test("all green when environment is complete", async () => {
    const results = await runChecks(makeOpts());
    expect(results.every((r) => r.ok)).toBe(true);
  });

  test("fails when claude binary not found", async () => {
    const results = await runChecks(
      makeOpts({
        spawn: (_cmd, _args) => ({ status: 1, stdout: "", error: new Error("not found") }),
      }),
    );
    const check = results.find((r) => r.name === "claude binary");
    expect(check?.ok).toBe(false);
    expect(check?.fix).toMatch(/install/i);
  });

  test("fails when claude version is below minimum", async () => {
    const results = await runChecks(
      makeOpts({
        spawn: (_cmd, _args) => ({ status: 0, stdout: "claude 1.9.0\n" }),
      }),
    );
    const check = results.find((r) => r.name === "claude version");
    expect(check?.ok).toBe(false);
    expect(check?.fix).toMatch(/upgrade/i);
  });

  test("fails when claudeProcessWrapper is not set to maestro binary", async () => {
    const results = await runChecks(
      makeOpts({
        readFile: async (_p) => '{ "claudeCode.claudeProcessWrapper": "/other/wrapper" }',
      }),
    );
    const check = results.find((r) => r.name === "claudeProcessWrapper");
    expect(check?.ok).toBe(false);
    expect(check?.fix).toMatch(/install-vscode/i);
  });

  test("fails when claudeProcessWrapper is absent from settings", async () => {
    const results = await runChecks(
      makeOpts({
        readFile: async (_p) => "{}",
      }),
    );
    const check = results.find((r) => r.name === "claudeProcessWrapper");
    expect(check?.ok).toBe(false);
  });

  test("fails when VSCode settings.json is missing", async () => {
    const results = await runChecks(
      makeOpts({
        readFile: async (_p) => {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        },
      }),
    );
    const check = results.find((r) => r.name === "claudeProcessWrapper");
    expect(check?.ok).toBe(false);
    expect(check?.fix).toMatch(/install-vscode/i);
  });

  test("fails when ~/.maestro/config.json is missing", async () => {
    const results = await runChecks(
      makeOpts({
        statFile: async (p) => !p.includes("config.json"),
      }),
    );
    const check = results.find((r) => r.name === "maestro config");
    expect(check?.ok).toBe(false);
    expect(check?.fix).toMatch(/install-defaults/i);
  });

  test("fails when telemetry dir is not writable (stat throws)", async () => {
    const results = await runChecks(
      makeOpts({
        statFile: async (p) => {
          if (p.includes(".maestro") && !p.includes("config.json")) throw new Error("EACCES");
          return true;
        },
      }),
    );
    const check = results.find((r) => r.name === "telemetry dir");
    expect(check?.ok).toBe(false);
  });

  test("fails when Node version is below 20", async () => {
    const results = await runChecks(
      makeOpts({ getNodeVersion: () => "18.20.0" }),
    );
    const check = results.find((r) => r.name === "node version");
    expect(check?.ok).toBe(false);
    expect(check?.fix).toMatch(/20/);
  });

  test("fails when pnpm is not on PATH", async () => {
    const results = await runChecks(
      makeOpts({ whichPnpm: () => null }),
    );
    const check = results.find((r) => r.name === "pnpm");
    expect(check?.ok).toBe(false);
    expect(check?.fix).toMatch(/pnpm/i);
  });

  test("check names are stable (used by init summary)", async () => {
    const results = await runChecks(makeOpts());
    const names = results.map((r) => r.name);
    expect(names).toContain("claude binary");
    expect(names).toContain("claude version");
    expect(names).toContain("claudeProcessWrapper");
    expect(names).toContain("maestro config");
    expect(names).toContain("telemetry dir");
    expect(names).toContain("node version");
    expect(names).toContain("pnpm");
  });
});
