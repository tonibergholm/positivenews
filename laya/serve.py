"""Jev-compatible Laya server for the positivenews checkpoint.
Serial inference (one at a time), small queue, localhost only.
Run from a release dir: .venv/bin/python serve.py
"""
from __future__ import annotations
import json, os, resource, sys, threading
from pathlib import Path
import torch
import uvicorn
from fastapi import Body, FastAPI, HTTPException
from laya import Router

HERE = Path(__file__).resolve().parent
CONTRACT = json.loads((HERE / "contract.json").read_text())
RELEASE = json.loads((HERE / "release.json").read_text())  # {"checkpoint": id, "experimental": bool}
torch.set_num_threads(int(os.environ.get("LAYA_THREADS", "2")))
router = Router(models={"positivenews": str(HERE / "checkpoint")})
router.predict({"title": "warmup"}, {"keep": CONTRACT["questions"]["keep"]}, model="positivenews")

lock = threading.Lock()
in_flight = 0
in_flight_lock = threading.Lock()
MAX_QUEUE = 4
MAX_BATCH = 8
# ru_maxrss is KB on Linux, bytes on macOS.
RSS_UNIT = 1024 * 1024 if sys.platform == "darwin" else 1024
app = FastAPI()

def _admit():
    global in_flight
    with in_flight_lock:
        if in_flight >= MAX_QUEUE:
            raise HTTPException(status_code=503, detail="busy", headers={"Retry-After": "30"})
        in_flight += 1

def _release():
    global in_flight
    with in_flight_lock:
        in_flight -= 1

def _predict(state, questions):
    with lock:
        return router.predict(state, questions, model="positivenews")["answers"]

@app.get("/health")
def health():
    return {"checkpoint": RELEASE["checkpoint"], "experimental": RELEASE.get("experimental", False),
            "contract_hash": CONTRACT["hash"], "device": "cpu", "in_flight": in_flight,
            "rss_mb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / RSS_UNIT)}

# Sync handlers: FastAPI runs them in a threadpool, so /health stays responsive while
# inference holds `lock`. (An async handler calling blocking inference would stall the event loop.)
@app.post("/v1/systemone")
def one(body: dict = Body(...)):
    _admit()
    try:
        answers = _predict(body["state"], body["questions"])
    finally:
        _release()
    return {"model": RELEASE["checkpoint"], "experimental": RELEASE.get("experimental", False),
            "contract_hash": CONTRACT["hash"], "answers": answers}

@app.post("/v1/systemone/batch")
def batch(body: dict = Body(...)):
    states = body.get("states") or []
    if not isinstance(states, list) or not 1 <= len(states) <= MAX_BATCH:
        raise HTTPException(status_code=422, detail=f"states must be a list of 1..{MAX_BATCH}")
    _admit()
    try:
        results = [{"answers": _predict(s, body["questions"])} for s in states]
    finally:
        _release()
    return {"model": RELEASE["checkpoint"], "experimental": RELEASE.get("experimental", False),
            "contract_hash": CONTRACT["hash"], "results": results}

if __name__ == "__main__":
    uvicorn.run(app, host=os.environ.get("LAYA_HOST", "127.0.0.1"), port=int(os.environ.get("LAYA_PORT", "8100")), workers=1)
