// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { Command } from "commander";
import { mkdtemp, readFile, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { registerTelemetryCommand } from "./telemetry-cmd.js";

// Note: we register only the telemetry subcommand on a fresh Command rather
// than going through buildProgram() — that pulls in run-cmd/replay/bench
// which currently import an embedding classifier that may not be present
// in this branch state. This file only exercises the telemetry feedback
// command path.

function makeProgram(): Command {
  const program = new Command();
  program
    .name("maestro")
    .option("-q, --quiet", "suppress informational output")
    .option("--json", "JSON output")
    .option("--config <path>", "config override");
  registerTelemetryCommand(program);
  return program;
}

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "maestro-fb-"));
}

async function writeUserConfig(dir: string, telemetryPath: string): Promise<string> {
  const path = join(dir, "config.json");
  await writeFile(path, JSON.stringify({ telemetryPath }), "utf8");
  return path;
}

async function readLogged(telemetryPath: string): Promise<unknown[]> {
  const data = await readFile(telemetryPath, "utf8");
  return data
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as unknown);
}

describe("telemetry feedback --auto", () => {
  let workDir = "";
  let telemetryPath = "";
  let configPath = "";

  beforeEach(async () => {
    workDir = await makeTempDir();
    telemetryPath = join(workDir, "decisions.jsonl");
    configPath = await writeUserConfig(workDir, telemetryPath);
  });

  afterEach(() => {
    workDir = "";
  });

  test("records source=manual by default", async () => {
    const program = makeProgram();
    await program.parseAsync(
      [
        "--quiet",
        "--config",
        configPath,
        "telemetry",
        "feedback",
        "sess-1",
        "--rating",
        "4",
      ],
      { from: "user" },
    );
    const events = await readLogged(telemetryPath);
    expect(events).toHaveLength(1);
    const ev = events[0] as { type: string; rating: number; source?: string };
    expect(ev.type).toBe("feedback");
    expect(ev.rating).toBe(4);
    expect(ev.source).toBe("manual");
  });

  test("records source=auto when --auto is passed", async () => {
    const program = makeProgram();
    await program.parseAsync(
      [
        "--quiet",
        "--config",
        configPath,
        "telemetry",
        "feedback",
        "sess-2",
        "--rating",
        "2",
        "--auto",
      ],
      { from: "user" },
    );
    const events = await readLogged(telemetryPath);
    expect(events).toHaveLength(1);
    const ev = events[0] as { source?: string; rating: number; sessionId: string };
    expect(ev.source).toBe("auto");
    expect(ev.rating).toBe(2);
    expect(ev.sessionId).toBe("sess-2");
  });
});

describe("telemetry off", () => {
  let workDir = "";
  let configPath = "";

  beforeEach(async () => {
    workDir = await makeTempDir();
    configPath = join(workDir, "config.json");
  });

  afterEach(() => {
    workDir = "";
  });

  test("disables remote telemetry when posthogApiKey is set", async () => {
    await writeFile(
      configPath,
      JSON.stringify({ posthogApiKey: "phx_test123" }),
      "utf8",
    );
    const program = makeProgram();
    const stdoutChunks: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = (chunk: string) => {
      stdoutChunks.push(chunk);
      return true;
    };

    await program.parseAsync(
      ["--config", configPath, "telemetry", "off"],
      { from: "user" },
    );

    process.stdout.write = origWrite;
    const config = JSON.parse(
      await readFile(configPath, "utf8"),
    ) as Record<string, unknown>;
    expect(config.posthogApiKey).toBeUndefined();
    const output = stdoutChunks.join("");
    expect(output).toContain("Remote telemetry disabled");
  });

  test("exits silently when posthogApiKey is already unset", async () => {
    await writeFile(configPath, JSON.stringify({ profile: "aggressive" }), "utf8");
    const program = makeProgram();
    const stdoutChunks: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = (chunk: string) => {
      stdoutChunks.push(chunk);
      return true;
    };

    await program.parseAsync(
      ["--config", configPath, "telemetry", "off"],
      { from: "user" },
    );

    process.stdout.write = origWrite;
    expect(
      stdoutChunks.some((c) => c.includes("already off")),
    ).toBe(true);
  });

  test("respects --quiet flag", async () => {
    await writeFile(
      configPath,
      JSON.stringify({ posthogApiKey: "phx_test123" }),
      "utf8",
    );
    const program = makeProgram();
    const stdoutChunks: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = (chunk: string) => {
      stdoutChunks.push(chunk);
      return true;
    };

    await program.parseAsync(
      ["--quiet", "--config", configPath, "telemetry", "off"],
      { from: "user" },
    );

    process.stdout.write = origWrite;
    const output = stdoutChunks.join("");
    expect(output).toBe("");
  });

  test("respects --json flag", async () => {
    await writeFile(
      configPath,
      JSON.stringify({ posthogApiKey: "phx_test123" }),
      "utf8",
    );
    const program = makeProgram();
    const stdoutChunks: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = (chunk: string) => {
      stdoutChunks.push(chunk);
      return true;
    };

    await program.parseAsync(
      ["--json", "--config", configPath, "telemetry", "off"],
      { from: "user" },
    );

    process.stdout.write = origWrite;
    const output = stdoutChunks.join("");
    const parsed = JSON.parse(output);
    expect(parsed.disabled).toBe(true);
    expect(parsed.wasEnabled).toBe(true);
    expect(parsed.configPath).toBeDefined();
  });

  test("emits disabled: true with --json when already-off", async () => {
    await writeFile(configPath, JSON.stringify({ profile: "aggressive" }), "utf8");
    const program = makeProgram();
    const stdoutChunks: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = (chunk: string) => {
      stdoutChunks.push(chunk);
      return true;
    };

    await program.parseAsync(
      ["--json", "--config", configPath, "telemetry", "off"],
      { from: "user" },
    );

    process.stdout.write = origWrite;
    const output = stdoutChunks.join("");
    const parsed = JSON.parse(output);
    expect(parsed.disabled).toBe(true);
    expect(parsed.wasEnabled).toBe(false);
    expect(parsed.configPath).toBeDefined();
  });
});

describe("telemetry forget", () => {
  let workDir = "";
  let telemetryPath = "";
  let configPath = "";

  beforeEach(async () => {
    workDir = await makeTempDir();
    telemetryPath = join(workDir, "decisions.jsonl");
    configPath = await writeUserConfig(workDir, telemetryPath);
  });

  afterEach(() => {
    workDir = "";
  });

  test("requires --confirm flag", async () => {
    const program = makeProgram();
    const stderrChunks: string[] = [];
    const origStderr = process.stderr.write;
    process.stderr.write = (chunk: string) => {
      stderrChunks.push(chunk);
      return true;
    };

    let exitCode = 0;
    const origExit = process.exit;
    process.exit = ((code?: number) => {
      exitCode = code ?? 0;
      throw new Error("EXIT");
    }) as never;

    try {
      await program.parseAsync(
        ["--config", configPath, "telemetry", "forget"],
        { from: "user" },
      );
    } catch (err) {
      if (!(err instanceof Error && err.message === "EXIT")) throw err;
    } finally {
      process.stderr.write = origStderr;
      process.exit = origExit;
    }

    expect(exitCode).toBe(2);
    expect(stderrChunks.some((c) => c.includes("--confirm"))).toBe(true);
  });

  test("clears all telemetry events when --confirm is passed", async () => {
    await writeFile(
      telemetryPath,
      JSON.stringify({ type: "feedback", ts: "2026-01-01T00:00:00Z" }) + "\n",
      "utf8",
    );
    const program = makeProgram();
    const stdoutChunks: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = (chunk: string) => {
      stdoutChunks.push(chunk);
      return true;
    };

    await program.parseAsync(
      ["--config", configPath, "telemetry", "forget", "--confirm"],
      { from: "user" },
    );

    process.stdout.write = origWrite;
    const output = stdoutChunks.join("");
    expect(output).toContain("Cleared 1 events");

    // Verify file was deleted
    try {
      await readFile(telemetryPath, "utf8");
      expect.fail("Expected telemetry file to be deleted");
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      expect(e.code).toBe("ENOENT");
    }
  });

  test("reports zero cleared when file is already gone", async () => {
    const program = makeProgram();
    const stdoutChunks: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = (chunk: string) => {
      stdoutChunks.push(chunk);
      return true;
    };

    await program.parseAsync(
      ["--config", configPath, "telemetry", "forget", "--confirm"],
      { from: "user" },
    );

    process.stdout.write = origWrite;
    const output = stdoutChunks.join("");
    expect(output).toContain("No local telemetry to clear");
  });

  test("respects --quiet flag", async () => {
    await writeFile(
      telemetryPath,
      JSON.stringify({ type: "feedback", ts: "2026-01-01T00:00:00Z" }) + "\n",
      "utf8",
    );
    const program = makeProgram();
    const stdoutChunks: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = (chunk: string) => {
      stdoutChunks.push(chunk);
      return true;
    };

    await program.parseAsync(
      ["--quiet", "--config", configPath, "telemetry", "forget", "--confirm"],
      { from: "user" },
    );

    process.stdout.write = origWrite;

    // Verify the file was still deleted even in quiet mode
    try {
      await readFile(telemetryPath, "utf8");
      expect.fail("Expected telemetry file to be deleted");
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      expect(e.code).toBe("ENOENT");
    }

    const output = stdoutChunks.join("");
    expect(output).toBe("");
  });

  test("respects --json flag", async () => {
    await writeFile(
      telemetryPath,
      JSON.stringify({ type: "feedback", ts: "2026-01-01T00:00:00Z" }) + "\n" +
      JSON.stringify({ type: "feedback", ts: "2026-01-02T00:00:00Z" }) + "\n",
      "utf8",
    );
    const program = makeProgram();
    const stdoutChunks: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = (chunk: string) => {
      stdoutChunks.push(chunk);
      return true;
    };

    await program.parseAsync(
      ["--json", "--config", configPath, "telemetry", "forget", "--confirm"],
      { from: "user" },
    );

    process.stdout.write = origWrite;
    const output = stdoutChunks.join("");
    const parsed = JSON.parse(output);
    expect(parsed.cleared).toBe(2);
    expect(parsed.path).toBe(telemetryPath);
  });

  test("resets telemetry counters in config after forget", async () => {
    await writeFile(
      telemetryPath,
      JSON.stringify({ type: "feedback", ts: "2026-01-01T00:00:00Z" }) + "\n",
      "utf8",
    );
    await writeFile(
      configPath,
      JSON.stringify({
        telemetryPath,
        telemetry: { eventsLogged: 42, lastWriteAt: "2026-01-01T00:00:00Z" },
      }),
      "utf8",
    );
    const program = makeProgram();
    const stdoutChunks: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = (chunk: string) => {
      stdoutChunks.push(chunk);
      return true;
    };

    await program.parseAsync(
      ["--quiet", "--config", configPath, "telemetry", "forget", "--confirm"],
      { from: "user" },
    );

    process.stdout.write = origWrite;

    // Verify file was deleted
    try {
      await readFile(telemetryPath, "utf8");
      expect.fail("Expected telemetry file to be deleted");
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      expect(e.code).toBe("ENOENT");
    }

    // Verify config counters were reset
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    const telemetry = config.telemetry as Record<string, unknown>;
    expect(telemetry.eventsLogged).toBe(0);
    expect(telemetry.lastWriteAt).toBeNull();
  });
});
