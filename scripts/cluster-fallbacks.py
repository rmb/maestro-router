"""Cluster Maestro's forced-standard fallback corpus to reveal missing
exemplar classes.

Maestro logs every prompt that escapes all classifiers (forced to standard)
to a dedicated, untruncated corpus via `maestro export-prompts --fallbacks`
(default `~/.maestro/fallbacks.jsonl`). Clustering that corpus surfaces
coherent groups of prompts that share an intent the runtime can't yet route —
each cluster is a candidate for a new exemplar class.

Requirements:
    pip install umap-learn hdbscan sentence-transformers

Usage:
    python scripts/cluster-fallbacks.py --input ~/.maestro/fallbacks.jsonl
    python scripts/cluster-fallbacks.py --input ~/.maestro/fallbacks.jsonl \\
        --model all-MiniLM-L6-v2 --min-cluster-size 5
"""

import argparse
import json
import sys
from pathlib import Path


def load_prompts(path: Path) -> list[str]:
    """Read a JSONL fallback corpus and return the prompt strings.

    Each line is a JSON object; the prompt text lives under a `prompt` key
    (Maestro's FallbackLogEntry) or a `text` key. Skips blank lines, lines that
    fail to parse, and lines lacking any text field — warning to stderr for
    each so the caller knows the data is incomplete.
    """
    prompts: list[str] = []
    with path.open(encoding="utf-8") as fh:
        for lineno, raw in enumerate(fh, start=1):
            raw = raw.strip()
            if not raw:
                continue
            try:
                obj = json.loads(raw)
            except json.JSONDecodeError as exc:
                print(f"[warn] line {lineno}: skipping malformed JSON ({exc})", file=sys.stderr)
                continue
            if not isinstance(obj, dict):
                print(f"[warn] line {lineno}: skipping — not a JSON object", file=sys.stderr)
                continue
            text = obj.get("prompt") or obj.get("text")
            if not isinstance(text, str) or not text.strip():
                print(
                    f"[warn] line {lineno}: skipping — missing 'prompt'/'text' field",
                    file=sys.stderr,
                )
                continue
            prompts.append(text)
    return prompts


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Cluster the forced-standard fallback corpus to find missing exemplar classes.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--input",
        default="~/.maestro/fallbacks.jsonl",
        help="Path to the JSONL corpus from `maestro export-prompts --fallbacks`.",
    )
    parser.add_argument(
        "--model",
        default="all-MiniLM-L6-v2",
        help="SentenceTransformer model id used to embed prompts for clustering.",
    )
    parser.add_argument(
        "--min-cluster-size",
        type=int,
        default=5,
        help="HDBSCAN minimum cluster size. Lower to surface smaller groups.",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=42,
        help="Random seed for reproducible UMAP reduction.",
    )
    args = parser.parse_args()

    # Validate inputs before importing heavy dependencies.
    input_path = Path(args.input).expanduser()
    if not input_path.exists():
        print(f"error: input file not found: {input_path}", file=sys.stderr)
        sys.exit(1)

    if args.min_cluster_size < 2:
        print("error: --min-cluster-size must be >= 2", file=sys.stderr)
        sys.exit(1)

    # Load and validate data before the (slow) imports.
    print(f"Loading prompts from {input_path} …")
    prompts = load_prompts(input_path)
    if len(prompts) == 0:
        print("error: no valid prompts found in input file", file=sys.stderr)
        sys.exit(1)
    print(f"  {len(prompts)} prompts loaded")

    # Heavy imports deferred so --help stays instant and missing deps are friendly.
    try:
        import numpy as np
        from hdbscan import HDBSCAN
        from sentence_transformers import SentenceTransformer
        from umap import UMAP
    except ImportError as exc:
        print(
            f"error: required package not installed — {exc}\n"
            "  Install with: pip install umap-learn hdbscan sentence-transformers",
            file=sys.stderr,
        )
        sys.exit(1)

    # Approximate the TS runtime's needsQueryPrefix rule: bge/e5 model families
    # require a "query: " instruction prefix on every text. This uses a looser
    # substring test than the TS delimited-segment regex (so e.g. "embget" would
    # match here but not at runtime) — acceptable because these embeddings are
    # only used for human-facing cluster inspection, not runtime vector
    # comparison, so a stray prefix only mildly affects cluster quality.
    model_id_lower = args.model.lower()
    needs_prefix = "bge" in model_id_lower or "e5" in model_id_lower
    texts = [f"query: {p}" for p in prompts] if needs_prefix else prompts

    print(f"\nEmbedding with {args.model} …")
    embedder = SentenceTransformer(args.model)
    embeddings = np.asarray(embedder.encode(texts, show_progress_bar=False))

    # Reduce to ~5 dims before clustering. HDBSCAN struggles in the high-
    # dimensional embedding space (distance concentration); UMAP to a low
    # dimension is standard practice and yields tighter, more stable clusters.
    n_components = min(5, embeddings.shape[0] - 1, embeddings.shape[1])
    if n_components < 2:
        print(
            "error: too few prompts to cluster (need at least 3). "
            "Collect more fallback data first.",
            file=sys.stderr,
        )
        sys.exit(1)

    print(f"Reducing to {n_components} dims with UMAP …")
    reducer = UMAP(n_components=n_components, metric="cosine", random_state=args.seed)
    reduced = reducer.fit_transform(embeddings)

    print(f"Clustering with HDBSCAN (min_cluster_size={args.min_cluster_size}) …")
    clusterer = HDBSCAN(min_cluster_size=args.min_cluster_size, metric="euclidean")
    labels = clusterer.fit_predict(reduced)

    unique_labels = sorted({int(lbl) for lbl in labels if lbl != -1})
    noise_count = int(np.sum(labels == -1))

    if len(unique_labels) == 0:
        print(
            "\nNo clusters formed — every prompt was classified as noise.\n"
            f"  ({noise_count} noise points). Try lowering --min-cluster-size, "
            "or collect more fallback data.",
            file=sys.stderr,
        )
        sys.exit(1)

    print(f"\nFound {len(unique_labels)} cluster(s); {noise_count} noise point(s).\n")

    for cluster_id in unique_labels:
        member_idx = np.where(labels == cluster_id)[0]
        member_points = reduced[member_idx]
        # Medoid-ish representative: the member nearest the cluster's UMAP mean.
        centroid = member_points.mean(axis=0)
        dists = np.linalg.norm(member_points - centroid, axis=1)
        rep_idx = int(member_idx[int(np.argmin(dists))])

        print(f"Cluster {cluster_id} — {len(member_idx)} prompts")
        print(f"  representative: {prompts[rep_idx][:80]!r}")
        print("  examples:")
        for i in member_idx[:5]:
            print(f"    - {prompts[int(i)][:80]!r}")
        print()

    print(
        "Review each cluster, assign a class, and add representative prompts to "
        "src/classifiers/exemplars-seeds.ts, then run `pnpm embed`."
    )


if __name__ == "__main__":
    main()
