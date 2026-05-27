// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTelemetry } from "./telemetry.js";
import type { TelemetryEvent } from "./types.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "maestro-tel-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const decisionEvent = (ts = "2026-05-21T10:00:00.000Z"): TelemetryEvent => ({
  type: "decision",
  ts,
  decision: {
    class: "trivial",
    classifier: "override",
    confidence: 1.0,
    spec: { model: "haiku", effort: "low", maxBudgetUsd: 0.05 },
    latencyMs: 5,
    diagnostics: [],
  },
});

describe("createTelemetry", () => {
  test("appends events as JSONL", async () => {
    const path = join(dir, "decisions.jsonl");
    const configPath = join(dir, "config.json");
    const tel = createTelemetry({ path, configPath });

    await tel.log(decisionEvent());
    const content = await readFile(path, "utf8");
    expect(content.trim().split("\n")).toHaveLength(1);
    const parsed = JSON.parse(content.trim()) as TelemetryEvent;
    expect(parsed.type).toBe("decision");
  });

  test("persists optional prompt field on decision events", async () => {
    const path = join(dir, "decisions.jsonl");
    const configPath = join(dir, "config.json");
    const tel = createTelemetry({ path, configPath });

    await tel.log({ ...decisionEvent(), prompt: "hello world" });
    const events = await tel.readAll();
    expect(events).toHaveLength(1);
    const evt = events[0]!;
    expect(evt.type).toBe("decision");
    expect((evt as { prompt?: string }).prompt).toBe("hello world");
  });

  test("readAll returns parsed events", async () => {
    const tel = createTelemetry({
      path: join(dir, "decisions.jsonl"),
      configPath: join(dir, "config.json"),
    });
    await tel.log(decisionEvent("2026-05-21T10:00:00.000Z"));
    await tel.log({
      type: "feedback",
      ts: "2026-05-21T10:01:00.000Z",
      sessionId: "abc",
      rating: 5,
    });
    const events = await tel.readAll();
    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe("decision");
    expect(events[1]!.type).toBe("feedback");
  });

  test("readAll returns [] when file missing", async () => {
    const tel = createTelemetry({
      path: join(dir, "missing.jsonl"),
      configPath: join(dir, "config.json"),
    });
    expect(await tel.readAll()).toEqual([]);
  });

  test("updates counters in config.json", async () => {
    const path = join(dir, "decisions.jsonl");
    const configPath = join(dir, "config.json");
    const tel = createTelemetry({ path, configPath });

    await tel.log(decisionEvent("2026-05-21T10:00:00.000Z"));
    await tel.log(decisionEvent("2026-05-21T10:01:00.000Z"));

    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      telemetry: { eventsLogged: number; lastWriteAt: string };
    };
    expect(config.telemetry.eventsLogged).toBe(2);
    expect(config.telemetry.lastWriteAt).toBe("2026-05-21T10:01:00.000Z");
  });

  test("preserves existing config keys when updating counters", async () => {
    const configPath = join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({ profile: "balanced" }), "utf8");
    const tel = createTelemetry({ path: join(dir, "decisions.jsonl"), configPath });
    await tel.log(decisionEvent());

    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      profile: string;
      telemetry: { eventsLogged: number };
    };
    expect(config.profile).toBe("balanced");
    expect(config.telemetry.eventsLogged).toBe(1);
  });

  test("rotates when file exceeds maxFileBytes", async () => {
    const path = join(dir, "decisions.jsonl");
    const configPath = join(dir, "config.json");
    await writeFile(path, "x".repeat(200), "utf8");

    const tel = createTelemetry({ path, configPath, maxFileBytes: 100 });
    await tel.log(decisionEvent());

    const files = await readdir(dir);
    const rotated = files.filter((f) => f.startsWith("decisions.jsonl."));
    expect(rotated.length).toBe(1);

    const newContent = await readFile(path, "utf8");
    expect(newContent).toContain("decision");
    expect(newContent.length).toBeLessThan(500);
  });

  test("logFallback appends full prompt to a dedicated file", async () => {
    const fallbackPath = join(dir, "fallbacks.jsonl");
    const tel = createTelemetry({
      path: join(dir, "decisions.jsonl"),
      configPath: join(dir, "config.json"),
      fallbackPath,
    });

    const longPrompt = "x".repeat(2000);
    await tel.logFallback({
      ts: "2026-05-27T10:00:00.000Z",
      prompt: longPrompt,
      classifier: "forced.standard",
      cwd: "/tmp/proj",
      sessionId: "s1",
      turnIndex: 3,
      diagnostics: ["fallback.forced_standard"],
    });

    const content = await readFile(fallbackPath, "utf8");
    const parsed = JSON.parse(content.trim()) as { prompt: string; classifier: string };
    expect(parsed.prompt).toHaveLength(2000);
    expect(parsed.classifier).toBe("forced.standard");
  });

  test("logFallback does not touch the decisions file or counters", async () => {
    const path = join(dir, "decisions.jsonl");
    const configPath = join(dir, "config.json");
    const tel = createTelemetry({ path, configPath, fallbackPath: join(dir, "fallbacks.jsonl") });

    await tel.logFallback({
      ts: "2026-05-27T10:00:00.000Z",
      prompt: "p",
      classifier: "forced.standard",
      cwd: "/tmp",
      diagnostics: [],
    });

    expect(await tel.readAll()).toEqual([]);
    await expect(readFile(configPath, "utf8")).rejects.toThrow();
  });

  test("logFallback swallows errors and never throws", async () => {
    const tel = createTelemetry({
      path: join(dir, "decisions.jsonl"),
      configPath: join(dir, "config.json"),
      fallbackPath: join(dir, "fall\0back.jsonl"),
    });
    await expect(
      tel.logFallback({
        ts: "2026-05-27T10:00:00.000Z",
        prompt: "p",
        classifier: "forced.standard",
        cwd: "/tmp",
        diagnostics: [],
      }),
    ).resolves.toBeUndefined();
  });

  test("swallows errors and never throws from log()", async () => {
    // Path with a non-existent component that mkdir can fix; force a real error path
    // by passing an invalid configPath that has a null byte (POSIX rejects).
    const tel = createTelemetry({
      path: join(dir, "decisions.jsonl"),
      configPath: join(dir, "config\0.json"),
    });
    await expect(tel.log(decisionEvent())).resolves.toBeUndefined();
  });
});
