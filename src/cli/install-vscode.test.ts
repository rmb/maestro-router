// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { removeSetting, setSetting } from "./install-vscode.js";

describe("setSetting", () => {
  test("inserts into empty object", () => {
    const next = setSetting("{}", "claudeCode.claudeProcessWrapper", "/usr/bin/maestro");
    expect(next).toContain('"claudeCode.claudeProcessWrapper": "/usr/bin/maestro"');
  });

  test("inserts into object with existing keys, prepending comma to prior line", () => {
    const src = `{
  "editor.fontSize": 14
}`;
    const next = setSetting(src, "claudeCode.claudeProcessWrapper", "/usr/bin/maestro");
    expect(next).toContain('"editor.fontSize": 14,');
    expect(next).toContain('"claudeCode.claudeProcessWrapper": "/usr/bin/maestro"');
  });

  test("replaces existing string value", () => {
    const src = `{
  "claudeCode.claudeProcessWrapper": "/old/path"
}`;
    const next = setSetting(src, "claudeCode.claudeProcessWrapper", "/new/path");
    expect(next).toContain('"claudeCode.claudeProcessWrapper": "/new/path"');
    expect(next).not.toContain("/old/path");
  });

  test("replaces existing boolean value", () => {
    const src = `{ "foo": true }`;
    const next = setSetting(src, "foo", "now-a-string");
    expect(next).toContain('"foo": "now-a-string"');
  });

  test("escapes special characters in the value", () => {
    const src = "{}";
    const next = setSetting(src, "k", 'has "quotes" and \\ slashes');
    expect(next).toContain('"has \\"quotes\\" and \\\\ slashes"');
  });

  test("survives a file with comments (JSONC) — comments are not corrupted", () => {
    const src = `{
  // user comment
  "editor.fontSize": 14
}`;
    const next = setSetting(src, "newKey", "v");
    expect(next).toContain("// user comment");
    expect(next).toContain('"newKey": "v"');
  });
});

describe("removeSetting", () => {
  test("removes a top-level key including its leading comma", () => {
    const src = `{
  "editor.fontSize": 14,
  "claudeCode.claudeProcessWrapper": "/x"
}`;
    const next = removeSetting(src, "claudeCode.claudeProcessWrapper");
    expect(next).not.toContain("claudeProcessWrapper");
    expect(next).toContain('"editor.fontSize": 14');
  });

  test("no-op when key missing", () => {
    const src = `{ "foo": 1 }`;
    expect(removeSetting(src, "bar")).toBe(src);
  });
});
