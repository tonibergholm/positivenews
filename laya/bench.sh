#!/usr/bin/env bash
# Benchmark the deployed Laya service on the server (run on minos). Warms Ollama first so the
# memory numbers reflect both models resident, samples MemAvailable during the run, and prints PASS/FAIL.
# Thresholds: batch-of-8 p95 < 20 s, RSS < 2500 MB, minimum available memory > 1000 MB.
set -euo pipefail
SERVER="${LAYA_SERVER:-toni@bergholm.net}"; P="${LAYA_SERVER_PORT:-2222}"
ssh -p "$P" "$SERVER" bash -s <<'REMOTE'
set -euo pipefail
cd ~/apps/laya/current
OLLAMA_MODEL=$(grep '^OLLAMA_MODEL=' ~/apps/positivenews/.env 2>/dev/null | head -n1 | cut -d= -f2- | tr -d "\"'" || true)
export OLLAMA_MODEL="${OLLAMA_MODEL:-gemma3:4b}"
python3 - <<'PYEOF'
import json, os, statistics, sys, threading, time, urllib.request

def avail_mb():
    for line in open("/proc/meminfo"):
        if line.startswith("MemAvailable:"):
            return int(line.split()[1]) // 1024
    raise RuntimeError("MemAvailable not found")

# Warm Ollama (keep_alive keeps the model resident for the whole run).
model = os.environ["OLLAMA_MODEL"]
try:
    req = urllib.request.Request("http://127.0.0.1:11434/api/generate", headers={"content-type": "application/json"},
        data=json.dumps({"model": model, "prompt": "Say OK.", "stream": False, "keep_alive": "30m", "options": {"num_predict": 4}}).encode())
    urllib.request.urlopen(req, timeout=300).read()
    print("ollama warmed: " + model)
except Exception as e:
    print("WARNING: ollama warm-up failed (%s); memory numbers may be optimistic" % e, file=sys.stderr)

q = json.load(open("contract.json"))["questions"]
def post(path, body):
    t = time.time()
    req = urllib.request.Request("http://127.0.0.1:8100" + path, data=json.dumps(body).encode(), headers={"content-type": "application/json"})
    urllib.request.urlopen(req, timeout=120).read()
    return time.time() - t

samples = [avail_mb()]
before = samples[0]
stop = threading.Event()
def sampler():
    while not stop.wait(0.5):
        samples.append(avail_mb())
th = threading.Thread(target=sampler, daemon=True); th.start()
try:
    single = [post("/v1/systemone", {"state": {"title": "Community garden opens %d" % i, "summary": "Volunteers planted trees."}, "questions": q}) for i in range(50)]
    batch = [post("/v1/systemone/batch", {"states": [{"title": "Story %d-%d" % (i, j), "summary": "A short summary."} for j in range(8)], "questions": q}) for i in range(10)]
finally:
    stop.set(); th.join()
after = avail_mb(); samples.append(after)
h = json.load(urllib.request.urlopen("http://127.0.0.1:8100/health"))
p = lambda xs, f: sorted(xs)[min(len(xs) - 1, int(f * len(xs)))]
r = {"single_p50": statistics.median(single), "single_p95": p(single, .95), "batch8_p50": statistics.median(batch), "batch8_p95": p(batch, .95),
     "rss_mb": h["rss_mb"], "available_mb_before": before, "available_mb_after": after, "available_mb_min": min(samples), "ollama_model": model}
print(json.dumps(r))
checks = {"batch8_p95 < 20 s": r["batch8_p95"] < 20, "rss_mb < 2500": r["rss_mb"] < 2500, "available_mb_min > 1000": r["available_mb_min"] > 1000}
for name, ok in checks.items():
    print(("PASS" if ok else "FAIL") + "  " + name)
print("OVERALL " + ("PASS" if all(checks.values()) else "FAIL"))
sys.exit(0 if all(checks.values()) else 1)
PYEOF
REMOTE
