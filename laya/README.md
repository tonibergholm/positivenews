# Laya shadow model

Python side of the Laya shadow evaluation (issue #5). Files:

- `laya_train.py` wraps `laya-train` with a device fix (see below).
- `train.sh` exports data from the server, trains on minos, then runs `evaluate.py`.
- `evaluate.py` and `metrics.py` score a checkpoint and the untuned base on val/test. They write `report.json` and `report.md` with a gate (`pass`, `fail` or `experimental`).
- `serve.py` is the Jev-compatible HTTP server (`/health`, `/v1/systemone`, `/v1/systemone/batch`).
- `deploy.sh` ships a checkpoint as an immutable release on the server. `bench.sh` benchmarks it.

## Setup

Install `uv` (`curl -LsSf https://astral.sh/uv/install.sh | sh`), then run `uv sync` in `laya/`. On minos the working copy is `~/laya-positivenews/src` (rsync `laya/` there). On the server, `deploy.sh` runs `uv sync --frozen` inside each release, so `uv.lock` must be committed. Tests: `uv run pytest -q`.

## Train (on minos, on AC power, 15 GB free)

```sh
laya/train.sh --timing     # 200 rows, 1 epoch: sizes the real run
laya/train.sh              # full run, 2 epochs by default
```

Flags: `--epochs`, `--micro-batch`, `--grad-accum`. Defaults can be overridden in `~/laya-positivenews/train.env`. `laya-train` holds out 10% of the train rows for calibration. It ignores the extra `id` and `language` keys.

`laya_train.py` exists because laya 0.3.29 runs its pre-training eval before moving the model to the device. On mps this fails with "Passed CPU tensor to MPS op". Remove the wrapper once upstream fixes it.

## Deploy (run on minos)

```sh
laya/deploy.sh <checkpoint-dir>                 # gate must be pass
laya/deploy.sh <checkpoint-dir> --experimental  # gate=experimental (small val/test sets)
laya/deploy.sh <checkpoint-dir> --force         # override a failed gate
laya/deploy.sh --rollback [release-id]          # default: last-good
```

A release lives in `~/apps/laya/releases/<id>` with `checkpoint/`, `contract.json`, `release.json`, `serve.py` and its own `.venv`. `current` is switched atomically and pm2 restarts `laya` on `127.0.0.1:8100`. A failed smoke test rolls back to `last-good`. The last two releases plus `last-good` are kept.

## Bench (run on minos, after deploy)

```sh
laya/bench.sh
```

Thresholds: batch-8 p95 under 20 s, `rss_mb` under 2500, `available_mb` over 1000. If any fails, roll back or lower `LAYA_THREADS`.

## Enable the shadow in the app

Set `LAYA_URL=http://127.0.0.1:8100` and `LAYA_TIMEOUT_MS` (60000 is a safe start) in the server `.env`, then restart the app. Remove `LAYA_URL` to disable. The app checks `contract_hash` from `/health` against its own `contractHash()`.

## Serving notes

`serve.py` binds to `127.0.0.1` unless `LAYA_HOST` is set. It runs one inference at a time (queue of 4, 503 beyond that, batch of at most 8 states). `rss_mb` is peak RSS.
