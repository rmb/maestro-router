# Fallback Rate Improvement Plan

**Goal**: reduce `forced.standard` decisions (fallback rate target <5%, warn >10%).

**Context**: The embedding stage (all-MiniLM-L6-v2, 76 exemplars, minSim=0.4) is the only semantic
catch-all before the opt-in LLM stage. A fallback fires when all 8 classifiers return null AND
the sub-threshold vote pool is empty. Every lever below targets the embedding stage because it
already runs in-process at zero spawn cost.

**Recommended execution order** (each phase unblocks the next):

```
Phase A — Cluster fallbacks → expand seeds (no code, 1 Python script)
Phase B — Swap to stronger model (2 file edits, re-run pnpm embed)
Phase C — Calibrate threshold (1 Python script + 3 TS field additions)
Phase D — SetFit head (1 script addition + 1 TS classifier extension)
Phase E — model2vec experiment (model ID swap only — confirm JS support first)
```

---

## Phase A — Cluster fallbacks to find missing exemplar classes

**What and why**: The 76 exemplars are the only seed data for cosine matching. Prompts that produce
`fallback.embedding_low_similarity` are structurally different from all 76. Clustering them reveals
which families are completely absent from the seed set.

**Existing hook**: `maestro export-prompts --fallbacks` already writes `~/.maestro/fallbacks.jsonl`
(corpus of forced.standard prompts). Nothing to change in TypeScript.

### New file: `scripts/cluster-fallbacks.py`

```
pip install umap-learn hdbscan sentence-transformers
python scripts/cluster-fallbacks.py \
  --input ~/.maestro/fallbacks.jsonl \
  --model all-MiniLM-L6-v2 \
  [--min-cluster-size 5]
```

Script does:
1. Load prompts from fallbacks.jsonl
2. Embed all prompts (same model as runtime, so clusters are directly comparable)
3. UMAP(n_components=2, metric="cosine") → HDBSCAN(min_cluster_size=5)
4. For each cluster: print the centroid prompt (closest to mean), cluster size, and top-5 keywords
5. Print a suggested `exemplars-seeds.ts` block per cluster (needs manual class labeling)

**Output** → human reviews, labels each cluster's class, adds seed prompts to:
`src/classifiers/exemplars-seeds.ts`

After adding seeds: `pnpm embed` re-generates `exemplars.json`, then `pnpm bench`.

**Validation gate**: `pnpm bench` must hold within 2% of `evals/baseline.json`. If accuracy
improves, update the baseline: `pnpm bench --update-baseline`.

**Cost**: zero. Fully offline, no model spawn.

---

## Phase B — Swap to a stronger embedding model

**What and why**: `Xenova/all-MiniLM-L6-v2` is a 2021 model. Newer 384-dim ONNX models score
8–15pp higher on MTEB sentence similarity — more real prompts clear the 0.4 floor with the
correct class. Since `embeddingModel` already flows end-to-end through config → CLI handlers →
`createEmbeddingClassifier({ modelId })`, the runtime change is zero.

**Candidate models** (same 384 dim, Xenova ONNX ports available):
- `Xenova/bge-small-en-v1.5` — best MTEB score among 384-dim models, needs `query:` prefix
- `Xenova/gte-small` — no prefix needed, solid alternative
- `Snowflake/snowflake-arctic-embed-xs` — retrieval-tuned, no prefix

**Verify the Xenova port exists before committing**:
```bash
node -e "
const {pipeline} = await import('@huggingface/transformers');
const p = await pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5', {dtype:'q8'});
console.log('ok');
"
```

### Change 1 of 2: `scripts/embed.ts` — parameterize MODEL_ID

Currently hardcoded at line 21: `const MODEL_ID = "Xenova/all-MiniLM-L6-v2"`.

Replace with:
```typescript
const MODEL_ID = process.env["MAESTRO_EMBED_MODEL"] ?? "Xenova/all-MiniLM-L6-v2";
```

Run with new model: `MAESTRO_EMBED_MODEL=Xenova/bge-small-en-v1.5 pnpm embed`

### Change 2 of 2: `src/classifiers/embedding.ts` — add query prefix for bge/e5 families

In `makeDefaultEmbed` (line 192), before calling `extractor(text, ...)`:

```typescript
function needsQueryPrefix(modelId: string): boolean {
  return /\bbge\b|\be5\b/i.test(modelId);
}

// In makeDefaultEmbed, before the extractor call:
const input = needsQueryPrefix(modelId) ? `query: ${text}` : text;
const output = await extractor(input, { pooling: "mean", normalize: true });
```

**Exemplars must be re-embedded with the same prefix**. In `scripts/embed.ts`, also apply the
prefix when calling the extractor:
```typescript
const input = /\bbge\b|\be5\b/i.test(MODEL_ID) ? `query: ${seed.prompt}` : seed.prompt;
```

**Config to switch**: `~/.maestro/config.json`:
```json
{ "embeddingModel": "Xenova/bge-small-en-v1.5" }
```

**Validation gate**:
1. `pnpm embed` with `MAESTRO_EMBED_MODEL=Xenova/bge-small-en-v1.5` produces new `exemplars.json`
2. `pnpm build` must pass (checksum check will re-validate)
3. `pnpm bench` must hold within 2% — improvement expected
4. Runtime latency test: embedding stage must stay ≤50ms p95 (already has `// budget: 50ms`)

---

## Phase C — Calibrate the similarity threshold

**What and why**: The `DEFAULT_MIN_SIMILARITY = 0.4` is a heuristic constant. With real oracle
outcomes, we can find the threshold that maximizes coverage without increasing misroutes — possibly
safely lowering it in similarity ranges where the model is empirically reliable.

**Existing data**: `embedding.matched` diagnostics in decisions.jsonl already log `sim=X.XXX` per
decision. Oracle correctness comes from `maestro oracle --json`.

### New file: `scripts/calibrate-threshold.py`

```
pip install scikit-learn numpy
python scripts/calibrate-threshold.py \
  --decisions ~/.maestro/decisions.jsonl \
  --oracle-output oracle-results.json   # from: maestro oracle --json
```

Script does:
1. Parse decisions.jsonl — extract decisions where classifier=`embedding` with `embedding.matched` diag
2. Parse the sim value from the diagnostic message
3. Cross-reference with oracle outcome (correct=1 / incorrect=0)
4. Fit isotonic regression: `(sim_values, correct_labels)` → calibrated threshold
5. Plot (or print) precision/recall at each threshold
6. Recommend: `embeddingMinSimilarity: <value>` for the config

### TypeScript: add `embeddingMinSimilarity` to config

Three places:

**`src/core/config-schema.ts`**: add to `userConfigSchema`:
```typescript
embeddingMinSimilarity: z.number().min(0).max(1).optional(),
```

**`src/core/types.ts`**: add to `UserConfig`:
```typescript
embeddingMinSimilarity?: number;
```

**Wire in 5 CLI handlers** (shell-cmd.ts:69, bench.ts:162, wire-compat.ts:244, run-cmd.ts:147,
replay.ts:48) — pattern is identical in all five:
```typescript
const embeddingOpts = {
  ...(cli.userConfig.embeddingModel !== undefined ? { modelId: cli.userConfig.embeddingModel } : {}),
  ...(cli.userConfig.embeddingMinSimilarity !== undefined
    ? { minSimilarity: cli.userConfig.embeddingMinSimilarity }
    : {}),
};
```

**Validation gate**: `pnpm typecheck` + `pnpm test` + `pnpm bench` within 2%.

---

## Phase D — SetFit logistic head

**What and why**: Cosine similarity to a nearest exemplar returns a distance, not a calibrated
probability. SetFit trains a contrastive sentence-transformer + sklearn logistic head on your
actual routing decisions. The head outputs `P(class | embedding)` — every prompt gets a signal,
even if it's equidistant from all exemplars. This structurally eliminates the dominant fallback
mode.

**What already exists**:
- `maestro export-prompts --setfit` → `{text, label}` JSONL
- `scripts/setfit-train.py` → trains backbone + head, saves to `--output-dir`

**What's missing**: ONNX export of backbone, JSON serialization of logistic head weights, and
runtime head application in the classifier.

### Change 1: `scripts/setfit-train.py` — add `--export-head-json`

At the end of training, after `trainer.train()`:

```python
import json, pathlib

def export_head_json(trainer, label_map, output_path):
    """Serialize sklearn logistic head to JSON for JS runtime."""
    head = trainer.model.model_head
    out = {
        "coef": head.coef_.tolist(),          # shape: [n_classes, embedding_dim]
        "intercept": head.intercept_.tolist(), # shape: [n_classes]
        "classes": label_map,                  # {"trivial": 0, "simple": 1, ...}
    }
    pathlib.Path(output_path).write_text(json.dumps(out, indent=2))

if args.export_head_json:
    export_head_json(trainer, label_map, args.export_head_json)
```

Add `--export-head-json ./maestro-head.json` as a CLI arg.

### Change 2: `src/classifiers/embedding.ts` — apply logistic head

New type:
```typescript
type SetFitHead = {
  coef: number[][];    // [n_classes][embedding_dim]
  intercept: number[]; // [n_classes]
  classes: Record<string, number>; // class_name → index
};
```

New option in `EmbeddingClassifierOptions`:
```typescript
headPath?: string; // path to exported head JSON
```

In `classify()`, after computing `vec`:
```typescript
if (head !== null) {
  // logits = W @ vec + b
  const logits = head.coef.map((row, i) =>
    row.reduce((s, w, j) => s + w * (vec[j] ?? 0), head.intercept[i] ?? 0)
  );
  // softmax
  const maxL = Math.max(...logits);
  const exps = logits.map(l => Math.exp(l - maxL));
  const sumE = exps.reduce((s, e) => s + e, 0);
  const probs = exps.map(e => e / sumE);
  const bestIdx = probs.indexOf(Math.max(...probs));
  const bestClass = classesInv[bestIdx]; // inverted classes map
  const confidence = probs[bestIdx]; // calibrated probability
  if (confidence >= minSimilarity) { // reuse minSimilarity as confidence floor
    return { class: bestClass, confidence, diagnostics: [...] };
  }
}
```

Load head JSON lazily (same pattern as exemplars: `Promise<SetFitHead | null>`).

### Config: add `embeddingHeadPath`

Same three-file pattern as Phase C: config-schema.ts, types.ts, 5 CLI handlers.

**Validation gate**: `pnpm typecheck` + `pnpm test` + `pnpm bench` within 2%.

**Training workflow**:
```bash
maestro export-prompts --setfit > maestro-setfit.jsonl
python scripts/setfit-train.py \
  --input maestro-setfit.jsonl \
  --base-model BAAI/bge-small-en-v1.5 \
  --output-dir ./maestro-setfit-model \
  --export-head-json ~/.maestro/maestro-head.json
# then:
# "embeddingModel": "./maestro-setfit-model",
# "embeddingHeadPath": "~/.maestro/maestro-head.json"
```

---

## Phase E — model2vec fast-path (experimental)

**What and why**: model2vec (MinishLab) uses static token embeddings — effectively a lookup table
giving microsecond inference vs. 5–15ms for ONNX. The tradeoff is lower MTEB scores. It's
interesting as a first-pass pre-filter.

**Uncertainty**: `minishlab/potion-base-8M` is on HuggingFace but uses `StaticModel` architecture.
The `@huggingface/transformers` JS library added model2vec support in v3.x — **verify before building**:

```bash
node -e "
const {pipeline} = await import('@huggingface/transformers');
const p = await pipeline('feature-extraction', 'minishlab/potion-base-8M');
const out = await p('test prompt', {pooling:'mean',normalize:true});
console.log(out.data.length);
"
```

If it loads: set `"embeddingModel": "minishlab/potion-base-8M"` in config, re-run `pnpm embed`,
bench. No code change needed — Phase B's parameterization handles it.

If it doesn't load: the `@huggingface/transformers` v4 release may include it — check release
notes before any code work. Don't build a custom loader for this until the standard path is
confirmed broken.

**Defer Phase E until Phases A–C are stable.**

---

## Summary table

| Phase | Effort | Files changed | New dep | Expected fallback reduction |
|-------|--------|---------------|---------|----------------------------|
| A (cluster + seeds) | 1 Python script + manual seed labeling | 1 new, `exemplars-seeds.ts` | umap-learn, hdbscan, sentence-transformers | high (gaps → direct seeds) |
| B (model swap) | 2 TS edits + pnpm embed | embed.ts, embedding.ts | none | high (better baseline similarity) |
| C (threshold calibration) | 1 Python script + 3 TS | config-schema.ts, types.ts, 5 handlers | scikit-learn | medium (lower safe floor) |
| D (SetFit head) | 1 Python addition + embedding.ts extension | setfit-train.py, embedding.ts, config-schema.ts, types.ts, 5 handlers | optimum (Python only) | high (probabilistic signal on every prompt) |
| E (model2vec) | 0–1 (model ID or verify + file) | embed.ts if not done | none | medium (speed; accuracy TBD) |

Execute in order: A → B → bench → C → bench → D → bench. Gate each phase on `pnpm bench` ≤2% regression.
