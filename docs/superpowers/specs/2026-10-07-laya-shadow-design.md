# Laya Shadow Model: Design Spec
**Date:** 2026-10-07
**Issue:** #5. This is piece 2 of the self-learning filter.
**Scope:** Fine-tune Laya on our own labels on minos (M4 Pro), serve it on bergholm.net as a third shadow model next to Ollama and Jev, and score it against the admin's decisions. Phase 2 adds distillation of Jev's questions once Jev coverage is large enough.

---

## Problem

The live filter is Ollama `gemma3:4b`. Jev is the comparison model, running in shadow mode as a hosted, paid API. The goal is a fully local filter that learns from our own data, with Jev used as a teacher.

Laya is a 322M–421M-parameter typed-decision model, Apache-2.0 licensed, with a Jev-compatible `/v1/systemone` server. Its base checkpoints are near chance until fine-tuned, so fine-tuning on our own labels is the whole point.

The label store (PR #4) holds about 50k judgements. It has plenty of rejects (13,694 keyword, 4,029 Ollama, 123 reader flags) but almost no usable keeps. The 32,928 historical Ollama keeps are ineligible, because they can't be told apart from outage keeps. Real Ollama keeps have been recorded only since 2026-10-07, and admin gold keeps grow by about 20 reviews a day.

## Goals

- A repeatable training pipeline: export on the server, then train, evaluate and deploy on minos, as one script.
- A `laya` service on bergholm.net that answers the Jev protocol for our checkpoint, listening on localhost only.
- A shadow step that stores Laya's answers per article and checkpoint, never affecting the feed.
- Laya added as a source on the scoreboard ("Against your decisions").
- A defined, flag-switched phase 2 for Jev distillation.

## Non-goals

- Changing the live filter (#7).
- Scheduled retraining or champion/challenger promotion (#6). In this piece, training is started by hand.
- ONNX or quantised serving. It is a later option if latency or RAM becomes a problem.

---

## Phase 1: data

### Available labels (production, 2026-10-07)

| Source | Articles |
|---|---|
| Keyword rejects | 13,701 |
| Ollama rejects (eligible) | 4,032 |
| Reader flags | 123 |
| Ollama keeps (eligible, recorded since 2026-10-07) | 4 |
| Trusted-source articles | 3,943 |
| Historical Ollama keeps (ineligible in the label store) | ~32,900 |
| Jev evaluations (keep by Jev's rule: 80) | 715 |
| Admin decisions | 0 (growing ~20/day) |

Keeps are scarce. Without historical keeps, every keep example would come from trusted sources, and Laya would learn those outlets' house style. Historical keeps are therefore included at low weight.

### Questions and contract

| Id | Type | Instructions | Options |
|---|---|---|---|
| `keep` | noul | "Does this article belong in a positive news feed: genuinely uplifting, hopeful or constructive news?" | false = reject, true = keep |
| `reason` | choice | "Which of these is the main reason this article does not belong in a positive news feed?" | the 17 Jev category keys (`cat_*`), each described by its label and `yes` text from `src/lib/jev.ts` |

- State is `buildState({ title, summary })` from `src/lib/jev.ts`, identical at training and inference.
- The questions, the state format and `LAYA_CONTRACT_VERSION = "1"` form the **contract**. `src/lib/laya.ts` exports it, together with `contractHash()` (sha256 of the canonical JSON). The export writes `contract.json` into every training run, and it is bundled with the checkpoint.
- The serving client sends the contract's questions and refuses to evaluate when the served checkpoint's contract hash differs from its own.

### One supervision result per article

For each article the export computes a single `{ label, p, source }`, and only then derives question targets. Sources are listed in precedence order; the first match wins:

| # | Source | Label | Target p(keep) |
|---|---|---|---|
| 1 | Current admin authority (gold) | its verdict | 1.0 or 0.0 |
| 2 | Reader flag (eligible), no admin authority | reject | 0.25 |
| 3 | Jev teacher: a `JevEvaluation` for the current `QUESTION_SET`, label from `deriveVerdict` (Jev's own rule) | keep or reject | 0.80 or 0.20 |
| 4 | Latest eligible Ollama event, live or backfilled | its verdict | 0.70 or 0.30 |
| 5 | Keyword reject | reject | 0.35 |
| 6 | Trusted-source article | keep | 0.65 |
| 7 | Historical Ollama keep (`historical approval (unverified)`) | keep | 0.60 |

- Targets are `0.5 ± 0.5 × weight`, with weights gold 1.0, flag 0.5, Jev 0.6, Ollama 0.4, keyword 0.3, trusted 0.3 and historical 0.2. They are named constants (`LAYA_WEIGHTS`), provisional until piece 3 calibrates them.
- Reader flags rank above the Jev teacher, as in the label store.
- Jev-evaluated articles without any other label become rows through source 3.

### Reason targets

The `reason` question is labelled **only** for articles whose supervision is a gold admin reject with a category. The target is a hard one-hot on that category.

Every other row carries no `gold.reason`. The pinned trainer skips questions a row doesn't label (`laya/train.py`: rows "simply do not label them"). No `none` option and no Jev-derived category targets exist in phase 1.

At inference `reason` is asked for every article, but it is only meaningful when `keepP < 0.5`.

### Splits

- **Test (`test.jsonl`):** cohort articles (`isTestCohort`) with gold labels. It is never used for training, epoch choice or the deploy gate, and is only reported.
- **Validation (`val.jsonl`):** a seeded 10% of non-cohort rows, stratified by label and source. It is used for `--eval` during training and for the deploy gate.
- **Train (`train.jsonl`):** the rest of the non-cohort rows.
- Cohort articles never appear in train or validation.

### Balance (best effort)

- Rows are balanced by **hard-label count** (keep rows vs reject rows), not by probability mass.
- All rows from sources 1–4 are kept. Sources 5, 6 and 7 are sampled with a fixed seed. Rejects (keyword) are sampled down to match keeps. Historical keeps are sampled up to the trusted-source count, so both keep styles are equally represented.
- If the 40–60% keep share can't be reached, the export proceeds and records `balance: "infeasible"` with the reason in the manifest. Both hard-label counts and the mean target mass are always reported.

### Export

`pnpm laya:export --out <dir> [--distill] [--seed N]`. The mapping is pure, in `src/lib/laya-export.ts` and unit-tested. DB access is in `scripts/laya-export.ts`. It reads the database directly, under a fixed event cutoff (the start time), because trusted-source and historical keeps aren't in the label export.

It writes:
- `train.jsonl`, `val.jsonl`, `test.jsonl`: Laya rows `{ id, state, language, questions, gold }`, using Laya's gold schema. For example `gold.keep.probabilities = { true: p, false: 1 − p }`.
- `test-compare.jsonl`: for each test article, its eligible Ollama verdict, its Jev verdict (with model and question set), or `null` where there is no coverage.
- `contract.json`.
- `manifest.json`:
  - the export id
  - the event cutoff
  - the sha256 of each data file
  - the contract hash
  - `QUESTION_SET`
  - weights and seed
  - counts by source, label, language and split
  - the balance status
  - the training article ids (`train-ids.txt` alongside)

## Training on minos

### Environment
- Host `minos.taila2b943.ts.net` (user `toni`): M4 Pro, 48 GB, 20 GPU cores, reached over Tailscale SSH from the session machine.
- `uv` installed in the user's home. Project folder `~/laya-positivenews` with Python 3.12 and a pinned `laya` version recorded in `pyproject.toml` / `uv.lock`.
- Base checkpoint: `convaiinnovations/laya-multilingual`.

### `train.sh` (kept in the repo under `laya/`)
1. **Preflight:**
   - At least 15 GB free on minos, otherwise refuse.
   - Mains power.
   - Prune old checkpoints to keep the newest 2.
2. **Fetch:** run `pnpm laya:export` on the server over SSH into a temp directory, then `rsync` it into `~/laya-positivenews/data/<export-id>/`.
3. **Train:** `caffeinate -i uv run laya-train --data train.jsonl --eval val.jsonl --base convaiinnovations/laya-multilingual --loss soft-ce --epochs E --micro-batch M --grad-accum G --out checkpoints/<date>-<export-id>/`.
   - E, M and G come from a timing run (`--timing`: 200 rows, 1 epoch) and are recorded in `train.env`.
4. **Evaluate:** `uv run python laya/evaluate.py` scores the new checkpoint and the untuned base on `test.jsonl` and writes `report.json` plus `report.md`.
5. Print the report path. Deploying is a separate, explicit step.

### Evaluation report (`laya/evaluate.py`)
- **On validation (gate) and test (report only),** overall, FI and EN:
  - n
  - accuracy and **balanced accuracy**
  - reject precision and recall
  - ECE (10 bins) on `keep`
  - the **majority-class baseline**
  - `reason` top-1 accuracy on rejects that have a category
- **Test only:** Jev and Ollama verdicts from `test-compare.jsonl`, with their coverage.
- **Gate (on validation):**
  - `pass` when balanced accuracy beats both the base model and the majority baseline by at least 0.02.
  - `experimental` when validation has fewer than 200 rows or test has fewer than 50. Deploying an experimental checkpoint requires `--experimental`, and the scoreboard caption shows it.
  - Otherwise `fail`. `laya-deploy.sh` refuses unless given `--force`.
- **Test numbers are never used to pick epochs or checkpoints.** With 0 admin decisions today, the first checkpoint's test set is empty, so the report says so.

---

## Serving on bergholm.net

**Releases.** Each deploy creates an immutable release directory, `~/apps/laya/releases/<release-id>/`, holding:
- `checkpoint/`
- `contract.json`
- `serve.py`
- `pyproject.toml` and `uv.lock`, with its own `.venv` created by `uv sync --frozen`

`~/apps/laya/current` is a symlink to the active release, and `~/apps/laya/last-good` is a text file naming the last release that passed the smoke test.

**`laya/serve.py`** builds `Router(models={"positivenews": "<release>/checkpoint"})` and serves:
- `POST /v1/systemone` and `POST /v1/systemone/batch` (max 8 states), with Jev-compatible shapes. The response's `model` field is the release's checkpoint id, so every answer carries the identity of the model that produced it.
- `GET /health`, returning the checkpoint id, the contract hash, the device, the process RSS and the in-flight request count.
- Inference runs serially, one request at a time, with a lock in the wrapper. `torch.set_num_threads(2)`. Requests beyond a queue of 4 get 503 with `Retry-After`, so client timeouts can't pile up work.

It listens on `127.0.0.1:8100` only. pm2 runs it as `laya`: `cwd` is `~/apps/laya/current`, and the command is `.venv/bin/python serve.py`. pm2 resolves the symlink at start, so a restart picks up the new release.

**`laya-deploy.sh`** runs on minos:
1. Check the gate status (`pass`, or `experimental` together with `--experimental`, or `--force`).
2. Rsync the release to a new release directory, then run `uv sync --frozen` there.
3. Switch atomically: `ln -s <release> current.tmp && mv -T current.tmp current`.
4. Start or restart: `pm2 describe laya && pm2 restart laya || pm2 start …` (first deploy). Then `pm2 save`.
5. Smoke-test `/health` (contract hash matches, model loaded) and one `/v1/systemone` request.
   - On failure, switch `current` back to `last-good` and restart.
   - On success, write `last-good`.
6. Keep `last-good`, `current` and the 2 newest other releases, and prune the rest.

**Rollback.** `laya-deploy.sh --rollback <release-id>` switches to a named release, defaulting to `last-good`.

**Benchmark before shadow traffic.** After the first deploy, `laya/bench.sh` sends 50 single and 10 batch-of-8 requests while Ollama is loaded. It records p50/p95 latency and peak RSS. Shadow traffic is enabled (`LAYA_URL` set) only if all three hold:
- p95 for a batch of 8 is under 20 s
- peak RSS is under 2.5 GB
- free memory stays above 1 GB

The client timeout is set to 2× the measured p95, with a minimum of 15 s.

## Shadow step

- **Data model:** a new `LayaEvaluation` model in one additive migration:

  ```prisma
  model LayaEvaluation {
    id         String   @id @default(cuid())
    article    Article  @relation(fields: [articleId], references: [id], onDelete: Cascade)
    articleId  String
    checkpoint String   // e.g. "2026-10-08-a1b2c3"
    keepP      Float
    reason     String   // top reason option
    reasonP    Float
    answers    Json
    latencyMs  Int
    createdAt  DateTime @default(now())
    @@unique([articleId, checkpoint])
    @@index([checkpoint, createdAt])
  }
  ```

  `Article` gets `layaEvaluations LayaEvaluation[]`. `scripts/cleanup.ts` also keeps articles that have Laya evaluations.
- **Client:** `src/lib/laya.ts` holds the contract (questions and state) and the client.
  - Each run first calls `/health` and skips the run with a warning if the contract hash differs from its own.
  - It posts batches to `${LAYA_URL}/v1/systemone/batch`, with the timeout from the benchmark, and stores the checkpoint id from each **response's** `model` field, never from `/health`.
  - It validates answers: `keepP` must be in [0, 1] and `reason` must be one of the options.
- **Step:** `src/lib/laya-shadow.ts` holds `layaShadowEvaluate({ since, limit, budgetMs })`.
  - Candidates: recent non-trusted articles plus test-cohort articles, with no `LayaEvaluation` for the current checkpoint.
  - Batches of 8, serial, within the budget.
  - Duplicates (P2002) are ignored. Errors are logged, never thrown into the pipeline.
- **Scheduling:** the Laya shadow step is **not** part of `runPipeline`, so it can't extend the pipeline lock. `src/lib/scheduler.ts` runs it on its own node-cron schedule (`7,22,37,52 * * * *`, offset from the pipeline) with an in-process guard against overlap, only when `LAYA_URL` is set. Limits: 2-day window, 80 articles, `budgetMs` 120000.
- **Backfill:** `pnpm laya:backfill --days 30 --limit 2000` evaluates history for a new checkpoint.

---

## Scoreboard

- `src/lib/scoreboard.ts` gains a `laya` source: keep when `keepP ≥ 0.5`.
- **One checkpoint per report:** the checkpoint of the most recent `LayaEvaluation`, which is the one currently served. The caption shows its id, whether it is experimental, and its coverage (n of the table's gold labels it evaluated). Rows from other checkpoints are ignored.
- **Laya appears only in the random-cohort table.** Cohort articles are never trained on, so these are honest held-out numbers. The targeted table includes articles a checkpoint may have trained on, so Laya is not shown there.

## Phase 2: Jev distillation

- **Trigger:** the export reports Jev coverage. `--distill` is used once at least 5,000 articles have a `JevEvaluation` for the current `QUESTION_SET`.
- **What changes:**
  - With `--distill`, each Jev-evaluated row also carries Jev's 20 questions, with Jev's answers as soft targets. The definitions are copied from `src/lib/jev.ts` `QUESTIONS` by key, and are part of contract version 2.
  - Nouls use `{true: p, false: 1 − p}`.
  - The Score uses its stored level `probabilities` only when they are present, valid and sum to more than 0. Otherwise the uplift question is omitted for that row. A distribution is never inferred from the scalar score.
- **Training and serving:** training is unchanged. The serving client keeps asking only `keep` and `reason`. The distilled questions improve the encoder, and can be asked later if useful.

---

## Configuration

| Variable | Where | Meaning |
|---|---|---|
| `LAYA_URL` | server `.env` | e.g. `http://127.0.0.1:8100`; unset means the shadow step is off |
| `LAYA_THREADS` | pm2 env for `laya` | torch CPU threads (2), applied with `torch.set_num_threads` in `serve.py` |
| `LAYA_PORT`, `LAYA_HOST` | pm2 env for `laya` | `8100`, `127.0.0.1` |

## Failure handling

| Failure | Behaviour |
|---|---|
| Laya down, slow, returning 503 or errors | The shadow step logs and skips, within the benchmark-derived timeout and 120 s budget. It runs outside `runPipeline`, so the pipeline is unaffected. |
| Contract hash mismatch | The shadow run is skipped with a warning |
| Malformed answer | That article gets no row and is retried next run |
| Release fails the smoke test | Deploy switches back to `last-good` automatically |
| Bad release discovered later | `laya-deploy.sh --rollback [release-id]` |
| minos has under 15 GB free, or is on battery | `train.sh` refuses to start |
| Training interrupted | Rerun; exports and checkpoints are per-run directories |

## Testing

- **Unit tests (Vitest), for `laya-export` mapping:**
  - single supervision precedence; flags beat the Jev teacher
  - the Jev label equals `deriveVerdict`, including category 0.55 with positive/uplifting 0.9 giving keep
  - targets per source
  - trusted-source and historical keeps
  - reason only for categorised gold rejects
  - cohort articles in neither train nor validation
  - the seeded, stratified validation split
  - hard-count balance, and an infeasible balance being reported
  - manifest counts and hashes
  - contract hash stability
- **Unit tests (Vitest)** for:
  - `laya` client parsing and validation, and the contract-hash refusal
  - the checkpoint id taken from the response
  - the shadow step's batching, budget and overlap guard (with an injected fetch)
  - the scoreboard Laya row: cohort-only, one checkpoint, coverage
- **Python:** `laya/evaluate.py` metric functions, tested with `pytest` on minos. No model weights needed.
- **End to end:**
  - a tiny training run on minos (300 rows, 1 epoch)
  - `serve.py` on minos
  - the shadow step from the session machine against the local database, using `LAYA_URL` over Tailscale
- **On the server:** the deploy smoke test (including a forced smoke failure that rolls back to `last-good` on a test release), `bench.sh` against the thresholds, one shadow run writing rows, and the scoreboard Laya row rendering.

## Rollout

1. Merge the export, the client, the shadow step, the schema and the scripts. The deploy migrates. `LAYA_URL` is unset, so nothing runs yet.
2. Set up minos and run the first training. The test set is empty until the cohort has gold labels, so the first checkpoint is `experimental`.
3. Set up `~/apps/laya` on the server, deploy with `--experimental`, then run `bench.sh`. Only if it meets the thresholds, set `LAYA_URL` and restart the app.
4. Run `pnpm laya:backfill` for history, then let the pipeline keep it current.
5. Phase 2 once Jev coverage reaches 5,000.

## Open questions

None blocking. Epoch count and batch size come from the timing run.
