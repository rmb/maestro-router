// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { detectWireCompatShape, shouldEnterWireCompat } from "./wire-compat.js";
import { toolOverrideClassifier } from "../classifiers/tool-override.js";
import { overrideClassifier } from "../classifiers/override.js";
import { turnTypeClassifier } from "../classifiers/turn-type.js";
import { heuristicClassifier } from "../classifiers/heuristic.js";
import { createPipeline } from "../core/pipeline.js";
import { balancedProfile } from "../core/profile.js";
import type { Request } from "../core/types.js";

describe("detectWireCompatShape", () => {
  test("returns none for empty argv", () => {
    expect(detectWireCompatShape(["node", "maestro"])).toBe("none");
  });

  test("returns process-wrapper when argv[2] is an absolute claude path", () => {
    expect(detectWireCompatShape(["node", "maestro", "/opt/homebrew/bin/claude", "--print"]))
      .toBe("process-wrapper");
  });

  test("returns direct-claude-args when --print is present without binary path", () => {
    expect(detectWireCompatShape(["node", "maestro", "--print", "--model", "haiku"]))
      .toBe("direct-claude-args");
  });

  test("returns none for known Maestro subcommand", () => {
    expect(detectWireCompatShape(["node", "maestro", "stats"])).toBe("none");
    expect(detectWireCompatShape(["node", "maestro", "run", "hello"])).toBe("none");
  });

  test("returns none for --version flag", () => {
    expect(detectWireCompatShape(["node", "maestro", "--version"])).toBe("none");
  });

  test("shouldEnterWireCompat returns true for process-wrapper shape", () => {
    expect(shouldEnterWireCompat(["node", "maestro", "/usr/local/bin/claude", "--print"]))
      .toBe(true);
  });

  test("shouldEnterWireCompat returns false for maestro subcommand", () => {
    expect(shouldEnterWireCompat(["node", "maestro", "stats"])).toBe(false);
  });
});

/**
 * Smoke test: build the same classifier ordering that buildPipeline uses
 * and verify a tool_result request with resolvedToolName=Read routes to trivial.
 */
describe("wire-compat pipeline ordering — tool-override inserted", () => {
  test("Read tool_result request routes to trivial class via toolOverrideClassifier", async () => {
    const classifiers = [
      overrideClassifier,
      turnTypeClassifier,
      toolOverrideClassifier,
      heuristicClassifier,
    ];
    const pipeline = createPipeline({ classifiers, profile: balancedProfile });
    const req: Request = {
      prompt: "",
      metadata: { resolvedToolName: "Read" },
    };
    const decision = await pipeline.route(req);
    expect(decision.class).toBe("trivial");
    expect(decision.classifier).toBe("tool-override");
  });

  test("Task tool_result request routes to standard class", async () => {
    const classifiers = [
      overrideClassifier,
      turnTypeClassifier,
      toolOverrideClassifier,
      heuristicClassifier,
    ];
    const pipeline = createPipeline({ classifiers, profile: balancedProfile });
    const req: Request = {
      prompt: "",
      metadata: { resolvedToolName: "Task" },
    };
    const decision = await pipeline.route(req);
    expect(decision.class).toBe("standard");
    expect(decision.classifier).toBe("tool-override");
  });

  test("user prompt without metadata falls through to heuristic", async () => {
    const classifiers = [
      overrideClassifier,
      turnTypeClassifier,
      toolOverrideClassifier,
      heuristicClassifier,
    ];
    const pipeline = createPipeline({ classifiers, profile: balancedProfile });
    const req: Request = { prompt: "rename this function" };
    const decision = await pipeline.route(req);
    // turnType and toolOverride both return null; heuristic or default wins.
    expect(decision.classifier).not.toBe("tool-override");
  });
});
