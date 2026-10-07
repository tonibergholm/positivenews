"""Evaluation metrics for the keep question (pure, no model)."""
from __future__ import annotations
from typing import Iterable

def _hard(p: float) -> str:
    return "keep" if p >= 0.5 else "reject"

def keep_metrics(preds: list[float], labels: list[str]) -> dict:
    n = len(preds)
    if n == 0:
        return {"n": 0, "accuracy": None, "balanced_accuracy": None, "reject_precision": None,
                "reject_recall": None, "ece": None, "majority_baseline": None}
    hard = [_hard(p) for p in preds]
    acc = sum(h == l for h, l in zip(hard, labels)) / n
    def recall(cls: str):
        idx = [i for i, l in enumerate(labels) if l == cls]
        return None if not idx else sum(hard[i] == cls for i in idx) / len(idx)
    rk, rr = recall("keep"), recall("reject")
    bal = None if rk is None or rr is None else (rk + rr) / 2
    pred_rej = [i for i, h in enumerate(hard) if h == "reject"]
    rej_prec = None if not pred_rej else sum(labels[i] == "reject" for i in pred_rej) / len(pred_rej)
    majority = max(labels.count("keep"), labels.count("reject")) / n
    return {"n": n, "accuracy": acc, "balanced_accuracy": bal, "reject_precision": rej_prec,
            "reject_recall": rr, "ece": ece(preds, [l == "keep" for l in labels]), "majority_baseline": majority}

def ece(probs: list[float], outcomes: list[bool], bins: int = 10) -> float | None:
    if not probs:
        return None
    total, err = len(probs), 0.0
    for b in range(bins):
        lo, hi = b / bins, (b + 1) / bins
        idx = [i for i, p in enumerate(probs) if (lo <= p < hi) or (b == bins - 1 and p == 1.0)]
        if idx:
            conf = sum(probs[i] for i in idx) / len(idx)
            freq = sum(outcomes[i] for i in idx) / len(idx)
            err += len(idx) / total * abs(conf - freq)
    return err

def gate(val_new: dict, val_base: dict, n_val: int, n_test: int, margin: float = 0.02) -> str:
    if n_val < 200 or n_test < 50:
        return "experimental"
    b_new, b_base = val_new.get("balanced_accuracy"), val_base.get("balanced_accuracy")
    if b_new is None or b_base is None:
        return "fail"
    majority = val_new.get("majority_baseline") or 0.0
    return "pass" if b_new >= b_base + margin and b_new >= majority + margin else "fail"

def by_language(rows: Iterable[dict], preds: dict[str, float]) -> dict:
    out = {}
    rows = list(rows)
    for lang in ("all", "fi", "en"):
        sel = [r for r in rows if lang == "all" or r["language"] == lang]
        out[lang] = keep_metrics([preds[r["id"]] for r in sel], [r["label"] for r in sel])
    return out

def reason_target(row: dict) -> str | None:
    """Top category of gold.reason, or None when the row has no reason target."""
    probs = (row.get("gold") or {}).get("reason", {}).get("probabilities")
    return max(probs, key=probs.get) if probs else None

def reason_metrics(preds: list[str], targets: list[str]) -> dict:
    n = len(preds)
    return {"n": n, "accuracy": None if n == 0 else sum(p == t for p, t in zip(preds, targets)) / n}
