// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUILTIN_RULES,
  createHeuristicClassifier,
  heuristicClassifier,
  loadUserHeuristics,
} from "./heuristic.js";
import type { HeuristicRule, Request } from "../core/types.js";

const ask = (prompt: string): Promise<unknown> =>
  Promise.resolve(heuristicClassifier.classify({ prompt }));

describe("heuristic classifier — built-in trivial fast-path", () => {
  test("'prettier' alone → trivial 1.0 with bare_safe", async () => {
    const r = (await ask("prettier")) as { class: string; confidence: number; diagnostics: { code: string }[] };
    expect(r.class).toBe("trivial");
    expect(r.confidence).toBe(1.0);
    expect(r.diagnostics.map((d) => d.code)).toContain("heuristic.bare_safe");
  });

  test("'eslint' alone → trivial 1.0 with bare_safe", async () => {
    const r = (await ask("eslint")) as { confidence: number };
    expect(r.confidence).toBe(1.0);
  });

  test("'git status' → trivial 1.0 with bare_safe", async () => {
    const r = (await ask("git status")) as { class: string; diagnostics: { code: string }[] };
    expect(r.class).toBe("trivial");
    expect(r.diagnostics.map((d) => d.code)).toContain("heuristic.bare_safe");
  });

  test("'git diff' → trivial 1.0", async () => {
    const r = (await ask("git diff")) as { class: string };
    expect(r.class).toBe("trivial");
  });

  test("'git push origin main' does NOT match fast-path (confidence < 1.0)", async () => {
    const r = (await ask("git push origin main")) as { confidence: number } | null;
    // git push is trivial but not bareSafe (side-effectful), so < 1.0
    expect(r === null || r.confidence < 1.0).toBe(true);
  });

  test("'git commit -m msg' → trivial (non-bareSafe)", async () => {
    const r = (await ask("git commit -m 'fix: typo'")) as { class: string; confidence: number } | null;
    expect(r?.class).toBe("trivial");
    expect(r?.confidence).toBeLessThan(1.0);
  });

  test("'rename foo' → trivial 1.0 fast-path", async () => {
    const r = (await ask("rename foo")) as { class: string; confidence: number };
    expect(r.class).toBe("trivial");
    expect(r.confidence).toBe(1.0);
  });

  test("'format file.ts' → trivial 1.0 fast-path", async () => {
    const r = (await ask("format file.ts")) as { confidence: number };
    expect(r.confidence).toBe(1.0);
  });

  test("'lint src' → trivial 1.0 fast-path", async () => {
    const r = (await ask("lint src")) as { confidence: number };
    expect(r.confidence).toBe(1.0);
  });

  test("prettier with shell chain does NOT match fast-path", async () => {
    const r = (await ask("prettier && git push")) as { confidence: number } | null;
    expect(r === null || r.confidence < 1.0).toBe(true);
  });
});

describe("heuristic classifier — non-fast-path matches", () => {
  test("'add a typo fix to line 42' → trivial sub-1.0", async () => {
    const r = (await ask("add a typo fix to line 42")) as { class: string; confidence: number };
    expect(r.class).toBe("trivial");
    expect(r.confidence).toBeLessThan(1.0);
  });

  test("'update the error message wording' → simple", async () => {
    const r = (await ask("update the error message wording")) as { class: string };
    expect(r.class).toBe("simple");
  });

  test("'this test is flaky, find out why' → hard", async () => {
    const r = (await ask("this test is flaky, find out why")) as { class: string };
    expect(r.class).toBe("hard");
  });

  test("'refactor this 800-line file into modules' → hard", async () => {
    const r = (await ask("refactor this 800-line file into modules")) as { class: string };
    expect(r.class).toBe("hard");
  });

  test("'design a caching layer for our auth service' → reasoning", async () => {
    const r = (await ask("design a caching layer for our auth service")) as { class: string };
    expect(r.class).toBe("reasoning");
  });

  test("'should we move from REST to GraphQL?' → reasoning", async () => {
    const r = (await ask("should we move from REST to GraphQL?")) as { class: string };
    expect(r.class).toBe("reasoning");
  });

  test("'production is down, here are the logs' → max", async () => {
    const r = (await ask("production is down, here are the logs")) as { class: string };
    expect(r.class).toBe("max");
  });

  test("'memory leak we cannot reproduce locally' → max", async () => {
    const r = (await ask("memory leak we cannot reproduce locally")) as { class: string };
    expect(r.class).toBe("max");
  });

  test("'bump the version to 1.2.3' → trivial", async () => {
    const r = (await ask("bump the version to 1.2.3")) as { class: string };
    expect(r.class).toBe("trivial");
  });

  test("'add node_modules to .gitignore' → trivial", async () => {
    const r = (await ask("add node_modules to .gitignore")) as { class: string };
    expect(r.class).toBe("trivial");
  });

  test("'write a unit test for parseDate' → simple", async () => {
    const r = (await ask("write a unit test for parseDate")) as { class: string };
    expect(r.class).toBe("simple");
  });

  test("'add error handling to the fetch call' → simple", async () => {
    const r = (await ask("add error handling to the fetch call")) as { class: string };
    expect(r.class).toBe("simple");
  });

  test("'remove unused imports from this file' → simple", async () => {
    const r = (await ask("remove unused imports from this file")) as { class: string };
    expect(r.class).toBe("simple");
  });

  test("'extract this into a helper function' → simple", async () => {
    const r = (await ask("extract this into a helper function")) as { class: string };
    expect(r.class).toBe("simple");
  });

  test("'sort imports' → trivial 1.0 bareSafe", async () => {
    const r = (await ask("sort imports")) as { class: string; confidence: number; diagnostics: { code: string }[] };
    expect(r.class).toBe("trivial");
    expect(r.confidence).toBe(1.0);
    expect(r.diagnostics.map((d) => d.code)).toContain("heuristic.bare_safe");
  });

  test("'organize imports' → trivial 1.0 bareSafe", async () => {
    const r = (await ask("organize imports")) as { class: string; confidence: number };
    expect(r.class).toBe("trivial");
    expect(r.confidence).toBe(1.0);
  });

  test("'remove unused imports' → trivial 1.0 bareSafe", async () => {
    const r = (await ask("remove unused imports")) as { class: string; confidence: number; diagnostics: { code: string }[] };
    expect(r.class).toBe("trivial");
    expect(r.confidence).toBe(1.0);
    expect(r.diagnostics.map((d) => d.code)).toContain("heuristic.bare_safe");
  });

  test("'remove all unused imports' → trivial 1.0 bareSafe", async () => {
    const r = (await ask("remove all unused imports")) as { class: string; confidence: number };
    expect(r.class).toBe("trivial");
    expect(r.confidence).toBe(1.0);
  });

  test("'there's a bug in the auth handler' → hard", async () => {
    const r = (await ask("there's a bug in the auth handler")) as { class: string };
    expect(r.class).toBe("hard");
  });

  test("'I found a bug in the parser' → hard", async () => {
    const r = (await ask("I found a bug in the parser")) as { class: string };
    expect(r.class).toBe("hard");
  });

  test("'speed up the database queries' → hard", async () => {
    const r = (await ask("speed up the database queries")) as { class: string };
    expect(r.class).toBe("hard");
  });

  test("'improve performance of the search API' → hard", async () => {
    const r = (await ask("improve performance of the search API")) as { class: string };
    expect(r.class).toBe("hard");
  });

  test("'the tests are failing in CI' → hard", async () => {
    const r = (await ask("the tests are failing in CI")) as { class: string };
    expect(r.class).toBe("hard");
  });

  test("'why does the fetch call not work in production?' → hard", async () => {
    const r = (await ask("why does the fetch call not work in production?")) as { class: string };
    expect(r.class).toBe("hard");
  });

  test("'what are the tradeoffs between REST and gRPC?' → reasoning", async () => {
    const r = (await ask("what are the tradeoffs between REST and gRPC?")) as { class: string };
    expect(r.class).toBe("reasoning");
  });

  test("'what is the best approach to cache invalidation?' → reasoning", async () => {
    const r = (await ask("what is the best approach to cache invalidation?")) as { class: string };
    expect(r.class).toBe("reasoning");
  });

  test("returns null when no rule matches", async () => {
    const r = await ask("hello there general kenobi");
    expect(r).toBeNull();
  });
});

describe("heuristic classifier — size policy", () => {
  test("prompt > 50k chars → standard 0.7 with longcontext diagnostic", async () => {
    const long = "x ".repeat(30_000);
    const r = (await ask(long)) as { class: string; confidence: number; diagnostics: { code: string }[] };
    expect(r.class).toBe("standard");
    expect(r.confidence).toBe(0.7);
    expect(r.diagnostics.map((d) => d.code)).toContain("size.longcontext");
  });

  test("prompt > 15k but ≤ 50k chars → standard 0.65 with mediumcontext diagnostic", async () => {
    const medium = "y ".repeat(9_000); // ~18k chars, no pattern
    const r = (await ask(medium)) as { class: string; confidence: number; diagnostics: { code: string }[] };
    expect(r.class).toBe("standard");
    expect(r.confidence).toBe(0.65);
    expect(r.diagnostics.map((d) => d.code)).toContain("size.mediumcontext");
  });

  test("fast-path pattern (confidence 1.0) beats size check on large prompts", async () => {
    const rule: HeuristicRule = { pattern: "\\bfrobnicate\\b", class: "trivial", confidence: 1.0, source: "builtin", bareSafe: true };
    const c = createHeuristicClassifier({ rules: [rule] });
    const long = "frobnicate " + "x ".repeat(30_000);
    const r = (await c.classify({ prompt: long })) as { class: string; confidence: number };
    expect(r.class).toBe("trivial");
    expect(r.confidence).toBe(1.0);
  });

  test("prompt ≤ 15k chars uses normal rules", async () => {
    const r = (await ask("rename foo")) as { class: string };
    expect(r.class).toBe("trivial");
  });
});

describe("createHeuristicClassifier — user rules", () => {
  test("user rule appended via extraRules can match", async () => {
    const userRule: HeuristicRule = {
      pattern: "frobnicate",
      class: "max",
      confidence: 0.95,
      source: "manual",
    };
    const c = createHeuristicClassifier({ extraRules: [userRule] });
    const r = (await c.classify({ prompt: "frobnicate the doohickey" })) as { class: string };
    expect(r.class).toBe("max");
  });

  test("user rule without bareSafe does NOT emit bare_safe diagnostic", async () => {
    const userRule: HeuristicRule = {
      pattern: "specialword",
      class: "trivial",
      confidence: 0.95,
      source: "manual",
    };
    const c = createHeuristicClassifier({ rules: [userRule] });
    const r = (await c.classify({ prompt: "specialword now" })) as { diagnostics: { code: string }[] };
    expect(r.diagnostics.map((d) => d.code)).not.toContain("heuristic.bare_safe");
  });

  test("user rule with explicit bareSafe: true DOES emit bare_safe", async () => {
    const userRule: HeuristicRule = {
      pattern: "specialword",
      class: "trivial",
      confidence: 0.95,
      source: "manual",
      bareSafe: true,
    };
    const c = createHeuristicClassifier({ rules: [userRule] });
    const r = (await c.classify({ prompt: "specialword now" })) as { diagnostics: { code: string }[] };
    expect(r.diagnostics.map((d) => d.code)).toContain("heuristic.bare_safe");
  });

  test("empty rules → always returns null on small prompts", async () => {
    const c = createHeuristicClassifier({ rules: [] });
    const r = await c.classify({ prompt: "anything" } as Request);
    expect(r).toBeNull();
  });
});

describe("BUILTIN_RULES", () => {
  test("every rule has known class and valid confidence", () => {
    for (const r of BUILTIN_RULES) {
      expect(["trivial", "simple", "standard", "hard", "reasoning", "max"]).toContain(r.class);
      expect(r.confidence).toBeGreaterThanOrEqual(0);
      expect(r.confidence).toBeLessThanOrEqual(1);
    }
  });

  test("every fast-path rule (confidence 1.0) is bareSafe and built-in", () => {
    const fastPath = BUILTIN_RULES.filter((r) => r.confidence >= 1.0);
    expect(fastPath.length).toBeGreaterThan(0);
    for (const r of fastPath) {
      expect(r.bareSafe).toBe(true);
      expect(r.source).toBe("builtin");
    }
  });

  test("every pattern compiles", () => {
    for (const r of BUILTIN_RULES) {
      expect(() => new RegExp(r.pattern, r.flags ?? "i")).not.toThrow();
    }
  });
});

describe("loadUserHeuristics", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "maestro-heur-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("returns [] when file missing", async () => {
    expect(await loadUserHeuristics(join(dir, "nope.json"))).toEqual([]);
  });

  test("parses a valid JSON array", async () => {
    const path = join(dir, "h.json");
    await writeFile(
      path,
      JSON.stringify([
        { pattern: "foo", class: "trivial", confidence: 0.9, source: "manual" },
      ]),
    );
    const rules = await loadUserHeuristics(path);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.pattern).toBe("foo");
  });

  test("filters invalid entries silently", async () => {
    const path = join(dir, "h.json");
    await writeFile(
      path,
      JSON.stringify([
        { pattern: "ok", class: "trivial", confidence: 0.9 },
        { class: "trivial", confidence: 0.9 }, // missing pattern
        { pattern: "x", class: "garbage", confidence: 0.9 }, // bad class
        { pattern: "y", class: "trivial", confidence: 2 }, // out-of-range
        "string entry",
      ]),
    );
    const rules = await loadUserHeuristics(path);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.pattern).toBe("ok");
  });

  test("returns [] when file is not an array", async () => {
    const path = join(dir, "h.json");
    await writeFile(path, JSON.stringify({ not: "array" }));
    expect(await loadUserHeuristics(path)).toEqual([]);
  });
});
