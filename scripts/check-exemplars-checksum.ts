// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0
//
// Build-gate: ensure src/classifiers/exemplars.json is in sync with
// EXEMPLAR_SEEDS. Runs from `prebuild`. Bypass with
//   MAESTRO_SKIP_EMBED_CHECK=1 pnpm build
// for CI bootstrap before the peer is installed.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeSeedsChecksum } from "../src/classifiers/embedding.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXEMPLARS_PATH = join(__dirname, "..", "src", "classifiers", "exemplars.json");

async function main(): Promise<void> {
  if (process.env["MAESTRO_SKIP_EMBED_CHECK"] === "1") {
    process.stderr.write("[check-exemplars] MAESTRO_SKIP_EMBED_CHECK=1, skipping.\n");
    return;
  }
  let raw: string;
  try {
    raw = await readFile(EXEMPLARS_PATH, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      process.stderr.write(
        `[check-exemplars] FAIL: ${EXEMPLARS_PATH} not found.\n  Run \`pnpm embed\` first (requires @xenova/transformers).\n  Or skip: MAESTRO_SKIP_EMBED_CHECK=1 pnpm build\n`,
      );
      process.exit(1);
    }
    throw err;
  }
  const parsed = JSON.parse(raw) as { seedsChecksum?: string };
  const expected = computeSeedsChecksum();
  if (parsed.seedsChecksum !== expected) {
    process.stderr.write(
      `[check-exemplars] FAIL: exemplars stale.\n  file=${(parsed.seedsChecksum ?? "<missing>").slice(0, 12)}…\n  expected=${expected.slice(0, 12)}…\n  Re-run \`pnpm embed\`.\n`,
    );
    process.exit(1);
  }
  process.stderr.write("[check-exemplars] ok\n");
}

main().catch((err: unknown) => {
  process.stderr.write(`[check-exemplars] FAIL: ${(err as Error).message}\n`);
  process.exit(1);
});
