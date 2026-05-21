# ADR-0006 · Embedding classifier via `@xenova/transformers`

## Status

Accepted · 2026-05-21

## Context

The classifier pipeline before this ADR is override → turn-type → heuristic
→ llm. The heuristic stage is a regex bank; it has high precision on the
patterns it covers but cannot generalize. The LLM stage (S12) catches the
rest at ~$0.001 per uncertain prompt by spawning `claude --print --model
haiku --json-schema`. Two problems push us to want an intermediate stage:

1. **Cost / latency**. Every prompt that escapes the heuristic pays a
   subprocess spawn + Haiku call. A local, deterministic, cheap classifier
   between heuristic and LLM short-circuits prompts that are semantically
   close to known patterns — saving the LLM call entirely.
2. **Determinism**. The LLM stage adds non-determinism to the pipeline.
   A local embedding lookup is reproducible: same prompt → same vector →
   same nearest exemplar → same class. That matters for replay, eval
   stability, and debugging.

## Decision

Add an in-process embedding classifier (S2) that:

- Embeds the prompt with `Xenova/all-MiniLM-L6-v2` (ONNX, ~22MB, 384-dim,
  CPU-only) loaded via `@xenova/transformers`.
- Compares the result via cosine similarity to ~60 hand-curated exemplars
  (10 per class × 6 classes), precomputed at build time by `pnpm embed`
  and shipped as `src/classifiers/exemplars.json`.
- Scales similarities ≥ 0.5 into confidence ∈ [0.5, 1.0] so the pipeline
  can short-circuit on close matches (≥ 0.6 threshold).
- Treats `@xenova/transformers` as an **optional peer dependency** —
  unavailable peer → return null + diagnostic, pipeline continues.

The seed list lives in `src/classifiers/exemplars-seeds.ts`. The on-disk
vectors are pinned to the seeds via a sha256 checksum computed over
`<class>\t<prompt>\n` lines in declared order. Drift between seeds and
vectors is detected:

- At runtime — `embedding.ts` loads `exemplars.json` and compares the
  embedded `seedsChecksum` against a freshly computed one; mismatch =>
  null + `fallback.embedding_exemplars_unavailable`.
- At build time — `scripts/check-exemplars-checksum.ts` (gated on
  `prebuild`) refuses to build when `exemplars.json` is missing or stale.
  Bypass with `MAESTRO_SKIP_EMBED_CHECK=1` for CI bootstrap.

## Rationale

### Why `Xenova/all-MiniLM-L6-v2`

- 384-dim, ~22MB ONNX weights, CPU-only — fits in the wrapper's per-turn
  budget (50ms p95 after one-time model load).
- Trained on a broad corpus; performs well on short technical sentences
  (the shape of our prompts).
- Available on Hugging Face as a Xenova-converted ONNX model; the
  `@xenova/transformers` runtime handles tokenization + inference without
  Python.

### Why optional peer (not a hard dependency)

`@xenova/transformers` is ~50MB installed. Maestro's value proposition
includes the wrapper layer for users who have no API key — many of them
will not want to download an ONNX model. Optional-peer keeps the default
install lean: the classifier returns null gracefully when the peer is
absent, and the pipeline continues to LLM.

### Why precompute exemplars

Embedding 60 exemplars on every CLI startup would defeat the purpose. The
build-time `pnpm embed` script runs once per change to `exemplars-seeds.ts`
and writes the vectors as JSON. Runtime only loads the JSON and embeds the
incoming prompt — one inference per turn.

### Why a checksum gate (vs file watcher / hot reload)

The seed list is intentionally hard to change without a re-embed. The
build-time gate (`prebuild`) catches the common "edited seeds, forgot to
re-embed" mistake before it reaches a user. The runtime gate is the last
line of defense for built tarballs.

## Alternatives considered

- **`@xenova/transformers-node`** (Node-specific build). Same package now
  ships universal builds; no advantage.
- **`onnxruntime-node` directly**. Lower-level, requires our own
  tokenizer. `@xenova/transformers` bundles tokenizers + model loading.
  Not worth the maintenance cost.
- **OpenAI text-embedding-3 / Voyage AI**. Network call, API key, and a
  per-prompt cost — defeats the determinism + offline goals.
- **Larger embedding models** (`Xenova/bge-small-en-v1.5`,
  `Xenova/multilingual-e5-base`). Marginal accuracy gains, larger
  download. Re-evaluate if eval data shows MiniLM saturating.
- **Build embeddings at install time** (postinstall script). Optional peer
  means many users won't have the model; postinstall would fail noisily
  for them. Build-time pre-computation by the package author is simpler.

## Consequences

- Build step gained a checksum gate; new contributors who edit
  `exemplars-seeds.ts` must run `pnpm embed` (or bypass with the env
  variable) before `pnpm build` passes.
- Wrapper start-up still includes a single async exemplars-load. Latency
  budget is unchanged because the load is best-effort and never blocks
  classify().
- The classifier writes diagnostics with severity `info` (peer missing /
  low similarity) and `warning` (embedding error / stale exemplars).
  Tests assert each path. Live pipeline emits the diagnostics via the
  default stderr sink — opt out with a custom `diagnosticSink`.

## Reversal

Removing the embedding stage means:

1. Drop the `embedding` import in `run-cmd.ts` / `wire-compat.ts` /
   `replay.ts` / `bench.ts`.
2. Delete `src/classifiers/embedding.ts`, `exemplars-seeds.ts`,
   `exemplars.json`, the `scripts/embed.ts` script, and the `prebuild`
   gate.
3. Remove the `@xenova/transformers` peer from `package.json`.
4. Update docs and tests.

No data needs migration — the classifier is stateless.
