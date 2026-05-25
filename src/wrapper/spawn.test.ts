// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { buildClaudeArgs, spawnClaude } from "./spawn.js";
import { balancedProfile } from "../core/profile.js";
import type { Decision, Diagnostic, UserConfig } from "../core/types.js";

const baseDecision = (
  cls: keyof typeof balancedProfile.classes,
  diagnostics: Diagnostic[] = [],
): Decision => ({
  class: cls,
  classifier: "test",
  confidence: 1.0,
  spec: balancedProfile.classes[cls],
  latencyMs: 0,
  diagnostics,
});

const emptyConfig: UserConfig = {};

describe("buildClaudeArgs — base shape", () => {
  test("always includes --print --output-format json", () => {
    const args = buildClaudeArgs({
      decision: baseDecision("standard"),
      userConfig: emptyConfig,
      sessionId: "abc",
      isResume: false,
    });
    expect(args).toContain("--print");
    expect(args).toContain("--output-format");
    expect(args[args.indexOf("--output-format") + 1]).toBe("json");
  });

  test("uses --session-id when isResume=false", () => {
    const args = buildClaudeArgs({
      decision: baseDecision("standard"),
      userConfig: emptyConfig,
      sessionId: "abc-123",
      isResume: false,
    });
    expect(args).toContain("--session-id");
    expect(args[args.indexOf("--session-id") + 1]).toBe("abc-123");
    expect(args).not.toContain("--resume");
  });

  test("uses --resume when isResume=true", () => {
    const args = buildClaudeArgs({
      decision: baseDecision("standard"),
      userConfig: emptyConfig,
      sessionId: "abc-123",
      isResume: true,
    });
    expect(args).toContain("--resume");
    expect(args[args.indexOf("--resume") + 1]).toBe("abc-123");
    expect(args).not.toContain("--session-id");
  });

  test("includes --model, --effort, --max-budget-usd from spec", () => {
    const args = buildClaudeArgs({
      decision: baseDecision("hard"),
      userConfig: emptyConfig,
      sessionId: "x",
      isResume: false,
    });
    expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
    expect(args[args.indexOf("--effort") + 1]).toBe("high");
    expect(args[args.indexOf("--max-budget-usd") + 1]).toBe("3");
  });
});

describe("buildClaudeArgs — S7 excludeDynamicSections", () => {
  test("defaults to enabling --exclude-dynamic-system-prompt-sections", () => {
    const args = buildClaudeArgs({
      decision: baseDecision("standard"),
      userConfig: emptyConfig,
      sessionId: "x",
      isResume: false,
    });
    expect(args).toContain("--exclude-dynamic-system-prompt-sections");
  });

  test("respects userConfig.excludeDynamicSections=false", () => {
    const args = buildClaudeArgs({
      decision: baseDecision("standard"),
      userConfig: { excludeDynamicSections: false },
      sessionId: "x",
      isResume: false,
    });
    expect(args).not.toContain("--exclude-dynamic-system-prompt-sections");
  });

  test("per-class explicit overrides global", () => {
    const decision = {
      ...baseDecision("standard"),
      spec: { ...balancedProfile.classes.standard, excludeDynamicSections: false },
    };
    const args = buildClaudeArgs({
      decision,
      userConfig: { excludeDynamicSections: true },
      sessionId: "x",
      isResume: false,
    });
    expect(args).not.toContain("--exclude-dynamic-system-prompt-sections");
  });
});

describe("buildClaudeArgs — S8 tools", () => {
  test("includes --tools when restricted", () => {
    // trivial in balanced profile sets tools: "Read,Edit"
    const args = buildClaudeArgs({
      decision: baseDecision("trivial"),
      userConfig: emptyConfig,
      sessionId: "x",
      isResume: false,
    });
    expect(args).toContain("--tools");
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Edit");
  });

  test("omits --tools when value is 'default'", () => {
    // standard in balanced profile sets tools: "default"
    const args = buildClaudeArgs({
      decision: baseDecision("standard"),
      userConfig: emptyConfig,
      sessionId: "x",
      isResume: false,
    });
    expect(args).not.toContain("--tools");
  });
});

describe("buildClaudeArgs — S9 MCP isolation", () => {
  test("includes --strict-mcp-config --mcp-config when mcpConfig set", () => {
    const args = buildClaudeArgs({
      decision: baseDecision("trivial"),
      userConfig: emptyConfig,
      sessionId: "x",
      isResume: false,
    });
    expect(args).toContain("--strict-mcp-config");
    const mcpIdx = args.indexOf("--mcp-config");
    expect(args[mcpIdx + 1]).toBe('{"mcpServers":{}}');
  });

  test("omits MCP flags when mcpConfig undefined", () => {
    const args = buildClaudeArgs({
      decision: baseDecision("standard"),
      userConfig: emptyConfig,
      sessionId: "x",
      isResume: false,
    });
    expect(args).not.toContain("--strict-mcp-config");
    expect(args).not.toContain("--mcp-config");
  });
});

describe("buildClaudeArgs — S6 --bare", () => {
  test("includes --bare when class supports bare AND bare_safe AND not disabled AND bareSupported", () => {
    const decision = baseDecision("trivial", [
      { severity: "info", code: "heuristic.bare_safe", message: "" },
    ]);
    const args = buildClaudeArgs({
      decision,
      userConfig: emptyConfig,
      sessionId: "x",
      isResume: false,
      bareSupported: true,
    });
    expect(args).toContain("--bare");
  });

  test("omits --bare when bareSupported is false (OAuth auth)", () => {
    const decision = baseDecision("trivial", [
      { severity: "info", code: "heuristic.bare_safe", message: "" },
    ]);
    const args = buildClaudeArgs({
      decision,
      userConfig: emptyConfig,
      sessionId: "x",
      isResume: false,
      bareSupported: false,
    });
    expect(args).not.toContain("--bare");
  });

  test("omits --bare when bareSupported is undefined (default)", () => {
    const decision = baseDecision("trivial", [
      { severity: "info", code: "heuristic.bare_safe", message: "" },
    ]);
    const args = buildClaudeArgs({
      decision,
      userConfig: emptyConfig,
      sessionId: "x",
      isResume: false,
    });
    expect(args).not.toContain("--bare");
  });

  test("omits --bare when bare_safe diagnostic absent", () => {
    const decision = baseDecision("trivial");
    const args = buildClaudeArgs({
      decision,
      userConfig: emptyConfig,
      sessionId: "x",
      isResume: false,
    });
    expect(args).not.toContain("--bare");
  });

  test("omits --bare when override.disable_bare present (S6 escape)", () => {
    const decision = baseDecision("trivial", [
      { severity: "info", code: "heuristic.bare_safe", message: "" },
      { severity: "info", code: "override.disable_bare", message: "" },
    ]);
    const args = buildClaudeArgs({
      decision,
      userConfig: emptyConfig,
      sessionId: "x",
      isResume: false,
      bareSupported: true,
    });
    expect(args).not.toContain("--bare");
  });

  test("omits --bare for classes without spec.bare=true", () => {
    const decision = baseDecision("standard", [
      { severity: "info", code: "heuristic.bare_safe", message: "" },
    ]);
    const args = buildClaudeArgs({
      decision,
      userConfig: emptyConfig,
      sessionId: "x",
      isResume: false,
      bareSupported: true,
    });
    expect(args).not.toContain("--bare");
  });
});

describe("buildClaudeArgs — X.soft appendSystemPrompt", () => {
  test("trivial class gets terse output-only hint", () => {
    const args = buildClaudeArgs({
      decision: baseDecision("trivial"),
      userConfig: emptyConfig,
      sessionId: "x",
      isResume: false,
    });
    const idx = args.indexOf("--append-system-prompt");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("Output only the answer. No explanation. No formatting.");
  });

  test("simple class gets concise hint", () => {
    const args = buildClaudeArgs({
      decision: baseDecision("simple"),
      userConfig: emptyConfig,
      sessionId: "x",
      isResume: false,
    });
    const idx = args.indexOf("--append-system-prompt");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("Be concise. Skip preamble.");
  });

  test("standard class gets explicit 4000-token brevity hint", () => {
    const args = buildClaudeArgs({
      decision: baseDecision("standard"),
      userConfig: emptyConfig,
      sessionId: "x",
      isResume: false,
    });
    const idx = args.indexOf("--append-system-prompt");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toContain("under 4000 tokens");
  });

  test("hard class emits cap hint via maxOutputTokens in balanced profile", () => {
    const args = buildClaudeArgs({
      decision: baseDecision("hard"),
      userConfig: emptyConfig,
      sessionId: "x",
      isResume: false,
    });
    const idx = args.indexOf("--append-system-prompt");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toContain("4000 tokens");
  });

  test("reasoning class emits cap hint via maxOutputTokens in balanced profile", () => {
    const args = buildClaudeArgs({
      decision: baseDecision("reasoning"),
      userConfig: emptyConfig,
      sessionId: "x",
      isResume: false,
    });
    const idx = args.indexOf("--append-system-prompt");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toContain("6000 tokens");
  });

  test("max class emits no --append-system-prompt", () => {
    const args = buildClaudeArgs({
      decision: baseDecision("max"),
      userConfig: emptyConfig,
      sessionId: "x",
      isResume: false,
    });
    expect(args).not.toContain("--append-system-prompt");
  });

  test("per-class spec.appendSystemPrompt wins over class hint", () => {
    const decision = {
      ...baseDecision("trivial"),
      spec: { ...balancedProfile.classes.trivial, appendSystemPrompt: "custom hint" },
    };
    const args = buildClaudeArgs({
      decision,
      userConfig: emptyConfig,
      sessionId: "x",
      isResume: false,
    });
    const idx = args.indexOf("--append-system-prompt");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("custom hint");
  });

  test("standard class hint wins over userConfig.appendSystemPrompt", () => {
    // standard now has an explicit CLASS_BREVITY entry, so the class hint
    // takes precedence over userConfig.appendSystemPrompt — same resolution
    // order as every other class.
    const args = buildClaudeArgs({
      decision: baseDecision("standard"),
      userConfig: { appendSystemPrompt: "user default" },
      sessionId: "x",
      isResume: false,
    });
    const idx = args.indexOf("--append-system-prompt");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toContain("under 4000 tokens");
  });

  test("spec.appendSystemPrompt empty string suppresses flag even for trivial", () => {
    const decision = {
      ...baseDecision("trivial"),
      spec: { ...balancedProfile.classes.trivial, appendSystemPrompt: "" },
    };
    const args = buildClaudeArgs({
      decision,
      userConfig: emptyConfig,
      sessionId: "x",
      isResume: false,
    });
    expect(args).not.toContain("--append-system-prompt");
  });

  test("G2: when maxOutputTokens is set and CLASS_BREVITY is empty, append cap hint for hard class", () => {
    // hard class has empty string in CLASS_BREVITY, but with maxOutputTokens set,
    // we should emit a cap hint
    const decision = baseDecision("hard");
    const args = buildClaudeArgs({
      decision,
      userConfig: emptyConfig,
      sessionId: "x",
      isResume: false,
    });
    const idx = args.indexOf("--append-system-prompt");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toContain("4000 tokens");
  });

  test("G2: when maxOutputTokens is set and CLASS_BREVITY is empty, append cap hint for reasoning class", () => {
    // reasoning class has empty string in CLASS_BREVITY, but with maxOutputTokens set,
    // we should emit a cap hint
    const decision = baseDecision("reasoning");
    const args = buildClaudeArgs({
      decision,
      userConfig: emptyConfig,
      sessionId: "x",
      isResume: false,
    });
    const idx = args.indexOf("--append-system-prompt");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toContain("6000 tokens");
  });

  test("G2: when maxOutputTokens is set and CLASS_BREVITY is empty, append cap hint for max class", () => {
    // max class has empty string in CLASS_BREVITY and no maxOutputTokens,
    // so it should remain suppressed (no flag)
    const decision = baseDecision("max");
    const args = buildClaudeArgs({
      decision,
      userConfig: emptyConfig,
      sessionId: "x",
      isResume: false,
    });
    expect(args).not.toContain("--append-system-prompt");
  });
});

describe("spawnClaude", () => {
  test("captures stdout from a fake binary", async () => {
    const result = await spawnClaude({
      binary: "node",
      args: ["-e", "process.stdin.on('data', d => process.stdout.write(d))"],
      prompt: "hello world",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello world");
  });

  test("captures non-zero exit code without rejecting", async () => {
    const result = await spawnClaude({
      binary: "node",
      args: ["-e", "process.exit(7)"],
      prompt: "",
    });
    expect(result.exitCode).toBe(7);
  });

  test("captures stderr separately", async () => {
    const result = await spawnClaude({
      binary: "node",
      args: ["-e", "process.stderr.write('oops')"],
      prompt: "",
    });
    expect(result.stderr).toBe("oops");
    expect(result.stdout).toBe("");
  });

  test("rejects when binary is missing", async () => {
    await expect(
      spawnClaude({
        binary: "/definitely-not-a-real-binary-aiosjdf",
        args: [],
        prompt: "",
      }),
    ).rejects.toBeInstanceOf(Error);
  });

  test("honors AbortSignal", async () => {
    const ac = new AbortController();
    const promise = spawnClaude({
      binary: "node",
      args: ["-e", "setTimeout(() => {}, 30000)"],
      prompt: "",
      signal: ac.signal,
    });
    // Abort after a tick so the process is running
    setTimeout(() => ac.abort(), 50);
    const result = await promise;
    expect(result.exitCode).not.toBe(0);
  });

  test("respects pre-aborted signal", async () => {
    const ac = new AbortController();
    ac.abort();
    const result = await spawnClaude({
      binary: "node",
      args: ["-e", "setTimeout(() => {}, 10000)"],
      prompt: "",
      signal: ac.signal,
    });
    expect(result.exitCode).not.toBe(0);
  });
});
