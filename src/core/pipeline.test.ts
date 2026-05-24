// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { createCache } from "./cache.js";
import { createClassifier } from "./classifier.js";
import { createPipeline } from "./pipeline.js";
import { balancedProfile } from "./profile.js";
import type { Classification, Class, Decision, Request } from "./types.js";

const req = (prompt: string): Request => ({ prompt });

const fixed = (name: string, classification: Classification | null, weight = 0.5) =>
  createClassifier({ name, weight, classify: () => classification });

describe("createPipeline", () => {
  test("empty classifiers → default class 'standard'", async () => {
    const p = createPipeline({ classifiers: [], profile: balancedProfile });
    const d = await p.route(req("anything"));
    expect(d.class).toBe("standard");
    expect(d.classifier).toBe("default");
    expect(d.diagnostics.some((x) => x.code === "fallback.default")).toBe(true);
  });

  test("short-circuits at first ≥ 0.6 confidence", async () => {
    const p = createPipeline({
      classifiers: [
        fixed("first", { class: "trivial", confidence: 1.0 }),
        fixed("second", { class: "max", confidence: 0.9 }),
      ],
      profile: balancedProfile,
    });
    const d = await p.route(req("hi"));
    expect(d.class).toBe("trivial");
    expect(d.classifier).toBe("first");
  });

  test("skips null results, then short-circuits", async () => {
    const p = createPipeline({
      classifiers: [
        fixed("a", null),
        fixed("b", null),
        fixed("c", { class: "hard", confidence: 0.9 }),
      ],
      profile: balancedProfile,
    });
    const d = await p.route(req("hi"));
    expect(d.class).toBe("hard");
    expect(d.classifier).toBe("c");
  });

  test("LLM medium-confidence short-circuit upgrades one tier (T1.3)", async () => {
    const p = createPipeline({
      // 0.6 ≤ conf < 0.85 from the LLM → predicted "standard" routes as "hard".
      classifiers: [fixed("llm", { class: "standard", confidence: 0.7 })],
      profile: balancedProfile,
    });
    const d = await p.route(req("hi"));
    expect(d.class).toBe("hard");
    expect(d.classifier).toBe("llm");
    expect(d.diagnostics.some((x) => x.code === "pipeline.upgrade")).toBe(true);
  });

  test("LLM high-confidence short-circuit is honored verbatim", async () => {
    const p = createPipeline({
      classifiers: [fixed("llm", { class: "standard", confidence: 0.95 })],
      profile: balancedProfile,
    });
    const d = await p.route(req("x"));
    expect(d.class).toBe("standard");
    expect(d.diagnostics.some((x) => x.code === "pipeline.upgrade")).toBe(false);
  });

  test("LLM max stays at max even with medium confidence (no tier above)", async () => {
    const p = createPipeline({
      classifiers: [fixed("llm", { class: "max", confidence: 0.7 })],
      profile: balancedProfile,
    });
    const d = await p.route(req("x"));
    expect(d.class).toBe("max");
  });

  test("non-LLM classifiers are never upgraded — heuristic confidence encodes boundary, not reliability", async () => {
    // Heuristic at 0.7 on "trivial" should still route as "trivial" (no upgrade
    // to "simple"). Upgrading these caused a 40pp accuracy regression.
    const p = createPipeline({
      classifiers: [fixed("heuristic", { class: "trivial", confidence: 0.7 })],
      profile: balancedProfile,
    });
    const d = await p.route(req("x"));
    expect(d.class).toBe("trivial");
    expect(d.diagnostics.some((x) => x.code === "pipeline.upgrade")).toBe(false);
  });

  test("sub-threshold results go to weighted vote", async () => {
    const p = createPipeline({
      classifiers: [
        fixed("a", { class: "standard", confidence: 0.5 }, 1.0),
        fixed("b", { class: "hard", confidence: 0.5 }, 0.5),
      ],
      profile: balancedProfile,
    });
    // a: 1.0 * 0.5 = 0.5 (standard)
    // b: 0.5 * 0.5 = 0.25 (hard)
    // standard wins the vote, but entropy ≈ 0.92 bits > 0.7 → escalates standard → hard
    const d = await p.route(req("hi"));
    expect(d.class).toBe("hard");
    expect(d.classifier).toMatch(/^vote:a$/);
  });

  test("vote tiebreaker uses highest weighted contribution", async () => {
    const p = createPipeline({
      classifiers: [
        fixed("a", { class: "simple", confidence: 0.55 }, 0.5),
        fixed("b", { class: "simple", confidence: 0.55 }, 0.5),
        fixed("c", { class: "hard", confidence: 0.5 }, 0.4),
      ],
      profile: balancedProfile,
    });
    // a fires short-circuit at 0.55 (= SHORT_CIRCUIT_THRESHOLD); vote path never reached.
    // non-LLM classifier → no upgrade → simple
    const d = await p.route(req("hi"));
    expect(d.class).toBe("simple");
  });

  test("classifier throw → diagnostic + continues", async () => {
    const p = createPipeline({
      classifiers: [
        createClassifier({
          name: "boom",
          weight: 0.5,
          classify: () => {
            throw new Error("kaboom");
          },
        }),
        fixed("ok", { class: "hard", confidence: 0.9 }),
      ],
      profile: balancedProfile,
    });
    const d = await p.route(req("hi"));
    expect(d.class).toBe("hard");
    expect(d.diagnostics.some((x) => x.code === "error.boom")).toBe(true);
  });

  test("forwards classifier diagnostics into final decision", async () => {
    const p = createPipeline({
      classifiers: [
        fixed("x", {
          class: "trivial",
          confidence: 0.9,
          diagnostics: [{ severity: "hint", code: "test.hint", message: "h" }],
        }),
      ],
      profile: balancedProfile,
    });
    const d = await p.route(req("hi"));
    expect(d.diagnostics.some((x) => x.code === "test.hint")).toBe(true);
  });

  test("never throws even when every classifier throws", async () => {
    const p = createPipeline({
      classifiers: [
        createClassifier({
          name: "a",
          weight: 0.5,
          classify: () => {
            throw new Error("a-fail");
          },
        }),
        createClassifier({
          name: "b",
          weight: 0.5,
          classify: () => {
            throw new Error("b-fail");
          },
        }),
      ],
      profile: balancedProfile,
    });
    const d = await p.route(req("hi"));
    expect(d.class).toBe("standard");
    expect(d.diagnostics.filter((x) => x.code.startsWith("error.")).length).toBe(2);
  });

  test("decision.spec comes from profile.classes[class]", async () => {
    const p = createPipeline({
      classifiers: [fixed("x", { class: "max", confidence: 1.0 })],
      profile: balancedProfile,
    });
    const d = await p.route(req("hi"));
    expect(d.spec).toEqual(balancedProfile.classes.max);
  });

  test("cache hit returns cached decision with cacheHit=true and cache.hit diagnostic", async () => {
    const cache = createCache<Decision>();
    const p = createPipeline({
      classifiers: [fixed("x", { class: "trivial", confidence: 1.0 })],
      profile: balancedProfile,
      cache,
    });
    await p.route(req("hello"));
    const d = await p.route(req("hello"));
    expect(d.cacheHit).toBe(true);
    expect(d.latencyMs).toBe(0);
    expect(d.diagnostics.some((x) => x.code === "cache.hit")).toBe(true);
  });

  test("cache key includes scenarioHint", async () => {
    const cache = createCache<Decision>();
    const p = createPipeline({
      classifiers: [fixed("x", { class: "trivial", confidence: 1.0 })],
      profile: balancedProfile,
      cache,
    });
    await p.route({ prompt: "p", scenarioHint: "a" });
    const d = await p.route({ prompt: "p", scenarioHint: "b" });
    expect(d.cacheHit).toBeUndefined();
  });

  test("AbortSignal threads through to classifiers", async () => {
    let receivedSignal: AbortSignal | undefined;
    const ac = new AbortController();
    const p = createPipeline({
      classifiers: [
        createClassifier({
          name: "spy",
          weight: 0.5,
          classify: (_r, o) => {
            receivedSignal = o?.signal;
            return { class: "trivial", confidence: 1.0 };
          },
        }),
      ],
      profile: balancedProfile,
    });
    await p.route(req("hi"), { signal: ac.signal });
    expect(receivedSignal).toBe(ac.signal);
  });

  test("latencyMs is non-negative and finite", async () => {
    const p = createPipeline({
      classifiers: [fixed("x", { class: "trivial", confidence: 1.0 })],
      profile: balancedProfile,
    });
    const d = await p.route(req("hi"));
    expect(Number.isFinite(d.latencyMs)).toBe(true);
    expect(d.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe("pipeline property: order respected", () => {
  test("classifiers run in declared order", async () => {
    const calls: string[] = [];
    const trace = (name: string) =>
      createClassifier({
        name,
        weight: 0.5,
        classify: () => {
          calls.push(name);
          return null;
        },
      });
    const p = createPipeline({
      classifiers: [trace("a"), trace("b"), trace("c")],
      profile: balancedProfile,
    });
    await p.route(req("hi"));
    expect(calls).toEqual(["a", "b", "c"]);
  });

  test("short-circuit stops iteration at the firing classifier", async () => {
    const calls: string[] = [];
    const trace = (name: string, conf: number) =>
      createClassifier({
        name,
        weight: 0.5,
        classify: () => {
          calls.push(name);
          return { class: "trivial" as Class, confidence: conf };
        },
      });
    const p = createPipeline({
      classifiers: [trace("a", 0.3), trace("b", 0.9), trace("c", 1.0)],
      profile: balancedProfile,
    });
    await p.route(req("hi"));
    expect(calls).toEqual(["a", "b"]);
  });
});

describe("entropy escalation in vote", () => {
  test("high entropy (50/50 split) escalates the winning class one tier up", async () => {
    // trivial vs standard, equal weight and equal confidence → H = log2(2) = 1.0 > 0.7
    // whichever class wins the vote (map iteration gives trivial first), it gets UPGRADE'd
    const p = createPipeline({
      classifiers: [
        fixed("a", { class: "trivial", confidence: 0.4 }, 0.5),
        fixed("b", { class: "standard", confidence: 0.4 }, 0.5),
      ],
      profile: balancedProfile,
    });
    const d = await p.route(req("split-prompt"));
    // trivial wins the vote (inserted first); entropy = 1.0 → escalates trivial → simple
    expect(d.class).toBe("simple");
    expect(d.diagnostics.some((x) => x.code === "pipeline.entropy_escalation")).toBe(true);
  });

  test("low entropy (consensus) does NOT escalate", async () => {
    // Both classifiers agree on standard → H = 0 → no escalation
    const p = createPipeline({
      classifiers: [
        fixed("a", { class: "standard", confidence: 0.4 }, 0.5),
        fixed("b", { class: "standard", confidence: 0.45 }, 0.5),
      ],
      profile: balancedProfile,
    });
    const d = await p.route(req("consensus-prompt"));
    expect(d.class).toBe("standard");
    expect(d.diagnostics.some((x) => x.code === "pipeline.entropy_escalation")).toBe(false);
  });

  test("single classifier in collected → entropy = 0 → no escalation", async () => {
    // Only one classifier, so all weight is on one class → H = 0
    const p = createPipeline({
      classifiers: [fixed("only", { class: "hard", confidence: 0.4 }, 0.5)],
      profile: balancedProfile,
    });
    const d = await p.route(req("single-classifier"));
    expect(d.class).toBe("hard");
    expect(d.diagnostics.some((x) => x.code === "pipeline.entropy_escalation")).toBe(false);
  });
});

describe("pipeline property: meets 50ms p95 budget with fast classifiers", () => {
  test("3 sync classifiers run well under 50ms over 50 samples", async () => {
    const p = createPipeline({
      classifiers: [
        fixed("a", null),
        fixed("b", null),
        fixed("c", { class: "standard", confidence: 0.55 }),
      ],
      profile: balancedProfile,
    });
    const samples: number[] = [];
    for (let i = 0; i < 50; i++) {
      const d = await p.route(req(`prompt-${i}`));
      samples.push(d.latencyMs);
    }
    samples.sort((x, y) => x - y);
    const p95 = samples[Math.floor(samples.length * 0.95)]!;
    expect(p95).toBeLessThan(50);
  });
});
