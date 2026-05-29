"""Train a SetFit model on Maestro routing decisions exported via
`maestro export-prompts --setfit`.

Requirements:
    pip install setfit datasets

Usage:
    python scripts/setfit-train.py --input maestro-setfit.jsonl
    python scripts/setfit-train.py --input maestro-setfit.jsonl \\
        --base-model BAAI/bge-small-en-v1.5 \\
        --output-dir ./maestro-setfit-model
    python scripts/setfit-train.py --input maestro-setfit.jsonl \\
        --output-dir ./maestro-setfit-model \\
        --export-head-json ./maestro-setfit-head.json

After training, point Maestro at the model:
    # ~/.maestro/config.json
    { "embeddingModel": "./maestro-setfit-model" }

With --export-head-json, also set embeddingHeadPath so the runtime applies
the calibrated logistic head (see the "Next step" line printed at the end).
"""

import argparse
import json
import sys
from pathlib import Path


def load_jsonl(path: Path) -> list[dict]:
    """Read a JSONL file and return a list of parsed objects.

    Skips blank lines and lines that fail to parse, printing a warning
    for each bad line so the caller knows the data is incomplete.
    """
    rows = []
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
            if not isinstance(obj, dict) or "text" not in obj or "label" not in obj:
                print(
                    f"[warn] line {lineno}: skipping — missing 'text' or 'label' key",
                    file=sys.stderr,
                )
                continue
            rows.append(obj)
    return rows


def build_label_map(rows: list[dict]) -> dict[str, int]:
    """Return a stable label → integer ID mapping (sorted for reproducibility)."""
    labels = sorted({r["label"] for r in rows})
    return {label: idx for idx, label in enumerate(labels)}


def export_head_json(model, id2label: dict[int, str], path: Path) -> bool:
    """Serialize the trained SetFit logistic head to the JSON shape Maestro's
    TS runtime (`src/classifiers/embedding.ts`, type `SetFitHead`) loads.

    Output shape (validated strictly by the TS loader):
        { "coef": [[...], ...],      # [nClasses][embeddingDim]
          "intercept": [...],        # length nClasses
          "classes": { "<name>": <rowIndex>, ... } }

    Returns True on success, False if the head can't be exported (caller keeps
    the already-saved model dir — we never crash a successful training run).

    Row ordering: the SetFit default head is an sklearn LogisticRegression at
    `model.model_head`. Its `.coef_` rows are ordered by `.classes_` (the
    integer labels seen during fit), NOT by label_map insertion order. So for
    each row index `i`, the integer label is `model_head.classes_[i]` and the
    class NAME is `id2label[int(model_head.classes_[i])]`.
    """
    head = getattr(model, "model_head", None)
    if head is None:
        print(
            "error: model has no `model_head`; cannot export logistic head. "
            "The model dir was still saved.",
            file=sys.stderr,
        )
        return False

    coef = getattr(head, "coef_", None)
    intercept = getattr(head, "intercept_", None)
    classes = getattr(head, "classes_", None)
    if coef is None or intercept is None or classes is None:
        print(
            "error: model_head lacks coef_/intercept_/classes_ (likely a "
            "differentiable torch head, not sklearn LogisticRegression). "
            "Head export skipped; the model dir was still saved.",
            file=sys.stderr,
        )
        return False

    coef_list = coef.tolist()
    intercept_list = intercept.tolist()
    class_ints = [int(c) for c in classes.tolist()]

    if len(coef_list) == 1 and len(class_ints) == 2:
        # Binary case: sklearn LogisticRegression emits a SINGLE coef row /
        # intercept for the positive class (classes_[1]). The TS side needs two
        # rows for a 2-way softmax. We emit a zero reference row for the
        # negative class (classes_[0]) and the real row for the positive class.
        # This is mathematically exact: softmax([0, z]) == sigmoid(z), the
        # logistic probability of the positive class, so the decision boundary
        # is preserved.
        dim = len(coef_list[0])
        out_coef = [[0.0] * dim, list(coef_list[0])]
        out_intercept = [0.0, float(intercept_list[0])]
        class_map = {
            id2label[class_ints[0]]: 0,
            id2label[class_ints[1]]: 1,
        }
    else:
        # >=3 classes (multinomial / OvR): coef_ is [nClasses, dim], intercept_
        # is [nClasses]. Emit rows directly, mapping name -> row index via the
        # classes_ order.
        out_coef = [list(row) for row in coef_list]
        out_intercept = [float(v) for v in intercept_list]
        class_map = {id2label[lbl]: i for i, lbl in enumerate(class_ints)}

    payload = {
        "coef": out_coef,
        "intercept": out_intercept,
        "classes": class_map,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return True


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Fine-tune a SetFit model on Maestro routing decisions.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--input",
        default="maestro-setfit.jsonl",
        help="Path to the JSONL file produced by `maestro export-prompts --setfit`.",
    )
    parser.add_argument(
        "--base-model",
        default="BAAI/bge-small-en-v1.5",
        help=(
            "HuggingFace model ID or local path to use as the sentence-transformer "
            "backbone. BAAI/bge-small-en-v1.5 is ~130 MB and trains quickly."
        ),
    )
    parser.add_argument(
        "--output-dir",
        default="./maestro-setfit-model",
        help="Directory where the trained model will be saved.",
    )
    parser.add_argument(
        "--test-split",
        type=float,
        default=0.2,
        help="Fraction of data held out for accuracy evaluation (0 < x < 1).",
    )
    parser.add_argument(
        "--num-iterations",
        type=int,
        default=20,
        help=(
            "Number of contrastive training iterations per class pair. "
            "Higher = better accuracy but slower training."
        ),
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=42,
        help="Random seed for reproducible train/test splitting.",
    )
    parser.add_argument(
        "--export-head-json",
        default=None,
        help=(
            "If set, also serialize the trained logistic head to this JSON path "
            "for Maestro's embeddingHeadPath (type SetFitHead in embedding.ts). "
            "Lets the runtime apply calibrated per-class probabilities."
        ),
    )
    args = parser.parse_args()

    # Validate inputs before importing heavy dependencies.
    input_path = Path(args.input)
    if not input_path.exists():
        print(f"error: input file not found: {input_path}", file=sys.stderr)
        sys.exit(1)

    if not (0 < args.test_split < 1):
        print("error: --test-split must be between 0 and 1 exclusive", file=sys.stderr)
        sys.exit(1)

    # Heavy imports deferred so --help stays instant.
    try:
        from datasets import Dataset
        from setfit import SetFitModel, SetFitTrainer, TrainingArguments
    except ImportError as exc:
        print(
            f"error: required package not installed — {exc}\n"
            "  Install with: pip install setfit datasets",
            file=sys.stderr,
        )
        sys.exit(1)

    # Load and validate data.
    print(f"Loading data from {input_path} …")
    rows = load_jsonl(input_path)
    if len(rows) == 0:
        print("error: no valid rows found in input file", file=sys.stderr)
        sys.exit(1)

    label_map = build_label_map(rows)
    id2label = {v: k for k, v in label_map.items()}
    num_labels = len(label_map)

    print(f"  {len(rows)} examples across {num_labels} classes: {list(label_map)}")

    # Warn when a class has very few examples — SetFit needs at least 2 per
    # class to form contrastive pairs; fewer than 8 per class produces
    # unreliable results.
    class_counts: dict[str, int] = {}
    for r in rows:
        class_counts[r["label"]] = class_counts.get(r["label"], 0) + 1
    for label, count in sorted(class_counts.items()):
        tag = ""
        if count < 2:
            tag = " [ERROR: too few for contrastive pairs]"
        elif count < 8:
            tag = " [warn: <8 examples — accuracy may be low]"
        print(f"  {label}: {count} examples{tag}")
    if any(c < 2 for c in class_counts.values()):
        print(
            "error: at least one class has fewer than 2 examples. "
            "Collect more data before training.",
            file=sys.stderr,
        )
        sys.exit(1)

    # Build HuggingFace Dataset.
    texts = [r["text"] for r in rows]
    labels = [label_map[r["label"]] for r in rows]
    full_dataset = Dataset.from_dict({"text": texts, "label": labels})

    # Train/test split.
    split = full_dataset.train_test_split(test_size=args.test_split, seed=args.seed)
    train_dataset = split["train"]
    test_dataset = split["test"]
    print(f"  Train: {len(train_dataset)} | Test: {len(test_dataset)}")

    # Load base model.
    print(f"\nLoading base model: {args.base_model} …")
    model = SetFitModel.from_pretrained(
        args.base_model,
        labels=list(label_map.keys()),
    )

    # Train.
    print(f"\nTraining (num_iterations={args.num_iterations}) …")
    training_args = TrainingArguments(
        num_iterations=args.num_iterations,
        seed=args.seed,
    )
    trainer = SetFitTrainer(
        model=model,
        train_dataset=train_dataset,
        eval_dataset=test_dataset,
        args=training_args,
        column_mapping={"text": "text", "label": "label"},
    )
    trainer.train()

    # Evaluate on held-out split.
    print("\nEvaluating on held-out test split …")
    metrics = trainer.evaluate()
    accuracy = metrics.get("eval_accuracy", float("nan"))
    print(f"  Test accuracy: {accuracy:.4f} ({accuracy * 100:.1f}%)")

    # Per-class breakdown.
    test_texts = test_dataset["text"]
    test_labels_int = test_dataset["label"]
    predictions = model.predict(test_texts)
    correct_per_class: dict[str, int] = {lbl: 0 for lbl in label_map}
    total_per_class: dict[str, int] = {lbl: 0 for lbl in label_map}
    for pred, true_int in zip(predictions, test_labels_int):
        true_label = id2label[true_int]
        total_per_class[true_label] += 1
        # SetFit model.predict() returns string labels directly.
        if pred == true_label:
            correct_per_class[true_label] += 1
    for label in sorted(label_map):
        total = total_per_class[label]
        if total == 0:
            print(f"    {label}: no test examples")
        else:
            acc = correct_per_class[label] / total
            print(f"    {label}: {correct_per_class[label]}/{total} ({acc * 100:.1f}%)")

    # Save.
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    model.save_pretrained(str(output_dir))
    print(f"\nModel saved to {output_dir}")
    print(
        f"\nNext step: set embeddingModel in ~/.maestro/config.json:\n"
        f'  {{ "embeddingModel": "{output_dir.resolve()}" }}'
    )

    # Optional: export the logistic head as JSON for the TS runtime. Done after
    # the model dir is already saved so a head-export failure never loses the
    # trained model.
    if args.export_head_json:
        head_path = Path(args.export_head_json)
        if export_head_json(model, id2label, head_path):
            print(f"\nLogistic head exported to {head_path}")
            print(
                "\nNext step: set BOTH keys in ~/.maestro/config.json so the "
                "runtime applies the calibrated head:\n"
                f"  {{\n"
                f'    "embeddingModel": "{output_dir.resolve()}",\n'
                f'    "embeddingHeadPath": "{head_path.resolve()}"\n'
                f"  }}"
            )


if __name__ == "__main__":
    main()
