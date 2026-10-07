"""Score a checkpoint (and the untuned base) on val.jsonl and test.jsonl.
Writes report.json and report.md into the checkpoint directory.
Usage: uv run python evaluate.py --data <export-dir> --checkpoint <dir>
"""
from __future__ import annotations
import argparse, json
from pathlib import Path
from laya import Router
from metrics import by_language, gate, reason_metrics, reason_target

BASE = "convaiinnovations/laya-multilingual"

def load(path: Path) -> list[dict]:
    return [json.loads(l) for l in path.read_text().splitlines() if l.strip()]

def label_of(row: dict) -> str:
    return "keep" if row["gold"]["keep"]["probabilities"]["true"] >= 0.5 else "reject"

def ask(router: Router, model: str, rows: list[dict], questions: dict) -> dict[str, dict]:
    """Ask every row the full contract questions (keep and reason), exactly as serving does."""
    return {r["id"]: router.predict(r["state"], questions, model=model)["answers"] for r in rows}

def keep_scores(answers: dict[str, dict]) -> dict[str, float]:
    return {i: float(a["keep"]["noul"]) for i, a in answers.items()}

def reason_scores(answers: dict[str, dict], rows: list[dict]) -> dict:
    sel = [(r, reason_target(r)) for r in rows if reason_target(r) is not None and "reason" in r["questions"]]
    return reason_metrics([answers[r["id"]]["reason"]["choice"] for r, _ in sel], [t for _, t in sel])

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--checkpoint", required=True)
    a = ap.parse_args()
    data, ck = Path(a.data), Path(a.checkpoint)
    val = [dict(r, label=label_of(r)) for r in load(data / "val.jsonl")]
    test = [dict(r, label=label_of(r)) for r in load(data / "test.jsonl")]
    questions = json.loads((data / "contract.json").read_text())["questions"]
    router = Router(models={"positivenews": str(ck), "base": BASE})
    report = {"checkpoint": ck.name, "manifest": json.loads((data / "manifest.json").read_text())}
    answers = {(name, m): ask(router, m, rows, questions)
               for name, rows in (("val", val), ("test", test)) for m in ("positivenews", "base")}
    for name, rows in (("val", val), ("test", test)):
        report[name] = {m: by_language(rows, keep_scores(answers[(name, m)])) for m in ("positivenews", "base")}
    report["reason"] = {name: {m: reason_scores(answers[(name, m)], rows) for m in ("positivenews", "base")}
                        for name, rows in (("val", val), ("test", test))}
    compare = {c["id"]: c for c in load(data / "test-compare.jsonl")} if (data / "test-compare.jsonl").exists() else {}
    report["test_compare"] = {
        src: {"coverage": sum(1 for r in test if compare.get(r["id"], {}).get(src) is not None),
              "agree": sum(1 for r in test if (v := compare.get(r["id"], {}).get(src)) is not None
                           and (v if isinstance(v, str) else ("keep" if v["keep"] else "reject")) == r["label"])}
        for src in ("ollama", "jev")}
    report["gate"] = gate(report["val"]["positivenews"]["all"], report["val"]["base"]["all"], len(val), len(test))
    report["indicative_only"] = len(test) < 50
    (ck / "report.json").write_text(json.dumps(report, indent=2))
    v, t = report["val"]["positivenews"]["all"], report["test"]["positivenews"]["all"]
    (ck / "report.md").write_text(
        f"# {ck.name}\n\ngate: **{report['gate']}**{' (test set < 50: indicative only)' if report['indicative_only'] else ''}\n\n"
        f"val: n={v['n']} bal_acc={v['balanced_accuracy']} ece={v['ece']} majority={v['majority_baseline']}\n\n"
        f"test: n={t['n']} bal_acc={t['balanced_accuracy']} ece={t['ece']}\n\n"
        + "reason top-1 (rows with gold.reason): "
        + ", ".join(f"{s} n={report['reason'][s]['positivenews']['n']} acc={report['reason'][s]['positivenews']['accuracy']}"
                    for s in ("val", "test")) + "\n")
    print(ck / "report.md")

if __name__ == "__main__":
    main()
