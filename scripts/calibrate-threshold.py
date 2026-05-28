"""Recommend an embedding similarity floor (`embeddingMinSimilarity`) by
calibrating logged cosine similarities against oracle correctness.

Maestro's embedding classifier emits a diagnostic with code
`embedding.matched` whose message embeds the cosine similarity, e.g.:
    "standard sim=0.736 -> conf=0.78 (Xenova/all-MiniLM-L6-v2)"
This script extracts that similarity per decision from
`~/.maestro/decisions.jsonl` and, when oracle correctness labels can be
joined, fits an isotonic calibration to recommend the lowest threshold whose
precision clears a target. Without joinable labels it falls back to a proxy
coverage analysis over the similarity distribution.

Assumed decisions.jsonl record shape (TelemetryEvent, type "decision"):
    { "type": "decision", "ts": "...", "prompt": "...", "sessionId": "...",
      "decision": { "class": "...", "classifier": "...", "confidence": 0.78,
                    "diagnostics": [ {"severity": "info",
                                      "code": "embedding.matched",
                                      "message": "... sim=0.736 ..."} ] } }
The reader is defensive: it looks for `diagnostics` under `record["decision"]`
and at the top level, and tolerates schema drift by skipping records that
don't match (reporting how many parsed).

Requirements:
    pip install scikit-learn numpy

Usage:
    python scripts/calibrate-threshold.py --decisions ~/.maestro/decisions.jsonl
    python scripts/calibrate-threshold.py --decisions ~/.maestro/decisions.jsonl \\
        --oracle oracle-results.json --target-precision 0.90
"""

import argparse
import json
import re
import sys
from pathlib import Path

SIM_RE = re.compile(r"sim=([0-9.]+)")

# Candidate thresholds scanned for both the calibrated and proxy reports.
THRESHOLDS = [round(0.30 + 0.02 * i, 2) for i in range(16)]  # 0.30 .. 0.60


def _diagnostics_of(record: dict) -> list:
    """Return the diagnostics list for a decision record, defensively.

    Looks under `record["decision"]["diagnostics"]` first (the canonical
    shape), then a top-level `record["diagnostics"]`. Returns [] when absent.
    """
    decision = record.get("decision", record)
    if isinstance(decision, dict):
        diags = decision.get("diagnostics")
        if isinstance(diags, list):
            return diags
    diags = record.get("diagnostics")
    return diags if isinstance(diags, list) else []


def _join_key(record: dict) -> str | None:
    """Best-effort stable join key for an oracle lookup: id, then sessionId+ts."""
    decision = record.get("decision", record)
    rid = record.get("id") or (decision.get("id") if isinstance(decision, dict) else None)
    if isinstance(rid, str) and rid:
        return rid
    sid = record.get("sessionId")
    ts = record.get("ts")
    if isinstance(sid, str) and isinstance(ts, str):
        return f"{sid}@{ts}"
    return None


def load_similarities(path: Path) -> tuple[list[dict], int]:
    """Parse decisions.jsonl, extracting the embedding similarity per decision.

    Returns (records, total_decisions) where each record is
    {"sim": float, "key": str | None}. Records lacking an `embedding.matched`
    diagnostic (or a parseable sim=) are skipped. `total_decisions` counts every
    decision line seen, so the caller can report the skip ratio.
    """
    records: list[dict] = []
    total = 0
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
                continue
            # Only decision-type events carry a routing diagnostic.
            if obj.get("type") not in (None, "decision"):
                continue
            total += 1
            sim = None
            for diag in _diagnostics_of(obj):
                if not isinstance(diag, dict) or diag.get("code") != "embedding.matched":
                    continue
                m = SIM_RE.search(str(diag.get("message", "")))
                if m:
                    sim = float(m.group(1))
                    break
            if sim is None:
                continue
            records.append({"sim": sim, "key": _join_key(obj)})
    return records, total


def load_oracle_labels(path: Path) -> dict[str, bool]:
    """Load a per-key correctness map from an oracle JSON file, if shaped that
    way. Returns {join_key: correct_bool}. Returns {} when the oracle JSON has
    no per-decision verdicts to join on (e.g. it's an aggregate report)."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        print(f"[warn] could not read oracle file: {exc}", file=sys.stderr)
        return {}

    # Accept a few plausible shapes: a list of {id/sessionId, ts, correct},
    # or a dict mapping key -> bool / {correct: bool}.
    labels: dict[str, bool] = {}

    def add(key, value):
        if not isinstance(key, str) or not key:
            return
        if isinstance(value, bool):
            labels[key] = value
        elif isinstance(value, dict) and isinstance(value.get("correct"), bool):
            labels[key] = value["correct"]

    if isinstance(data, list):
        for item in data:
            if not isinstance(item, dict) or "correct" not in item:
                continue
            rid = item.get("id")
            if isinstance(rid, str):
                add(rid, item.get("correct"))
                continue
            sid, ts = item.get("sessionId"), item.get("ts")
            if isinstance(sid, str) and isinstance(ts, str):
                add(f"{sid}@{ts}", item.get("correct"))
    elif isinstance(data, dict):
        for key, value in data.items():
            add(key, value)
    return labels


def proxy_report(sims) -> None:
    """Print similarity distribution + per-threshold coverage (no labels)."""
    import numpy as np

    arr = np.asarray(sims, dtype=float)
    print("\nProxy coverage analysis (no oracle labels)")
    print(f"  count={arr.size}  min={arr.min():.3f}  max={arr.max():.3f}  mean={arr.mean():.3f}")
    for p in (10, 25, 50, 75, 90):
        print(f"  p{p}={np.percentile(arr, p):.3f}")
    print("\n  threshold   kept (>=t)   would-fall-through (<t)")
    n = arr.size
    for t in THRESHOLDS:
        kept = int(np.sum(arr >= t))
        print(f"  {t:>9.2f}   {kept:>6} ({kept / n * 100:5.1f}%)   {n - kept:>6} ({(n - kept) / n * 100:5.1f}%)")
    print(
        "\nNo oracle labels were joinable, so precision can't be computed. "
        "Pick a floor that keeps most genuine matches while trimming the low-sim tail.\n"
        "Re-run with --oracle <maestro oracle --json output> once per-decision "
        "correctness verdicts are available for a calibrated recommendation."
    )


def calibrated_report(sims, labels, target_precision: float) -> None:
    """Fit isotonic calibration and recommend a floor from labeled data."""
    import numpy as np
    from sklearn.isotonic import IsotonicRegression

    x = np.asarray(sims, dtype=float)
    y = np.asarray(labels, dtype=float)  # 1.0 correct, 0.0 incorrect

    iso = IsotonicRegression(out_of_bounds="clip")
    iso.fit(x, y)  # similarity -> P(correct); monotone calibration curve

    n = x.size
    print(f"\nCalibrated analysis ({n} labeled decisions, target precision {target_precision:.2f})")
    print("\n  threshold   precision (correct|kept)   coverage (kept/all)")
    recommendation = None
    for t in THRESHOLDS:
        kept_mask = x >= t
        kept = int(np.sum(kept_mask))
        coverage = kept / n
        if kept == 0:
            print(f"  {t:>9.2f}   {'n/a (0 kept)':>24}   {coverage * 100:5.1f}%")
            continue
        precision = float(np.mean(y[kept_mask]))
        flag = ""
        if precision >= target_precision and recommendation is None:
            recommendation = t
            flag = "  <- lowest meeting target"
        print(f"  {t:>9.2f}   {precision * 100:21.1f}%   {coverage * 100:5.1f}%{flag}")

    if recommendation is None:
        print(
            "\nNo scanned threshold reaches the target precision. "
            "Consider a higher floor (>0.60), more training exemplars, or a "
            "lower --target-precision.",
        )
    else:
        # Sanity-check the isotonic curve agrees the recommended floor clears target.
        cal_p = float(iso.predict([recommendation])[0])
        print(
            f"\nRecommendation: set embeddingMinSimilarity: {recommendation} in "
            "~/.maestro/config.json\n"
            f"  (empirical precision at this floor meets the {target_precision:.2f} "
            f"target; isotonic P(correct|sim={recommendation}) ~= {cal_p:.2f})"
        )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Calibrate an embedding similarity floor against oracle correctness.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--decisions",
        default="~/.maestro/decisions.jsonl",
        help="Path to Maestro's routing decision log (JSONL).",
    )
    parser.add_argument(
        "--oracle",
        default=None,
        help="Optional JSON from `maestro oracle --json` with per-decision correctness verdicts.",
    )
    parser.add_argument(
        "--target-precision",
        type=float,
        default=0.90,
        help="Minimum precision the recommended threshold must clear (calibrated mode).",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=42,
        help="Random seed (reserved for reproducibility).",
    )
    args = parser.parse_args()

    # Validate inputs before importing heavy dependencies.
    decisions_path = Path(args.decisions).expanduser()
    if not decisions_path.exists():
        print(f"error: decisions file not found: {decisions_path}", file=sys.stderr)
        sys.exit(1)

    if not (0 < args.target_precision <= 1):
        print("error: --target-precision must be in (0, 1]", file=sys.stderr)
        sys.exit(1)

    oracle_path = None
    if args.oracle is not None:
        oracle_path = Path(args.oracle).expanduser()
        if not oracle_path.exists():
            print(f"error: oracle file not found: {oracle_path}", file=sys.stderr)
            sys.exit(1)

    # Parse similarities first (no heavy deps needed for this).
    print(f"Reading decisions from {decisions_path} …")
    records, total = load_similarities(decisions_path)
    if len(records) == 0:
        print(
            "error: no decisions with an `embedding.matched` diagnostic found.\n"
            "  The embedding classifier may be disabled, or no embedding matches "
            "have been logged yet. Enable it and route some prompts first.",
            file=sys.stderr,
        )
        sys.exit(1)
    print(f"  parsed {len(records)} similarities out of {total} decision(s).")

    sims = [r["sim"] for r in records]

    # Heavy imports deferred (numpy + sklearn). Friendly message if missing.
    try:
        import numpy  # noqa: F401
        from sklearn.isotonic import IsotonicRegression  # noqa: F401
    except ImportError as exc:
        print(
            f"error: required package not installed — {exc}\n"
            "  Install with: pip install scikit-learn numpy",
            file=sys.stderr,
        )
        sys.exit(1)

    # Try the oracle join. If it can't be done, fall back to the proxy report.
    labels = None
    if oracle_path is not None:
        oracle_labels = load_oracle_labels(oracle_path)
        if oracle_labels:
            matched_sims: list[float] = []
            matched_labels: list[bool] = []
            for r in records:
                key = r["key"]
                if key is not None and key in oracle_labels:
                    matched_sims.append(r["sim"])
                    matched_labels.append(oracle_labels[key])
            if matched_sims:
                print(
                    f"  joined {len(matched_sims)} decisions to oracle labels "
                    f"(of {len(oracle_labels)} oracle verdicts)."
                )
                sims, labels = matched_sims, matched_labels
            else:
                print(
                    "[warn] oracle file had verdicts but none joined to decisions "
                    "(no shared id/sessionId+ts keys).",
                    file=sys.stderr,
                )
        else:
            print(
                "[warn] oracle file has no per-decision correctness verdicts to "
                "join on (likely an aggregate report).",
                file=sys.stderr,
            )

    if labels is None:
        proxy_report(sims)
    else:
        calibrated_report(sims, labels, args.target_precision)


if __name__ == "__main__":
    main()
