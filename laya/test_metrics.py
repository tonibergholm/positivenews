from metrics import ece, gate, keep_metrics

def test_perfect_and_constant():
    m = keep_metrics([0.9, 0.1, 0.8, 0.2], ["keep", "reject", "keep", "reject"])
    assert m["accuracy"] == 1 and m["balanced_accuracy"] == 1 and m["reject_precision"] == 1
    c = keep_metrics([0.4] * 4, ["keep", "reject", "reject", "reject"])
    assert c["balanced_accuracy"] == 0.5 and c["majority_baseline"] == 0.75

def test_empty():
    assert keep_metrics([], [])["accuracy"] is None and ece([], []) is None

def test_ece_calibrated_is_small():
    assert ece([0.25] * 4, [True, False, False, False]) < 1e-9

def test_gate():
    good = {"balanced_accuracy": 0.8, "majority_baseline": 0.5}
    base = {"balanced_accuracy": 0.6}
    assert gate(good, base, 500, 100) == "pass"
    assert gate({"balanced_accuracy": 0.61, "majority_baseline": 0.5}, base, 500, 100) == "fail"
    assert gate(good, base, 100, 100) == "experimental"
    assert gate(good, base, 500, 10) == "experimental"
