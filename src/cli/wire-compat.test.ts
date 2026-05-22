// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { detectWireCompatShape, shouldEnterWireCompat } from "./wire-compat.js";

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
