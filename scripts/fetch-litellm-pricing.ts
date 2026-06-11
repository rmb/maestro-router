// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0
//
// Fetches model pricing from LiteLLM, extracts the latest haiku/sonnet/opus
// rates, and writes data/model-pricing.json. Run by the fetch-pricing CI job.
//
// Usage: tsx scripts/fetch-litellm-pricing.ts

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

type LiteLLMEntry = {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_creation_input_token_cost?: number;
  cache_read_input_token_cost?: number;
};

type RateSet = {
  model: string;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
};

function modelVersion(name: string): number {
  // claude-sonnet-4-6 → 406, claude-opus-4-8 → 408, claude-haiku-4-5-20251001 → 405
  const m = name.match(/(\d+)-(\d+)(?:-\d+)?(?:-v\d)?(?::0)?$/);
  if (!m) return 0;
  return parseInt(m[1]!, 10) * 100 + parseInt(m[2]!, 10);
}

function pickBest(entries: [string, LiteLLMEntry][]): [string, LiteLLMEntry] | null {
  const valid = entries.filter(
    ([, v]) => v.input_cost_per_token != null && v.output_cost_per_token != null,
  );
  if (valid.length === 0) return null;
  // Prefer non-date-suffixed models (canonical API names like claude-opus-4-8)
  // over snapshot names (claude-opus-4-20250514). Fall back to dated if none exist.
  const nonDate = valid.filter(([k]) => !/\d{8}$/.test(k));
  const pool = nonDate.length > 0 ? nonDate : valid;
  return pool.sort((a, b) => modelVersion(b[0]) - modelVersion(a[0]))[0] ?? null;
}

function toRateSet([name, v]: [string, LiteLLMEntry]): RateSet {
  const input = v.input_cost_per_token!;
  return {
    model: name,
    input,
    output: v.output_cost_per_token!,
    cacheWrite: v.cache_creation_input_token_cost ?? input * 1.25,
    cacheRead: v.cache_read_input_token_cost ?? input * 0.1,
  };
}

process.stderr.write(`Fetching ${LITELLM_URL}\n`);
const res = await fetch(LITELLM_URL);
if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
const all = (await res.json()) as Record<string, LiteLLMEntry>;

// Filter to bare claude-* API model names (no provider prefixes like bedrock/vertex).
const claude = Object.entries(all).filter(
  ([k, v]) =>
    k.startsWith("claude-") &&
    !k.includes(":") &&
    !k.includes("/") &&
    v.input_cost_per_token != null,
);

const haiku = claude.filter(([k]) => k.includes("haiku"));
const sonnet = claude.filter(([k]) => k.includes("sonnet"));
const opus = claude.filter(([k]) => k.includes("opus"));

const bestHaiku = pickBest(haiku);
const bestSonnet = pickBest(sonnet);
const bestOpus = pickBest(opus);

if (!bestHaiku || !bestSonnet || !bestOpus) {
  throw new Error(
    `Missing alias: haiku=${!!bestHaiku} sonnet=${!!bestSonnet} opus=${!!bestOpus}`,
  );
}

const output = {
  updatedAt: new Date().toISOString().slice(0, 10),
  source: LITELLM_URL,
  rates: {
    haiku: toRateSet(bestHaiku),
    sonnet: toRateSet(bestSonnet),
    opus: toRateSet(bestOpus),
  },
};

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outPath = join(root, "data/model-pricing.json");
await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, JSON.stringify(output, null, 2) + "\n", "utf8");

const fmt = (r: RateSet) => `${r.model}  $${(r.input * 1e6).toFixed(2)}/1M in  $${(r.output * 1e6).toFixed(2)}/1M out`;
process.stderr.write(`Wrote ${outPath}\n`);
process.stderr.write(`  haiku:  ${fmt(output.rates.haiku)}\n`);
process.stderr.write(`  sonnet: ${fmt(output.rates.sonnet)}\n`);
process.stderr.write(`  opus:   ${fmt(output.rates.opus)}\n`);
