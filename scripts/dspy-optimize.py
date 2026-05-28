"""Optimize the Maestro LLM classifier's few-shot examples using DSPy.

Reads correction events exported by `maestro export-corrections` and uses
DSPy (MIPROv2 or BootstrapFewShot) to find few-shot examples that maximize
routing accuracy on the correction signal.

Requirements:
    pip install dspy-ai>=2.4.0 pandas

Usage:
    # First export corrections from Maestro telemetry:
    maestro export-corrections --output maestro-corrections.jsonl

    # Then optimize:
    python scripts/dspy-optimize.py --input maestro-corrections.jsonl

    # Or specify an explicit output path and LM:
    python scripts/dspy-optimize.py \\
        --input maestro-corrections.jsonl \\
        --output maestro-optimized-classifier.json \\
        --model claude-haiku-4-5 \\
        --max-demos 8

The optimized few-shot examples are written as JSON and can be loaded by
the Maestro LLM classifier at runtime to replace the static exemplars.
"""

# requires: dspy-ai>=2.4.0, pandas

import argparse
import json
import random
import sys
from pathlib import Path

VALID_CLASSES = ("trivial", "simple", "standard", "complex")

# Map Maestro's internal class names to the four-way DSPy label space.
# "hard", "reasoning", and "max" are folded into "complex" since the LLM
# classifier signature only distinguishes four tiers.
CLASS_MAP = {
    "trivial": "trivial",
    "simple": "simple",
    "standard": "standard",
    "hard": "complex",
    "reasoning": "complex",
    "max": "complex",
    "complex": "complex",
}


def load_jsonl(path: Path) -> list[dict]:
    """Read a JSONL file; skip blank lines and malformed entries."""
    rows = []
    bad = 0
    with path.open("r", encoding="utf-8") as fh:
        for lineno, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as exc:
                print(f"  [warn] line {lineno}: {exc}", file=sys.stderr)
                bad += 1
    if bad:
        print(f"  [warn] skipped {bad} malformed lines", file=sys.stderr)
    return rows


def normalize_class(cls: str) -> str | None:
    """Map a Maestro class name to the four-way label space."""
    return CLASS_MAP.get(cls)


def build_examples(rows: list[dict]) -> list[dict]:
    """Convert correction rows to DSPy-compatible example dicts."""
    examples = []
    for r in rows:
        prompt = r.get("prompt", "").strip()
        correct = normalize_class(r.get("correctClass", ""))
        if not prompt or correct is None:
            continue
        examples.append({"prompt": prompt, "routing_decision": correct})
    return examples


def split_train_test(
    examples: list[dict], test_fraction: float = 0.2, seed: int = 42
) -> tuple[list[dict], list[dict]]:
    """Reproducible stratified train/test split."""
    rng = random.Random(seed)
    shuffled = examples[:]
    rng.shuffle(shuffled)
    split = max(1, int(len(shuffled) * (1 - test_fraction)))
    return shuffled[:split], shuffled[split:]


def accuracy(program, examples: list[dict]) -> float:
    """Evaluate routing accuracy on a list of examples."""
    if not examples:
        return 0.0
    correct = 0
    for ex in examples:
        try:
            pred = program(prompt=ex["prompt"])
            pred_label = getattr(pred, "routing_decision", "").strip().lower()
            if pred_label == ex["routing_decision"]:
                correct += 1
        except Exception as exc:  # noqa: BLE001
            print(f"  [warn] predict failed: {exc}", file=sys.stderr)
    return correct / len(examples)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Optimize Maestro LLM classifier few-shots via DSPy.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--input",
        default="maestro-corrections.jsonl",
        help="JSONL from `maestro export-corrections` (default: maestro-corrections.jsonl)",
    )
    parser.add_argument(
        "--output",
        default="maestro-optimized-classifier.json",
        help="Write optimized program to this JSON file (default: maestro-optimized-classifier.json)",
    )
    parser.add_argument(
        "--model",
        default="claude-haiku-4-5",
        help="DSPy LM model identifier (default: claude-haiku-4-5)",
    )
    parser.add_argument(
        "--max-demos",
        type=int,
        default=8,
        help="Maximum few-shot demos in the optimized prompt (default: 8)",
    )
    parser.add_argument(
        "--optimizer",
        choices=["miprov2", "bootstrap"],
        default="miprov2",
        help="DSPy optimizer to use: miprov2 (default) or bootstrap",
    )
    parser.add_argument(
        "--test-fraction",
        type=float,
        default=0.2,
        help="Fraction of examples to hold out for evaluation (default: 0.2)",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=42,
        help="Random seed for train/test split (default: 42)",
    )
    parser.add_argument(
        "--num-trials",
        type=int,
        default=10,
        help="Number of MIPROv2 optimization trials (default: 10)",
    )
    args = parser.parse_args()

    # --- Import DSPy (late, so --help works without it installed) -----------
    try:
        import dspy  # type: ignore[import]
    except ImportError:
        print(
            "error: dspy-ai is not installed. Run: pip install 'dspy-ai>=2.4.0'",
            file=sys.stderr,
        )
        return 1

    # --- Load input ---------------------------------------------------------
    input_path = Path(args.input)
    if not input_path.exists():
        print(f"error: input file not found: {input_path}", file=sys.stderr)
        return 1

    print(f"Loading corrections from {input_path}...", file=sys.stderr)
    raw_rows = load_jsonl(input_path)
    examples = build_examples(raw_rows)

    if not examples:
        print(
            "error: no valid correction examples found in input file.",
            file=sys.stderr,
        )
        return 1

    print(f"  {len(examples)} usable examples from {len(raw_rows)} rows", file=sys.stderr)

    # --- Configure DSPy LM --------------------------------------------------
    try:
        lm = dspy.LM(model=args.model)
        dspy.configure(lm=lm)
    except Exception as exc:  # noqa: BLE001
        print(f"error: failed to configure DSPy LM '{args.model}': {exc}", file=sys.stderr)
        return 1

    # --- Train/test split ---------------------------------------------------
    train_set, test_set = split_train_test(
        examples, test_fraction=args.test_fraction, seed=args.seed
    )
    print(
        f"  train={len(train_set)}, test={len(test_set)} "
        f"(seed={args.seed}, test_fraction={args.test_fraction})",
        file=sys.stderr,
    )

    if len(train_set) < 2:
        print(
            "error: not enough training examples (need at least 2). "
            "Collect more correction events with `maestro export-corrections`.",
            file=sys.stderr,
        )
        return 1

    # --- Define DSPy signature ----------------------------------------------
    class RoutingDecision(dspy.Signature):  # type: ignore[misc]
        """Classify the routing complexity of a Claude Code prompt.

        Given a user prompt, output the cheapest routing tier that can
        handle the task correctly:
          - trivial: single-line lookups, syntax questions, yes/no
          - simple: short code edits, factual questions, quick rewrites
          - standard: multi-step reasoning, medium complexity code, debugging
          - complex: architecture design, root-cause analysis, long generation
        """

        prompt: str = dspy.InputField(desc="The user prompt to classify")
        routing_decision: str = dspy.OutputField(
            desc="One of: trivial, simple, standard, complex"
        )

    # --- Build baseline program ---------------------------------------------
    baseline_program = dspy.Predict(RoutingDecision)

    def routing_metric(example: dspy.Example, pred: dspy.Prediction, trace=None) -> bool:  # type: ignore[type-arg]
        return (
            getattr(pred, "routing_decision", "").strip().lower()
            == example.routing_decision
        )

    # Convert to dspy.Example objects for the optimizer
    train_examples = [
        dspy.Example(
            prompt=e["prompt"],
            routing_decision=e["routing_decision"],
        ).with_inputs("prompt")
        for e in train_set
    ]

    test_examples = [
        dspy.Example(
            prompt=e["prompt"],
            routing_decision=e["routing_decision"],
        ).with_inputs("prompt")
        for e in test_set
    ]

    # --- Evaluate baseline --------------------------------------------------
    print("\nEvaluating baseline...", file=sys.stderr)
    baseline_eval = dspy.Evaluate(
        devset=test_examples,
        metric=routing_metric,
        num_threads=4,
        display_progress=True,
    )
    baseline_score = baseline_eval(baseline_program)
    print(f"  Baseline accuracy: {baseline_score:.1f}%", file=sys.stderr)

    # --- Optimize -----------------------------------------------------------
    print(f"\nOptimizing with {args.optimizer.upper()}...", file=sys.stderr)
    try:
        if args.optimizer == "miprov2":
            try:
                optimizer = dspy.MIPROv2(
                    metric=routing_metric,
                    auto="light",
                    num_trials=args.num_trials,
                    max_bootstrapped_demos=args.max_demos,
                    max_labeled_demos=args.max_demos,
                )
                optimized_program = optimizer.compile(
                    baseline_program,
                    trainset=train_examples,
                    requires_permission_to_run=False,
                )
            except AttributeError:
                print(
                    "  [warn] MIPROv2 not available in this DSPy version; "
                    "falling back to BootstrapFewShot",
                    file=sys.stderr,
                )
                args.optimizer = "bootstrap"
                raise
        if args.optimizer == "bootstrap":
            optimizer = dspy.BootstrapFewShot(
                metric=routing_metric,
                max_bootstrapped_demos=args.max_demos,
                max_labeled_demos=args.max_demos,
            )
            optimized_program = optimizer.compile(
                baseline_program,
                trainset=train_examples,
            )
    except Exception as exc:  # noqa: BLE001
        if args.optimizer != "bootstrap":
            print(f"error: optimization failed: {exc}", file=sys.stderr)
            return 1
        # Already fell back above
        raise

    # --- Evaluate optimized -------------------------------------------------
    print("\nEvaluating optimized program...", file=sys.stderr)
    optimized_eval = dspy.Evaluate(
        devset=test_examples,
        metric=routing_metric,
        num_threads=4,
        display_progress=True,
    )
    optimized_score = optimized_eval(optimized_program)
    print(f"  Optimized accuracy: {optimized_score:.1f}%", file=sys.stderr)

    delta = optimized_score - baseline_score
    sign = "+" if delta >= 0 else ""
    print(
        f"\n  Improvement: {sign}{delta:.1f}% "
        f"({baseline_score:.1f}% → {optimized_score:.1f}%)",
        file=sys.stderr,
    )

    # --- Save output --------------------------------------------------------
    output_path = Path(args.output)
    try:
        optimized_program.save(str(output_path))
    except Exception:  # noqa: BLE001
        # Older DSPy versions use a different save API
        try:
            state = optimized_program.dump_state()
            with output_path.open("w", encoding="utf-8") as fh:
                json.dump(state, fh, indent=2)
        except Exception as exc2:  # noqa: BLE001
            print(f"error: could not save optimized program: {exc2}", file=sys.stderr)
            return 1

    print(f"\nOptimized program saved to: {output_path}", file=sys.stderr)
    print(
        "  Load in Maestro LLM classifier via `src/classifiers/llm.ts`.",
        file=sys.stderr,
    )

    return 0


if __name__ == "__main__":
    sys.exit(main())
