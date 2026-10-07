#!/usr/bin/env bash
# Benchmark the deployed Laya service on the server (run on minos). Prints p50/p95 and peak RSS.
set -euo pipefail
SERVER="${LAYA_SERVER:-toni@bergholm.net}"; P="${LAYA_SERVER_PORT:-2222}"
ssh -p "$P" "$SERVER" 'cd ~/apps/laya/current && python3 - <<EOF
import json, time, urllib.request, statistics
q = json.load(open("contract.json"))["questions"]
def post(path, body):
    t = time.time()
    req = urllib.request.Request("http://127.0.0.1:8100" + path, data=json.dumps(body).encode(), headers={"content-type": "application/json"})
    urllib.request.urlopen(req, timeout=120).read()
    return time.time() - t
single = [post("/v1/systemone", {"state": {"title": f"Community garden opens {i}", "summary": "Volunteers planted trees."}, "questions": q}) for i in range(50)]
batch = [post("/v1/systemone/batch", {"states": [{"title": f"Story {i}-{j}", "summary": "A short summary."} for j in range(8)], "questions": q}) for i in range(10)]
h = json.load(urllib.request.urlopen("http://127.0.0.1:8100/health"))
p = lambda xs, q: sorted(xs)[min(len(xs) - 1, int(q * len(xs)))]
print(json.dumps({"single_p50": statistics.median(single), "single_p95": p(single, .95), "batch8_p50": statistics.median(batch), "batch8_p95": p(batch, .95), "rss_mb": h["rss_mb"]}))
EOF
free -m | awk "/Mem:/{print \"available_mb=\" \$7}"'
