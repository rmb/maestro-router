// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import {
  HOOK_MARKER,
  addMaestroStopHook,
  removeMaestroStopHook,
} from "./install-hook.js";

const HOOK_PATH = "/home/me/.maestro/hooks/stop-feedback.sh";
const OTHER_PATH = "/usr/local/bin/other-hook.sh";

function parse(json: string): unknown {
  return JSON.parse(json);
}

describe("addMaestroStopHook", () => {
  test("adds full hooks.Stop[0] structure to empty settings", () => {
    const out = addMaestroStopHook("{}", HOOK_PATH);
    const parsed = parse(out) as {
      hooks: { Stop: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
    };
    expect(parsed.hooks).toBeDefined();
    expect(parsed.hooks.Stop).toHaveLength(1);
    expect(parsed.hooks.Stop[0]!.matcher).toBe("");
    expect(parsed.hooks.Stop[0]!.hooks[0]!.command).toContain(HOOK_PATH);
    expect(parsed.hooks.Stop[0]!.hooks[0]!.command).toContain(HOOK_MARKER);
  });

  test("preserves other top-level keys", () => {
    const src = JSON.stringify(
      { theme: "dark", editor: { fontSize: 14 } },
      null,
      2,
    );
    const out = addMaestroStopHook(src, HOOK_PATH);
    const parsed = parse(out) as {
      theme: string;
      editor: { fontSize: number };
      hooks: { Stop: unknown[] };
    };
    expect(parsed.theme).toBe("dark");
    expect(parsed.editor.fontSize).toBe(14);
    expect(parsed.hooks.Stop).toHaveLength(1);
  });

  test("appends to existing Stop array without overwriting other hooks", () => {
    const src = JSON.stringify(
      {
        hooks: {
          Stop: [
            {
              matcher: "",
              hooks: [{ type: "command", command: OTHER_PATH }],
            },
          ],
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "x" }] }],
        },
      },
      null,
      2,
    );
    const out = addMaestroStopHook(src, HOOK_PATH);
    const parsed = parse(out) as {
      hooks: {
        Stop: Array<{ hooks: Array<{ command: string }> }>;
        PreToolUse: unknown[];
      };
    };
    expect(parsed.hooks.Stop).toHaveLength(2);
    expect(parsed.hooks.Stop[0]!.hooks[0]!.command).toBe(OTHER_PATH);
    expect(parsed.hooks.Stop[1]!.hooks[0]!.command).toContain(HOOK_MARKER);
    expect(parsed.hooks.PreToolUse).toHaveLength(1);
  });

  test("is idempotent: re-running yields same content", () => {
    const once = addMaestroStopHook("{}", HOOK_PATH);
    const twice = addMaestroStopHook(once, HOOK_PATH);
    expect(twice).toBe(once);
  });

  test("refreshes path if Maestro entry exists but points elsewhere", () => {
    const stale = addMaestroStopHook("{}", "/old/path/stop-feedback.sh");
    const refreshed = addMaestroStopHook(stale, HOOK_PATH);
    expect(refreshed).not.toBe(stale);
    expect(refreshed).toContain(HOOK_PATH);
    expect(refreshed).not.toContain("/old/path/stop-feedback.sh");
    const parsed = parse(refreshed) as {
      hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> };
    };
    // Still exactly one Maestro entry — not duplicated.
    expect(parsed.hooks.Stop).toHaveLength(1);
  });

  test("handles a settings.json with whitespace / empty content", () => {
    const out = addMaestroStopHook("   \n   ", HOOK_PATH);
    const parsed = parse(out) as { hooks: { Stop: unknown[] } };
    expect(parsed.hooks.Stop).toHaveLength(1);
  });
});

describe("removeMaestroStopHook", () => {
  test("removes only Maestro's entry, leaves other Stop hooks intact", () => {
    const src = JSON.stringify(
      {
        hooks: {
          Stop: [
            {
              matcher: "",
              hooks: [{ type: "command", command: OTHER_PATH }],
            },
            {
              matcher: "",
              hooks: [
                {
                  type: "command",
                  command: `${HOOK_PATH} ${HOOK_MARKER}`,
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    );
    const out = removeMaestroStopHook(src);
    const parsed = parse(out) as {
      hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(parsed.hooks.Stop).toHaveLength(1);
    expect(parsed.hooks.Stop[0]!.hooks[0]!.command).toBe(OTHER_PATH);
  });

  test("removes the Stop array entirely when Maestro was the only entry", () => {
    const src = addMaestroStopHook("{}", HOOK_PATH);
    const out = removeMaestroStopHook(src);
    const parsed = parse(out) as { hooks?: { Stop?: unknown } };
    expect(parsed.hooks?.Stop).toBeUndefined();
  });

  test("no-op when Maestro entry is not present", () => {
    const src = JSON.stringify(
      {
        hooks: {
          Stop: [{ matcher: "", hooks: [{ type: "command", command: OTHER_PATH }] }],
        },
      },
      null,
      2,
    );
    expect(removeMaestroStopHook(src)).toBe(src);
  });

  test("no-op when settings has no hooks block at all", () => {
    const src = JSON.stringify({ theme: "dark" }, null, 2);
    expect(removeMaestroStopHook(src)).toBe(src);
  });
});

describe("install-hook round-trip", () => {
  test("install then uninstall returns to original semantic state", () => {
    const original = JSON.stringify({ theme: "dark" }, null, 2);
    const installed = addMaestroStopHook(original, HOOK_PATH);
    const uninstalled = removeMaestroStopHook(installed);
    // Whitespace may differ, but structure must match.
    expect(parse(uninstalled)).toEqual(parse(original));
  });
});
