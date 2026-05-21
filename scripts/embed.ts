// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0
//
// Build-time exemplar embedding generator. Run via `pnpm embed`.
// Loads EXEMPLAR_SEEDS, embeds each prompt with the configured ONNX model,
// and writes src/classifiers/exemplars.json. The runtime classifier verifies
// the seeds checksum on load and refuses to run on drift.

import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXEMPLAR_SEEDS,
  EXEMPLAR_SEEDS_VERSION,
} from "../src/classifiers/exemplars-seeds.js";
import {
  computeSeedsChecksum,
  type ExemplarVector,
  type ExemplarsFile,
} from "../src/classifiers/embedding.js";

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(__dirname, "..", "src", "classifiers", "exemplars.json");

type XenovaPipeline = (
  task: "feature-extraction",
  model: string,
) => Promise<
  (input: string, options?: { pooling?: "mean"; normalize?: boolean }) => Promise<{
    data: Float32Array;
  }>
>;

async function loadPipeline(): Promise<XenovaPipeline> {
  const moduleName = "@xenova/transformers";
  try {
    const mod = (await import(/* @vite-ignore */ moduleName)) as { pipeline: XenovaPipeline };
    return mod.pipeline;
  } catch (err) {
    process.stderr.write(
      `\nFAIL: @xenova/transformers is not installed.\n  Install it (peer dep):\n    pnpm add -D @xenova/transformers\n  or globally:\n    npm install -g @xenova/transformers\n\n  Original error: ${(err as Error).message}\n`,
    );
    process.exit(1);
  }
}

async function main(): Promise<void> {
  process.stderr.write(`[embed] loading ${MODEL_ID}...\n`);
  const pipeline = await loadPipeline();
  const extractor = await pipeline("feature-extraction", MODEL_ID);

  const vectors: ExemplarVector[] = [];
  let i = 0;
  for (const seed of EXEMPLAR_SEEDS) {
    i++;
    process.stderr.write(
      `[embed] [${i}/${EXEMPLAR_SEEDS.length}] (${seed.class}) "${seed.prompt.slice(0, 60)}"\n`,
    );
    const output = await extractor(seed.prompt, { pooling: "mean", normalize: true });
    vectors.push({
      class: seed.class,
      prompt: seed.prompt,
      embedding: Array.from(output.data),
    });
  }

  const file: ExemplarsFile = {
    version: EXEMPLAR_SEEDS_VERSION,
    model: MODEL_ID,
    seedsChecksum: computeSeedsChecksum(),
    vectors,
  };

  await writeFile(OUTPUT_PATH, JSON.stringify(file, null, 2) + "\n", "utf8");
  process.stderr.write(
    `[embed] wrote ${OUTPUT_PATH} (${vectors.length} vectors, dim=${vectors[0]?.embedding.length ?? "?"}, checksum=${file.seedsChecksum.slice(0, 12)}…)\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`[embed] FAIL: ${(err as Error).message}\n`);
  process.exit(1);
});
