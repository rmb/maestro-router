// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Classification, Diagnostic } from "../core/types.js";
import {
  EmbeddingPeerMissingError,
  computeSeedsChecksum,
  cosineSimilarity,
  createEmbeddingClassifier,
  needsQueryPrefix,
  type EmbedFn,
} from "./embedding.js";
import { EXEMPLAR_SEEDS } from "./exemplars-seeds.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "maestro-embed-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeSink(): { sink: (d: Diagnostic) => void; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  return { sink: (d) => diagnostics.push(d), diagnostics };
}

/**
 * Write a minimal exemplars file referencing a subset of the real
 * EXEMPLAR_SEEDS. The seedsChecksum is computed over the FULL seed list (not
 * the subset) because the runtime classifier validates against the full
 * EXEMPLAR_SEEDS — the on-disk vectors don't have to cover every seed for
 * the file to be considered "fresh".
 */
async function writeExemplarsFile(
  path: string,
  vectors: Array<{ class: string; prompt: string; embedding: number[] }>,
  overrides: { checksum?: string; version?: string; model?: string } = {},
): Promise<void> {
  const file = {
    version: overrides.version ?? "1.0.0",
    model: overrides.model ?? "Xenova/all-MiniLM-L6-v2",
    seedsChecksum: overrides.checksum ?? computeSeedsChecksum(),
    vectors,
  };
  await writeFile(path, JSON.stringify(file), "utf8");
}

/** Build a deterministic embed function returning the requested vector. */
function fixedEmbed(vec: number[]): EmbedFn {
  return async () => Float32Array.from(vec);
}

/** Write a SetFit head JSON to the tmpDir. `head` is written verbatim. */
async function writeHeadFile(path: string, head: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(head), "utf8");
}

describe("cosineSimilarity", () => {
  test("identical unit vectors → 1.0", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBe(1);
  });
  test("orthogonal vectors → 0", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });
  test("opposite vectors → -1", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBe(-1);
  });
  test("zero vector → 0 (avoids NaN)", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe("computeSeedsChecksum", () => {
  test("is deterministic", () => {
    expect(computeSeedsChecksum()).toBe(computeSeedsChecksum());
  });
  test("is a 64-char hex string (sha256)", () => {
    const c = computeSeedsChecksum();
    expect(c).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("needsQueryPrefix", () => {
  test("true for bge family", () => {
    expect(needsQueryPrefix("Xenova/bge-small-en-v1.5")).toBe(true);
    expect(needsQueryPrefix("BAAI/bge-large-en")).toBe(true);
    expect(needsQueryPrefix("bge-base")).toBe(true);
  });
  test("true for e5 family", () => {
    expect(needsQueryPrefix("intfloat/e5-small-v2")).toBe(true);
    expect(needsQueryPrefix("intfloat/multilingual-e5-large")).toBe(true);
    expect(needsQueryPrefix("some/large-e5")).toBe(true);
  });
  test("false for MiniLM (the default)", () => {
    expect(needsQueryPrefix("Xenova/all-MiniLM-L6-v2")).toBe(false);
  });
  test("false for gte — must not match e5", () => {
    expect(needsQueryPrefix("Xenova/gte-small")).toBe(false);
    expect(needsQueryPrefix("thenlper/gte-base")).toBe(false);
  });
  test("case-insensitive", () => {
    expect(needsQueryPrefix("Xenova/BGE-small")).toBe(true);
    expect(needsQueryPrefix("intfloat/E5-large")).toBe(true);
  });
  test("does not match substrings inside unrelated words", () => {
    // 'bge'/'e5' embedded in larger alphanumeric tokens should not trigger.
    expect(needsQueryPrefix("vendor/embget-model")).toBe(false);
    expect(needsQueryPrefix("vendor/codeword")).toBe(false);
  });
});

describe("createEmbeddingClassifier — happy path", () => {
  test("matches nearest exemplar and returns its class", async () => {
    const path = join(tmpDir, "exemplars.json");
    // Build a small fake exemplars set: three vectors in distinct corners.
    await writeExemplarsFile(path, [
      { class: "trivial", prompt: "x", embedding: [1, 0, 0] },
      { class: "reasoning", prompt: "y", embedding: [0, 1, 0] },
      { class: "max", prompt: "z", embedding: [0, 0, 1] },
    ]);
    const classifier = createEmbeddingClassifier({
      exemplarsPath: path,
      embed: fixedEmbed([0.9, 0.1, 0.05]), // closest to [1,0,0] → trivial
      minSimilarity: 0.5,
    });
    const result = (await classifier.classify({ prompt: "anything" })) as Classification;
    expect(result).not.toBeNull();
    expect(result.class).toBe("trivial");
    expect(result.confidence).toBeGreaterThan(0.5);
    expect(result.confidence).toBeLessThanOrEqual(1);
    expect((result.diagnostics ?? []).some((d) => d.code === "embedding.matched")).toBe(true);
  });

  test("confidence scales: perfect match approaches 1.0", async () => {
    const path = join(tmpDir, "exemplars.json");
    await writeExemplarsFile(path, [
      { class: "hard", prompt: "x", embedding: [1, 0, 0] },
    ]);
    const classifier = createEmbeddingClassifier({
      exemplarsPath: path,
      embed: fixedEmbed([1, 0, 0]),
      minSimilarity: 0.5,
    });
    const result = (await classifier.classify({ prompt: "p" })) as Classification;
    expect(result.confidence).toBeCloseTo(1, 5);
  });
});

describe("createEmbeddingClassifier — fail-soft when peer is missing", () => {
  test("EmbeddingPeerMissingError → returns null with embedding_unavailable", async () => {
    const path = join(tmpDir, "exemplars.json");
    await writeExemplarsFile(path, [
      { class: "trivial", prompt: "x", embedding: [1, 0, 0] },
    ]);
    const { sink, diagnostics } = makeSink();
    const classifier = createEmbeddingClassifier({
      exemplarsPath: path,
      embed: () => Promise.reject(new EmbeddingPeerMissingError("not installed")),
      diagnosticSink: sink,
    });
    const result = await classifier.classify({ prompt: "anything" });
    expect(result).toBeNull();
    expect(diagnostics.some((d) => d.code === "fallback.embedding_unavailable")).toBe(true);
  });

  test("generic embed error → returns null with embedding_error", async () => {
    const path = join(tmpDir, "exemplars.json");
    await writeExemplarsFile(path, [
      { class: "trivial", prompt: "x", embedding: [1, 0, 0] },
    ]);
    const { sink, diagnostics } = makeSink();
    const classifier = createEmbeddingClassifier({
      exemplarsPath: path,
      embed: () => Promise.reject(new Error("boom")),
      diagnosticSink: sink,
    });
    const result = await classifier.classify({ prompt: "x" });
    expect(result).toBeNull();
    expect(diagnostics.some((d) => d.code === "fallback.embedding_error")).toBe(true);
  });
});

describe("createEmbeddingClassifier — checksum drift", () => {
  test("tampered seedsChecksum → returns null with exemplars_unavailable", async () => {
    const path = join(tmpDir, "exemplars.json");
    await writeExemplarsFile(
      path,
      [{ class: "trivial", prompt: "x", embedding: [1, 0, 0] }],
      { checksum: "0".repeat(64) },
    );
    const { sink, diagnostics } = makeSink();
    const classifier = createEmbeddingClassifier({
      exemplarsPath: path,
      embed: fixedEmbed([1, 0, 0]),
      diagnosticSink: sink,
    });
    const result = await classifier.classify({ prompt: "anything" });
    expect(result).toBeNull();
    const codes = diagnostics.map((d) => d.code);
    expect(codes).toContain("fallback.embedding_exemplars_unavailable");
  });

  test("missing exemplars file → returns null with exemplars_unavailable", async () => {
    const { sink, diagnostics } = makeSink();
    const classifier = createEmbeddingClassifier({
      exemplarsPath: join(tmpDir, "nope.json"),
      embed: fixedEmbed([1, 0, 0]),
      diagnosticSink: sink,
    });
    const result = await classifier.classify({ prompt: "anything" });
    expect(result).toBeNull();
    expect(diagnostics.some((d) => d.code === "fallback.embedding_exemplars_unavailable")).toBe(true);
  });
});

describe("createEmbeddingClassifier — model/exemplar mismatch", () => {
  test("classifier modelId differs from file model → null + model_mismatch", async () => {
    const path = join(tmpDir, "exemplars.json");
    await writeExemplarsFile(
      path,
      [{ class: "trivial", prompt: "x", embedding: [1, 0, 0] }],
      { model: "Xenova/bge-small-en-v1.5" },
    );
    const { sink, diagnostics } = makeSink();
    const classifier = createEmbeddingClassifier({
      exemplarsPath: path,
      modelId: "Xenova/all-MiniLM-L6-v2", // differs from the file's model
      embed: fixedEmbed([1, 0, 0]),
      diagnosticSink: sink,
    });
    const result = await classifier.classify({ prompt: "anything" });
    expect(result).toBeNull();
    const mismatch = diagnostics.find((d) => d.code === "fallback.embedding_model_mismatch");
    expect(mismatch).toBeDefined();
    expect(mismatch?.severity).toBe("warning");
    expect(mismatch?.message).toContain("Xenova/bge-small-en-v1.5");
    expect(mismatch?.message).toContain("Xenova/all-MiniLM-L6-v2");
  });

  test("matching model proceeds to classification", async () => {
    const path = join(tmpDir, "exemplars.json");
    await writeExemplarsFile(
      path,
      [{ class: "trivial", prompt: "x", embedding: [1, 0, 0] }],
      { model: "Xenova/bge-small-en-v1.5" },
    );
    const { sink, diagnostics } = makeSink();
    const classifier = createEmbeddingClassifier({
      exemplarsPath: path,
      modelId: "Xenova/bge-small-en-v1.5", // matches the file's model
      embed: fixedEmbed([1, 0, 0]),
      minSimilarity: 0.5,
      diagnosticSink: sink,
    });
    const result = (await classifier.classify({ prompt: "p" })) as Classification;
    expect(result).not.toBeNull();
    expect(result.class).toBe("trivial");
    expect(diagnostics.some((d) => d.code === "fallback.embedding_model_mismatch")).toBe(false);
  });
});

describe("createEmbeddingClassifier — minSimilarity threshold", () => {
  test("similarity below threshold → null + low_similarity diagnostic", async () => {
    const path = join(tmpDir, "exemplars.json");
    await writeExemplarsFile(path, [
      { class: "trivial", prompt: "x", embedding: [1, 0, 0] },
    ]);
    const { sink, diagnostics } = makeSink();
    const classifier = createEmbeddingClassifier({
      exemplarsPath: path,
      embed: fixedEmbed([0, 1, 0]), // orthogonal → similarity 0
      minSimilarity: 0.5,
      diagnosticSink: sink,
    });
    const result = await classifier.classify({ prompt: "p" });
    expect(result).toBeNull();
    expect(diagnostics.some((d) => d.code === "fallback.embedding_low_similarity")).toBe(true);
  });
});

describe("createEmbeddingClassifier — lazy load", () => {
  test("lazyLoad=true defers file read until first classify call", async () => {
    let calls = 0;
    const embed: EmbedFn = async () => {
      calls++;
      return Float32Array.from([1, 0, 0]);
    };
    const missingPath = join(tmpDir, "lazy.json");
    // Construct with a missing file: should not throw at construction.
    const classifier = createEmbeddingClassifier({
      exemplarsPath: missingPath,
      embed,
      lazyLoad: true,
      diagnosticSink: () => undefined,
    });
    expect(calls).toBe(0);
    // First classify triggers the load — file doesn't exist → null.
    const r1 = await classifier.classify({ prompt: "x" });
    expect(r1).toBeNull();
    // Now write the file; classify still returns null because the failed
    // load is cached (intentional — fail loudly once, don't paper over).
    await writeExemplarsFile(missingPath, [
      { class: "trivial", prompt: "x", embedding: [1, 0, 0] },
    ]);
    const r2 = await classifier.classify({ prompt: "x" });
    // The cached error is sticky; OK for our purposes — test just verifies
    // we did not pre-load.
    expect(r2).toBeNull();
  });
});

describe("createEmbeddingClassifier — empty prompt", () => {
  test("empty prompt → null without invoking embed", async () => {
    let called = 0;
    const path = join(tmpDir, "exemplars.json");
    await writeExemplarsFile(path, [
      { class: "trivial", prompt: "x", embedding: [1, 0, 0] },
    ]);
    const classifier = createEmbeddingClassifier({
      exemplarsPath: path,
      embed: async () => {
        called++;
        return Float32Array.from([1, 0, 0]);
      },
    });
    const result = await classifier.classify({ prompt: "" });
    expect(result).toBeNull();
    expect(called).toBe(0);
  });
});

describe("SetFit head", () => {
  // A 2-class head over a tiny dim-3 embedding space.
  //   coef[0]=[1,0,0] (trivial), coef[1]=[0,1,0] (hard); both intercepts 0.
  // With embedding [2,0,0]:
  //   logits = [2, 0]; stable softmax (subtract max=2): exp(0)=1, exp(-2)=0.13533528
  //   sum=1.13533528; p(trivial)=1/1.13533528 ≈ 0.880797 → argmax index 0 = "trivial".
  const head2 = {
    coef: [
      [1, 0, 0],
      [0, 1, 0],
    ],
    intercept: [0, 0],
    classes: { trivial: 0, hard: 1 },
  };
  const EXPECTED_P = 1 / (1 + Math.exp(-2)); // ≈ 0.8807970779778823

  test("clear winner → returns that class with softmax confidence", async () => {
    const headPath = join(tmpDir, "head.json");
    await writeHeadFile(headPath, head2);
    const { sink, diagnostics } = makeSink();
    const classifier = createEmbeddingClassifier({
      headPath,
      embed: fixedEmbed([2, 0, 0]),
      minSimilarity: 0.5,
      diagnosticSink: sink,
    });
    const result = (await classifier.classify({ prompt: "anything" })) as Classification;
    expect(result).not.toBeNull();
    expect(result.class).toBe("trivial");
    expect(result.confidence).toBeCloseTo(EXPECTED_P, 6);
    expect((result.diagnostics ?? []).some((d) => d.code === "embedding.head_matched")).toBe(true);
    expect(diagnostics.length).toBe(0);
  });

  test("bestProb below floor → null + head_low_confidence", async () => {
    const headPath = join(tmpDir, "head.json");
    await writeHeadFile(headPath, head2);
    const { sink, diagnostics } = makeSink();
    const classifier = createEmbeddingClassifier({
      headPath,
      embed: fixedEmbed([2, 0, 0]), // p ≈ 0.88
      minSimilarity: 0.95, // floor above the achievable prob
      diagnosticSink: sink,
    });
    const result = await classifier.classify({ prompt: "p" });
    expect(result).toBeNull();
    expect(diagnostics.some((d) => d.code === "fallback.embedding_head_low_confidence")).toBe(true);
  });

  test("embedding dim ≠ head dim → null + head_dim_mismatch", async () => {
    const headPath = join(tmpDir, "head.json");
    await writeHeadFile(headPath, head2); // dim 3
    const { sink, diagnostics } = makeSink();
    const classifier = createEmbeddingClassifier({
      headPath,
      embed: fixedEmbed([1, 0]), // dim 2 — mismatch
      minSimilarity: 0.5,
      diagnosticSink: sink,
    });
    const result = await classifier.classify({ prompt: "p" });
    expect(result).toBeNull();
    expect(diagnostics.some((d) => d.code === "fallback.embedding_head_dim_mismatch")).toBe(true);
  });

  test("malformed head (length mismatch) → null + head_unavailable", async () => {
    const headPath = join(tmpDir, "head.json");
    // intercept has 1 entry but coef/classes have 2 → loader rejects.
    await writeHeadFile(headPath, {
      coef: [
        [1, 0, 0],
        [0, 1, 0],
      ],
      intercept: [0],
      classes: { trivial: 0, hard: 1 },
    });
    const { sink, diagnostics } = makeSink();
    const classifier = createEmbeddingClassifier({
      headPath,
      embed: fixedEmbed([2, 0, 0]),
      minSimilarity: 0.5,
      diagnosticSink: sink,
    });
    const result = await classifier.classify({ prompt: "p" });
    expect(result).toBeNull();
    expect(diagnostics.some((d) => d.code === "fallback.embedding_head_unavailable")).toBe(true);
  });

  test("malformed head (unknown class name) → null + head_unavailable", async () => {
    const headPath = join(tmpDir, "head.json");
    await writeHeadFile(headPath, {
      coef: [
        [1, 0, 0],
        [0, 1, 0],
      ],
      intercept: [0, 0],
      classes: { trivial: 0, bogus: 1 }, // "bogus" is not a valid Class
    });
    const { sink, diagnostics } = makeSink();
    const classifier = createEmbeddingClassifier({
      headPath,
      embed: fixedEmbed([2, 0, 0]),
      minSimilarity: 0.5,
      diagnosticSink: sink,
    });
    const result = await classifier.classify({ prompt: "p" });
    expect(result).toBeNull();
    expect(diagnostics.some((d) => d.code === "fallback.embedding_head_unavailable")).toBe(true);
  });

  test("headPath set → exemplars are NOT consulted (no exemplars file needed)", async () => {
    const headPath = join(tmpDir, "head.json");
    await writeHeadFile(headPath, head2);
    const { sink, diagnostics } = makeSink();
    const classifier = createEmbeddingClassifier({
      headPath,
      // Point exemplarsPath at a nonexistent file: must NOT be read.
      exemplarsPath: join(tmpDir, "does-not-exist.json"),
      embed: fixedEmbed([2, 0, 0]),
      minSimilarity: 0.5,
      diagnosticSink: sink,
    });
    const result = (await classifier.classify({ prompt: "x" })) as Classification;
    expect(result).not.toBeNull();
    expect(result.class).toBe("trivial");
    // Proves the exemplar path was never taken.
    expect(diagnostics.some((d) => d.code === "fallback.embedding_exemplars_unavailable")).toBe(false);
  });

  test("no headPath → cosine/exemplar path unchanged", async () => {
    const path = join(tmpDir, "exemplars.json");
    await writeExemplarsFile(path, [
      { class: "trivial", prompt: "x", embedding: [1, 0, 0] },
      { class: "reasoning", prompt: "y", embedding: [0, 1, 0] },
    ]);
    const classifier = createEmbeddingClassifier({
      exemplarsPath: path,
      embed: fixedEmbed([0.9, 0.1, 0.05]),
      minSimilarity: 0.5,
    });
    const result = (await classifier.classify({ prompt: "p" })) as Classification;
    expect(result).not.toBeNull();
    expect(result.class).toBe("trivial");
    expect((result.diagnostics ?? []).some((d) => d.code === "embedding.matched")).toBe(true);
  });
});

describe("EXEMPLAR_SEEDS structure", () => {
  test("covers all six classes with at least 10 exemplars each", () => {
    const counts = new Map<string, number>();
    for (const s of EXEMPLAR_SEEDS) {
      counts.set(s.class, (counts.get(s.class) ?? 0) + 1);
    }
    for (const cls of ["trivial", "simple", "standard", "hard", "reasoning", "max"]) {
      expect(counts.get(cls) ?? 0).toBeGreaterThanOrEqual(10);
    }
  });
});
