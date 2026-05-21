// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0
//
// Live smoke test for hooks/stop-feedback.sh. Skipped unless
// MAESTRO_HOOK_LIVE=1 — relies on a real /dev/tty, jq, and a mock
// `maestro` shim on PATH. CI never runs this.

import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const LIVE = process.env["MAESTRO_HOOK_LIVE"] === "1";
const here = dirname(fileURLToPath(import.meta.url));
const HOOK_SCRIPT = resolve(here, "..", "..", "hooks", "stop-feedback.sh");

describe.skipIf(!LIVE)("stop-feedback.sh live", () => {
  test("never mode: exits 0 without prompting", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "maestro-hook-live-"));
    const config = join(tmp, "config.json");
    await writeFile(config, JSON.stringify({ feedbackPrompts: "never" }), "utf8");

    const shimDir = join(tmp, "bin");
    await mkdir(shimDir, { recursive: true });
    const logFile = join(tmp, "log");
    await writeFile(
      join(shimDir, "maestro"),
      `#!/bin/sh\necho CALLED >> ${logFile}\n`,
      "utf8",
    );
    await chmod(join(shimDir, "maestro"), 0o755);

    const env = {
      ...process.env,
      MAESTRO_CONFIG: config,
      PATH: shimDir + ":" + (process.env["PATH"] ?? ""),
    };

    const code = await new Promise<number>((res) => {
      const p = spawn("sh", [HOOK_SCRIPT], { env, stdio: ["pipe", "pipe", "pipe"] });
      p.stdin.end(JSON.stringify({ session_id: "abc" }));
      p.on("close", (c) => res(c ?? -1));
    });
    expect(code).toBe(0);
  });
});
