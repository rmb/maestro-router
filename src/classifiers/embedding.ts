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
import { ALL_CLASSES } from "../core/profile.js";
import type {
  Class,
  Classification,
  Classifier,
  ClassifyFn,
  Diagnostic,
  Request,
} from "../core/types.js";
import { EXEMPLAR_SEEDS, serializeSeedsForChecksum } from "./exemplars-seeds.js";

const DEFAULT_MIN_SIMILARITY = 0.4;
const DEFAULT_WEIGHT = 0.6;
const DEFAULT_MODEL_ID = "Xenova/all-MiniLM-L6-v2";

/**
 * The bge/e5 model families require a `query:` instruction prefix prepended to
 * every text before embedding. Returns true when the model id contains `bge`
 * or `e5` as a delimited segment (case-insensitive). Exemplars and runtime
 * prompts MUST use the same prefix or cosine similarities are misaligned.
 *
 * Matches: Xenova/bge-small-en-v1.5, intfloat/e5-small-v2, .../large-e5.
 * Does NOT match: Xenova/all-MiniLM-L6-v2, Xenova/gte-small.
 */
export function needsQueryPrefix(modelId: string): boolean {
  // Match `bge`/`e5` only as a whole `/`-`-`-`_`-delimited segment, anchored at
  // a boundary on both sides; the trailing `\d` branch lets versioned families
  // like `e5-large`/`bge2` match while a fused token like `embget` does not.
  return /(^|[/\-_])(bge|e5)([/\-_]|$|\d)/i.test(modelId);
}

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

/**
 * SetFit logistic-regression head exported from `scripts/setfit-train.py`.
 * Maps an embedding vector to a calibrated per-class probability via softmax
 * over the linear logits `intercept[i] + dot(coef[i], vec)`.
 *
 * - `coef`: shape [nClasses][embeddingDim].
 * - `intercept`: length nClasses.
 * - `classes`: class name → row index (a bijection onto 0..nClasses-1).
 */
export type SetFitHead = {
  coef: ReadonlyArray<ReadonlyArray<number>>;
  intercept: ReadonlyArray<number>;
  classes: Readonly<Record<string, number>>;
};

export type EmbeddingClassifierOptions = {
  /** Path to the pre-computed exemplars.json. Defaults to the shipped file. */
  exemplarsPath?: string;
  /**
   * Path to a SetFit logistic-head JSON. When set, the classifier applies the
   * head to the prompt embedding to produce calibrated class probabilities
   * (instead of cosine-nearest-exemplar), giving every prompt a probabilistic
   * signal. The exemplars file is then NOT consulted at all.
   */
  headPath?: string;
  /** Min cosine similarity to return a non-null classification. Default 0.4. */
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
    typeof parsed.model !== "string" ||
    typeof parsed.seedsChecksum !== "string" ||
    !Array.isArray(parsed.vectors)
  ) {
    throw new ExemplarsLoadError(
      `embedding classifier: ${path} missing required fields (version, model, seedsChecksum, vectors)`,
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

class HeadLoadError extends Error {
  override readonly name = "HeadLoadError";
}

async function loadHead(path: string): Promise<SetFitHead> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new HeadLoadError(
        `embedding classifier: SetFit head file missing at ${path}; export one with \`scripts/setfit-train.py\``,
      );
    }
    throw new HeadLoadError(
      `embedding classifier: failed to read ${path}: ${(err as Error).message}`,
    );
  }
  let parsed: SetFitHead;
  try {
    parsed = JSON.parse(raw) as SetFitHead;
  } catch (err) {
    throw new HeadLoadError(
      `embedding classifier: ${path} is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (
    !Array.isArray(parsed.coef) ||
    parsed.coef.length === 0 ||
    !parsed.coef.every((row) => Array.isArray(row))
  ) {
    throw new HeadLoadError(
      `embedding classifier: ${path} field "coef" must be a non-empty array of arrays`,
    );
  }
  if (!Array.isArray(parsed.intercept)) {
    throw new HeadLoadError(
      `embedding classifier: ${path} field "intercept" must be an array`,
    );
  }
  if (
    typeof parsed.classes !== "object" ||
    parsed.classes === null ||
    Array.isArray(parsed.classes)
  ) {
    throw new HeadLoadError(
      `embedding classifier: ${path} field "classes" must be an object`,
    );
  }
  const classKeys = Object.keys(parsed.classes);
  const nClasses = parsed.coef.length;
  if (parsed.intercept.length !== nClasses || classKeys.length !== nClasses) {
    throw new HeadLoadError(
      `embedding classifier: ${path} length mismatch (coef=${nClasses}, intercept=${parsed.intercept.length}, classes=${classKeys.length}); all must match the class count`,
    );
  }
  const dim = parsed.coef[0]?.length ?? 0;
  if (dim === 0 || !parsed.coef.every((row) => row.length === dim)) {
    throw new HeadLoadError(
      `embedding classifier: ${path} coef rows must all share the same non-zero embedding dimension`,
    );
  }
  // Every class index must be an integer covering 0..nClasses-1 exactly once.
  const seen = new Array<boolean>(nClasses).fill(false);
  for (const key of classKeys) {
    if (!(ALL_CLASSES as ReadonlyArray<string>).includes(key)) {
      throw new HeadLoadError(
        `embedding classifier: ${path} unknown class name "${key}"; must be one of ${ALL_CLASSES.join(", ")}`,
      );
    }
    const idx = parsed.classes[key];
    if (!Number.isInteger(idx) || idx === undefined || idx < 0 || idx >= nClasses) {
      throw new HeadLoadError(
        `embedding classifier: ${path} class "${key}" index ${String(idx)} is not an integer in [0, ${nClasses})`,
      );
    }
    if (seen[idx]) {
      throw new HeadLoadError(
        `embedding classifier: ${path} duplicate class index ${idx}; indices must be unique and cover 0..${nClasses - 1}`,
      );
    }
    seen[idx] = true;
  }
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
    const input = needsQueryPrefix(modelId) ? `query: ${text}` : text;
    const output = await extractor(input, { pooling: "mean", normalize: true });
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

  const headPath = opts.headPath;

  // Eagerly load exemplars unless lazyLoad is set OR a head is configured
  // (the head path never consults exemplars). We surface load errors as a
  // deferred promise that classify() awaits — that way construction never
  // throws on the hot path, but a bad checksum still blocks calls.
  let exemplarsPromise: Promise<ExemplarsFile> | null = null;
  const ensureExemplars = (): Promise<ExemplarsFile> => {
    if (!exemplarsPromise) exemplarsPromise = loadExemplars(exemplarsPath);
    return exemplarsPromise;
  };

  // Lazily-resolved, cached head promise (mirrors ensureExemplars). Only used
  // when headPath is configured.
  let headPromise: Promise<SetFitHead> | null = null;
  const ensureHead = (): Promise<SetFitHead> => {
    if (!headPromise) headPromise = loadHead(headPath as string);
    return headPromise;
  };

  if (opts.lazyLoad !== true) {
    // Kick off the relevant load now; ignore the floating promise — any error
    // is captured on the cached promise and re-thrown when classify() awaits.
    if (headPath !== undefined) {
      void ensureHead().catch(() => undefined);
    } else {
      void ensureExemplars().catch(() => undefined);
    }
  }

  /**
   * Embed the prompt, handling the shared peer-missing / generic-error cases.
   * Returns the vector, or null when an error has already been emitted (the
   * caller should bail). Shared by the head and cosine paths.
   */
  const embedOrBail = async (prompt: string): Promise<Float32Array | null> => {
    try {
      return await embed(prompt);
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
  };

  const classify: ClassifyFn = async (
    req: Request,
  ): Promise<Classification | null> => {
    if (typeof req.prompt !== "string" || req.prompt.length === 0) return null;

    // ── SetFit head path ────────────────────────────────────────────────
    // When a head is configured we ignore exemplars entirely and use the
    // logistic head's calibrated probabilities.
    if (headPath !== undefined) {
      let head: SetFitHead;
      try {
        head = await ensureHead();
      } catch (err) {
        return emit(
          "warning",
          "fallback.embedding_head_unavailable",
          (err as Error).message,
        );
      }

      const vec = await embedOrBail(req.prompt);
      if (vec === null) return null;

      const coefRowLength = head.coef[0]?.length ?? 0;
      if (vec.length !== coefRowLength) {
        return emit(
          "warning",
          "fallback.embedding_head_dim_mismatch",
          `head expects dim ${coefRowLength} but embedding produced dim ${vec.length}; retrain head or fix embeddingModel`,
        );
      }

      // logits[i] = intercept[i] + dot(coef[i], vec)
      const nClasses = head.coef.length;
      const logits = new Array<number>(nClasses);
      for (let i = 0; i < nClasses; i++) {
        const row = head.coef[i] as ReadonlyArray<number>;
        let dot = head.intercept[i] ?? 0;
        for (let j = 0; j < coefRowLength; j++) {
          dot += (row[j] ?? 0) * (vec[j] ?? 0);
        }
        logits[i] = dot;
      }

      // Numerically stable softmax: subtract the max logit before exp().
      let maxLogit = -Infinity;
      for (const l of logits) if (l > maxLogit) maxLogit = l;
      let sumExp = 0;
      const exps = new Array<number>(nClasses);
      for (let i = 0; i < nClasses; i++) {
        const e = Math.exp((logits[i] as number) - maxLogit);
        exps[i] = e;
        sumExp += e;
      }

      let bestIndex = 0;
      let bestExp = -Infinity;
      for (let i = 0; i < nClasses; i++) {
        if ((exps[i] as number) > bestExp) {
          bestExp = exps[i] as number;
          bestIndex = i;
        }
      }
      const bestProb = sumExp > 0 ? bestExp / sumExp : 0;

      // Invert classes (index → name). The loader guarantees a bijection.
      let bestClass: Class | null = null;
      for (const [name, idx] of Object.entries(head.classes)) {
        if (idx === bestIndex) {
          bestClass = name as Class;
          break;
        }
      }

      // The head's probability is already a calibrated confidence in [0,1],
      // so we use it directly as the confidence and reuse `minSimilarity` only
      // as the confidence FLOOR — we do NOT rescale it the way the cosine path
      // does (cosine similarities are not probabilities and need remapping).
      if (bestClass === null || bestProb < minSimilarity) {
        return emit(
          "info",
          "fallback.embedding_head_low_confidence",
          `head max prob ${bestProb.toFixed(3)} < floor ${minSimilarity}`,
        );
      }

      return {
        class: bestClass,
        confidence: bestProb,
        diagnostics: [
          {
            severity: "info",
            code: "embedding.head_matched",
            message: `${bestClass} p=${bestProb.toFixed(3)} (head)`,
          },
        ],
      };
    }

    // ── Cosine / exemplar path (unchanged) ──────────────────────────────
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

    // The seedsChecksum only covers seed TEXT, not the model — so a file
    // embedded with one model and a classifier configured with another would
    // pass the checksum but compare vectors from different embedding spaces
    // (and possibly different dimensions). Guard against that misalignment.
    if (exemplars.model !== modelId) {
      return emit(
        "warning",
        "fallback.embedding_model_mismatch",
        `exemplars.json was embedded with "${exemplars.model}" but classifier is configured for "${modelId}". Re-run \`pnpm embed\` with the same model or fix \`embeddingModel\` in config.`,
      );
    }

    const vec = await embedOrBail(req.prompt);
    if (vec === null) return null;

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
