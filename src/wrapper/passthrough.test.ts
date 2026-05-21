// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import {
  KNOWN_SLASH_COMMANDS,
  isKnownSlashCommand,
  isSlashPrefix,
} from "./passthrough.js";

describe("isKnownSlashCommand", () => {
  test("matches every documented command bare", () => {
    for (const cmd of KNOWN_SLASH_COMMANDS) {
      expect(isKnownSlashCommand(cmd)).toBe(true);
    }
  });

  test("matches when args follow", () => {
    expect(isKnownSlashCommand("/model sonnet")).toBe(true);
    expect(isKnownSlashCommand("/cost detail")).toBe(true);
  });

  test("matches with leading whitespace", () => {
    expect(isKnownSlashCommand("   /help")).toBe(true);
  });

  test("rejects unknown slash word", () => {
    expect(isKnownSlashCommand("/notACommand")).toBe(false);
  });

  test("rejects non-slash prompts", () => {
    expect(isKnownSlashCommand("model sonnet")).toBe(false);
    expect(isKnownSlashCommand("rename foo")).toBe(false);
  });

  test("rejects empty input", () => {
    expect(isKnownSlashCommand("")).toBe(false);
    expect(isKnownSlashCommand("   ")).toBe(false);
  });

  test("rejects bare slash", () => {
    expect(isKnownSlashCommand("/")).toBe(false);
  });

  test("does not match substring after the first token", () => {
    expect(isKnownSlashCommand("rename to /model")).toBe(false);
  });
});

describe("isSlashPrefix", () => {
  test("matches known slash commands", () => {
    expect(isSlashPrefix("/help")).toBe(true);
    expect(isSlashPrefix("/cost")).toBe(true);
  });

  test("matches unknown but well-formed slash skills", () => {
    expect(isSlashPrefix("/my-custom-skill")).toBe(true);
    expect(isSlashPrefix("/plugin:do_thing")).toBe(false); // colon not in [\w-]
    expect(isSlashPrefix("/skill_name")).toBe(true);
  });

  test("rejects bare slash and slash-only-symbols", () => {
    expect(isSlashPrefix("/")).toBe(false);
    expect(isSlashPrefix("/1abc")).toBe(false); // must start with letter
    expect(isSlashPrefix("/!doit")).toBe(false);
  });

  test("matches with leading whitespace and trailing args", () => {
    expect(isSlashPrefix("  /clear now")).toBe(true);
  });

  test("rejects non-slash prompts", () => {
    expect(isSlashPrefix("rename foo")).toBe(false);
    expect(isSlashPrefix("")).toBe(false);
    expect(isSlashPrefix("foo /not-at-start")).toBe(false);
  });
});
