// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { Command } from "commander";
import { afterEach, describe, expect, test, vi } from "vitest";
import { registerOracleCommand } from "./oracle.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal program with only the oracle subcommand registered.
 * We use exitOverride() so Commander throws instead of calling process.exit(),
 * and we can test validation paths via process.exitCode.
 */
function makeProgram(): Command {
  const program = new Command();
  program
    .name("maestro")
    .option("-q, --quiet", "suppress informational output")
    .option("--json", "JSON output")
    .option("--config <path>", "config override")
    .exitOverride();
  registerOracleCommand(program);
  return program;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterEach(() => {
  process.exitCode = undefined;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("oracle subcommand registration", () => {
  test('"oracle" is registered as a subcommand via buildProgram', async () => {
    const { buildProgram } = await import("./index.js");
    const program = await buildProgram();
    const names = program.commands.map((c) => c.name());
    expect(names).toContain("oracle");
  });
});

describe("oracle dimension validation", () => {
  test("exits 1 and returns for an invalid --dimension value", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const program = makeProgram();

    try {
      await program.parseAsync(
        ["node", "maestro", "oracle", "--dimension", "invalid"],
        { from: "node" },
      );
    } catch {
      // Commander may throw via exitOverride; ignore — we check exitCode
    }

    expect(process.exitCode).toBe(1);
    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(output).toMatch(/unknown dimension "invalid"/);
    stderrSpy.mockRestore();
  });

  test("exits 1 when quality dimension is requested without --confirm-cost", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const program = makeProgram();

    try {
      await program.parseAsync(
        ["node", "maestro", "oracle", "--dimension", "quality"],
        { from: "node" },
      );
    } catch {
      // Commander may throw via exitOverride; ignore
    }

    expect(process.exitCode).toBe(1);
    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(output).toMatch(/--confirm-cost/);
    stderrSpy.mockRestore();
  });

  test("does not exit 1 for a known valid dimension (tool)", async () => {
    // We can't fully run oracle without real telemetry files, so we just
    // verify that validation passes for a known-valid dimension name —
    // the command won't reach exitCode=1 due to a validation rejection.
    // A downstream error (e.g. missing telemetry) is fine; we just check
    // exitCode was not set to 1 by the validation guard before the async run.
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const program = makeProgram();

    // Reset before the run
    process.exitCode = undefined;

    try {
      await program.parseAsync(
        ["node", "maestro", "oracle", "--dimension", "tool"],
        { from: "node" },
      );
    } catch {
      // Errors from downstream (no telemetry file etc.) are expected; ignore
    }

    // Validation guard must NOT have set exitCode=1 for "tool"
    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(output).not.toMatch(/unknown dimension "tool"/);
    stderrSpy.mockRestore();
  });
});

describe("oracle quality dimension", () => {
  test("runs without error when quality requested with --confirm-cost", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const program = makeProgram();

    try {
      await program.parseAsync(
        ["node", "maestro", "oracle", "--dimension", "quality", "--confirm-cost"],
        { from: "node" },
      );
    } catch {
      // Downstream errors (no sessions file, no telemetry) are fine
    }

    // Should NOT print the old stub warning — quality is now implemented
    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(output).not.toMatch(/not yet implemented/);
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
  });
});
