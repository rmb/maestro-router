// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0
// budget: 50ms p95 (after the one-time model load)
//
// In-process embedding classifier (S2). Compares the prompt embedding to a
// frozen, hand-curated set of class exemplars via cosine similarity. Catches
// prompts that are semantically similar to known patterns but escape the
// regex heuristic. Runs between `heuristic` and `llm` so it can short-circuit
// before paying the LLM cost ($0.001/uncertain prompt).
//
// Dependencies:
// - `@huggingface/transformers` is an OPTIONAL peer. If not installed, every
//   classify() call returns null + diagnostic `fallback.embedding_unavailable`
//   and the pipeline continues with whatever signals remain.
// - The on-disk `exemplars.json` (produced by `pnpm embed`) is loaded eagerly
//   by default — drift between it and `EXEMPLAR_SEEDS` is fatal at load time
//   (the seeds may have been edited without re-embedding).

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClassifier } from "../core/classifier.js";
import type {
  Class,
  Classification,
  Classifier,
  ClassifyFn,
  Diagnostic,
  Request,
} from "../core/types.js";
import { EXEMPLAR_SEEDS, serializeSeedsForChecksum } from "./exemplars-seeds.js";

const DEFAULT_MIN_SIMILARITY = 0.5;
const DEFAULT_WEIGHT = 0.6;
const DEFAULT_MODEL_ID = "Xenova/all-MiniLM-L6-v2";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_EXEMPLARS_PATH = join(__dirname, "exemplars.json");

export type ExemplarVector = {
  class: Class;
  prompt: string;
  embedding: ReadonlyArray<number>;
};

export type ExemplarsFile = {
  version: string;
  model: string;
  seedsChecksum: string;
  vectors: ReadonlyArray<ExemplarVector>;
};

export type EmbedFn = (text: string) => Promise<Float32Array>;

export type EmbeddingClassifierOptions = {
  /** Path to the pre-computed exemplars.json. Defaults to the shipped file. */
  exemplarsPath?: string;
  /** Min cosine similarity to return a non-null classification. Default 0.5. */
  minSimilarity?: number;
  /** Classifier weight in the pipeline vote. Default 0.6. */
  weight?: number;
  /** If true, model and exemplars load on first call instead of construction. */
  lazyLoad?: boolean;
  /** Override the embed function (for tests). */
  embed?: EmbedFn;
  /** Override the model id used by the default embed function. */
  modelId?: string;
  /** Sink for fallback diagnostics. Defaults to stderr. */
  diagnosticSink?: (diag: Diagnostic) => void;
};

const defaultSink: (d: Diagnostic) => void = (d) => {
  process.stderr.write(`[maestro] ${d.severity}.${d.code}: ${d.message}\n`);
};

/**
 * Compute sha256 of the EXEMPLAR_SEEDS in serialized stable order. Used to
 * detect drift between the in-memory seed list and the on-disk vectors.
 */
export function computeSeedsChecksum(): string {
  return createHash("sha256").update(serializeSeedsForChecksum()).digest("hex");
}

/** Cosine similarity over two equal-length numeric sequences. */
export function cosineSimilarity(
  a: ReadonlyArray<number> | Float32Array,
  b: ReadonlyArray<number> | Float32Array,
): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

class ExemplarsLoadError extends Error {
  override readonly name = "ExemplarsLoadError";
}

async function loadExemplars(path: string): Promise<ExemplarsFile> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ExemplarsLoadError(
        `embedding classifier: exemplars file missing at ${path}; run \`pnpm embed\` first`,
      );
    }
    throw new ExemplarsLoadError(
      `embedding classifier: failed to read ${path}: ${(err as Error).message}`,
    );
  }
  let parsed: ExemplarsFile;
  try {
    parsed = JSON.parse(raw) as ExemplarsFile;
  } catch (err) {
    throw new ExemplarsLoadError(
      `embedding classifier: ${path} is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (
    typeof parsed.version !== "string" ||
    typeof parsed.seedsChecksum !== "string" ||
    !Array.isArray(parsed.vectors)
  ) {
    throw new ExemplarsLoadError(
      `embedding classifier: ${path} missing required fields (version, seedsChecksum, vectors)`,
    );
  }
  const expected = computeSeedsChecksum();
  if (parsed.seedsChecksum !== expected) {
    throw new ExemplarsLoadError(
      `embedding classifier: seeds checksum mismatch (file=${parsed.seedsChecksum.slice(0, 12)}… expected=${expected.slice(0, 12)}…). Re-run \`pnpm embed\` after editing exemplars-seeds.ts.`,
    );
  }
  // Suppress unused warning — EXEMPLAR_SEEDS is referenced by
  // serializeSeedsForChecksum via the default arg of its caller.
  void EXEMPLAR_SEEDS;
  return parsed;
}

/**
 * Lazy-imported `@huggingface/transformers` feature-extraction pipeline. The
 * import error is converted into a structured signal callers can interpret
 * (peer-not-installed vs. some other runtime failure).
 */
type HFPipelineFn = (
  task: "feature-extraction",
  model: string,
  options?: { dtype?: string },
) => Promise<
  (input: string, options?: { pooling?: "mean"; normalize?: boolean }) => Promise<{
    data: Float32Array;
  }>
>;

let pipelineCache: Promise<HFPipelineFn> | null = null;

async function getHFPipeline(): Promise<HFPipelineFn> {
  if (pipelineCache) return pipelineCache;
  pipelineCache = (async () => {
    // Indirect dynamic import keeps TypeScript from requiring types for the
    // optional peer and prevents bundlers from eagerly resolving it.
    const moduleName = "@huggingface/transformers";
    const mod = (await import(/* @vite-ignore */ moduleName)) as {
      pipeline: HFPipelineFn;
    };
    return mod.pipeline;
  })();
  return pipelineCache;
}

/** Reset module-level caches; tests only. */
export function __resetEmbeddingCachesForTest(): void {
  pipelineCache = null;
}

/** Sentinel thrown by the default embed function when the peer isn't there. */
export class EmbeddingPeerMissingError extends Error {
  override readonly name = "EmbeddingPeerMissingError";
}

function makeDefaultEmbed(modelId: string): EmbedFn {
  let extractorPromise: Promise<
    (text: string, options?: object) => Promise<{ data: Float32Array }>
  > | null = null;
  return async (text: string): Promise<Float32Array> => {
    if (!extractorPromise) {
      extractorPromise = (async () => {
        let pipelineFn: HFPipelineFn;
        try {
          pipelineFn = await getHFPipeline();
        } catch (err) {
          throw new EmbeddingPeerMissingError(
            `@huggingface/transformers is not installed (${(err as Error).message})`,
          );
        }
        // dtype: "q8" uses int8-quantized ONNX weights — ~4x smaller download,
        // ~2-3x faster inference, negligible quality loss for sentence similarity.
        return pipelineFn("feature-extraction", modelId, { dtype: "q8" });
      })();
    }
    const extractor = await extractorPromise;
    const output = await extractor(text, { pooling: "mean", normalize: true });
    return output.data;
  };
}

export function createEmbeddingClassifier(
  opts: EmbeddingClassifierOptions = {},
): Classifier {
  const exemplarsPath = opts.exemplarsPath ?? DEFAULT_EXEMPLARS_PATH;
  const minSimilarity = opts.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
  const weight = opts.weight ?? DEFAULT_WEIGHT;
  const modelId = opts.modelId ?? DEFAULT_MODEL_ID;
  const sink = opts.diagnosticSink ?? defaultSink;
  const embed: EmbedFn = opts.embed ?? makeDefaultEmbed(modelId);

  const emit = (severity: Diagnostic["severity"], code: string, message: string): null => {
    sink({ severity, code, message });
    return null;
  };

  // Eagerly load exemplars unless lazyLoad is set. We surface load errors
  // as a deferred promise that classify() awaits — that way construction
  // never throws on the hot path, but a bad checksum still blocks calls.
  let exemplarsPromise: Promise<ExemplarsFile> | null = null;
  const ensureExemplars = (): Promise<ExemplarsFile> => {
    if (!exemplarsPromise) exemplarsPromise = loadExemplars(exemplarsPath);
    return exemplarsPromise;
  };
  if (opts.lazyLoad !== true) {
    // Kick off the load now; ignore the floating promise — any error is
    // captured on the cached promise and re-thrown when classify() awaits it.
    void ensureExemplars().catch(() => undefined);
  }

  const classify: ClassifyFn = async (
    req: Request,
  ): Promise<Classification | null> => {
    if (typeof req.prompt !== "string" || req.prompt.length === 0) return null;

    let exemplars: ExemplarsFile;
    try {
      exemplars = await ensureExemplars();
    } catch (err) {
      // Fail loud: bad checksum or missing file is a developer error.
      // Surface the message but return null so the pipeline can still run.
      return emit(
        "warning",
        "fallback.embedding_exemplars_unavailable",
        (err as Error).message,
      );
    }

    let vec: Float32Array;
    try {
      vec = await embed(req.prompt);
    } catch (err) {
      if (err instanceof EmbeddingPeerMissingError) {
        return emit(
          "info",
          "fallback.embedding_unavailable",
          `@huggingface/transformers peer not installed; install it to enable embedding classifier`,
        );
      }
      return emit(
        "warning",
        "fallback.embedding_error",
        `embedding failed: ${(err as Error).message}`,
      );
    }

    let bestSim = -Infinity;
    let bestClass: Class | null = null;
    for (const ex of exemplars.vectors) {
      const sim = cosineSimilarity(vec, ex.embedding);
      if (sim > bestSim) {
        bestSim = sim;
        bestClass = ex.class;
      }
    }

    if (bestClass === null || bestSim < minSimilarity) {
      return emit(
        "info",
        "fallback.embedding_low_similarity",
        `embedding max similarity ${bestSim.toFixed(3)} < ${minSimilarity}`,
      );
    }

    // Scale [minSimilarity, 1.0] → [0.5, 1.0] so the pipeline can short-circuit
    // when the match is genuinely close. Clamp into [0,1].
    const range = 1 - minSimilarity;
    const scaled = range > 0 ? 0.5 + (bestSim - minSimilarity) * (0.5 / range) : 1;
    const confidence = Math.max(0, Math.min(1, scaled));

    return {
      class: bestClass,
      confidence,
      diagnostics: [
        {
          severity: "info",
          code: "embedding.matched",
          message: `${bestClass} sim=${bestSim.toFixed(3)} → conf=${confidence.toFixed(2)} (${modelId})`,
        },
      ],
    };
  };

  return createClassifier({ name: "embedding", weight, classify });
}

/**
 * Default embedding classifier. Loads the shipped `exemplars.json` and uses
 * `@xenova/transformers` if installed. Falls back gracefully if not.
 */
export const embeddingClassifier: Classifier = createEmbeddingClassifier();
