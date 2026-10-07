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

### Questions

| Id | Type | Instructions | Options |
|---|---|---|---|
| `keep` | noul | "Does this article belong in a positive news feed: genuinely uplifting, hopeful or constructive news?" | false = reject, true = keep |
| `reason` | choice | "Which topic is this article mainly about?" | the 17 Jev category keys (`cat_*`) with their labels as descriptions, plus `none: "None of these; an ordinary positive story"` |

State is `buildState({ title, summary })` from `src/lib/jev.ts` (title plus trimmed summary of at most 300 characters). It is the same at training and inference.

### Keep targets (soft probabilities)

The target probability for the label is `0.5 + 0.5 × weight`:

| Source (first match wins, in this order) | Label | Weight | `keep.true` target |
|---|---|---|---|
| Current admin authority | its verdict | 1.0 | 1.0 or 0.0 |
| Reader flag (eligible, no admin authority) | reject | 0.5 | 0.25 |
| Live eligible Ollama event | its verdict | 0.4 | 0.70 or 0.30 |
| Keyword reject | reject | 0.3 | 0.35 |
| Trusted-source article (no events by design) | keep | 0.3 | 0.65 |
| Historical Ollama keep (`historical approval (unverified)`, ineligible in the label store) | keep | 0.2 | 0.60 |

**Jev as teacher, applied after the table.** If the article has a `JevEvaluation` for the current `QUESTION_SET` and its tier is below gold, the Jev keep probability `pJ = min(positiveP, upliftingP, 1 − topCategoryP)` replaces the target. A gold label is never overridden.

Weights are named constants in `src/lib/laya-export.ts` (`LAYA_WEIGHTS`). They are provisional: piece 3 recalibrates them from scoreboard precision.

### Reason targets

The `reason` question is trained only on rejects:
- An admin reject with a category gives a hard target on that category.
- A Jev-evaluated article whose resolved label is reject gets Jev's category Noul probabilities, normalised over the 17 categories, as a soft target.
- Other rejects carry no `reason` target. Ollama's free-text reasons are not mapped to categories.
- Keeps get a `none` target only from admin keeps (hard) or Jev-evaluated keeps (soft, `none` = 1 − max category probability, renormalised).

### Split and balance

- **Test cohort:** `isTestCohort(articleId)` articles are never in `train.jsonl`. `test.jsonl` contains only cohort articles with gold (admin) labels, with hard targets.
- **Balance:** all gold, flag, Jev-taught and live-Ollama rows are kept. Weak keyword rejects, trusted-source keeps and historical keeps are sampled down with a fixed seed so the expected keep and reject mass in `train.jsonl` is within 40–60% each. Without that cap, at most 20k rows are written per source group.
- **Language:** rows carry `language` for per-language evaluation. Training ignores it.

### Export

`pnpm laya:export --out <dir> [--distill] [--seed N]`, implemented in `src/lib/laya-export.ts` (pure mapping, tested) and `scripts/laya-export.ts` (DB access). It reads the database directly, not `labels:export`, because trusted-source articles and historical keeps aren't in the label export. It writes:
- `train.jsonl`: Laya rows `{ id, state, language, questions, gold }`
- `test.jsonl`: the same shape
- `manifest.json`: export id (timestamp plus short hash of the row ids), counts by source, label, language and split, the `QUESTION_SET` and the weights used

Rows use Laya's `gold` schema: `gold.keep.probabilities = { true: p, false: 1 − p }`, and `gold.reason.probabilities = { <option>: p, ... }`.

---

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
3. **Train:** `caffeinate -i uv run laya-train --data train.jsonl --eval test.jsonl --base convaiinnovations/laya-multilingual --loss soft-ce --epochs E --micro-batch M --grad-accum G --out checkpoints/<date>-<export-id>/`.
   - E, M and G come from a timing run (`--timing`: 200 rows, 1 epoch) and are recorded in `train.env`.
4. **Evaluate:** `uv run python laya/evaluate.py` scores the new checkpoint and the untuned base on `test.jsonl` and writes `report.json` plus `report.md`.
5. Print the report path. Deploying is a separate, explicit step.

### Evaluation report (`laya/evaluate.py`)
- **Overall, FI and EN:** n, accuracy, reject precision, reject recall, ECE (10 bins) on `keep`, plus `reason` top-1 accuracy on rejects that have a category.
- Jev and Ollama verdicts on the same test articles, from the export, for comparison.
- **Flag "indicative only"** when the test set has fewer than 50 rows.
- **Deploy gate:** `gate: pass` when the checkpoint's keep accuracy is at least the base model's, or the test set has fewer than 50 rows. Otherwise `gate: fail`, and `laya-deploy.sh` refuses unless given `--force`.

---

## Serving on bergholm.net

- **Folder:** `~/apps/laya` on the server, with `uv`, Python 3.12, and the same pinned `laya` version.
- **Wrapper:** `laya/serve.py`, kept in the repo and copied by deploy. It builds a `Router(models={"positivenews": "<checkpoints>/current"})` and exposes:
  - `POST /v1/systemone` and `POST /v1/systemone/batch` (max 16 states), with Jev-compatible request and response shapes
  - `GET /health`, returning the checkpoint id and the device
- **Binding and process:** listens on `127.0.0.1:8100` only, run by pm2 as `laya` with `LAYA_THREADS=2`. The model stays resident (~1.3 GB RAM).
- **Checkpoints:** `~/apps/laya/checkpoints/<id>/`, with `current` as a symlink.

`laya-deploy.sh` runs on minos:
1. Check the gate.
2. Rsync the checkpoint plus `serve.py`.
3. Switch the symlink atomically (`ln -sfn`, then `mv -T`).
4. `pm2 restart laya`.
5. Smoke-test `/health` and one `/v1/systemone` request. If the smoke test fails, roll back the symlink and restart.
6. Keep the 3 newest checkpoints on the server.

Rollback is `laya-deploy.sh --rollback`, which points `current` at the previous checkpoint.

---

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
- **Client:** `src/lib/laya.ts` holds the question definitions (shared with the export, so training and inference questions are identical) and the client. It posts to `${LAYA_URL}/v1/systemone/batch` with a 10-second timeout and a configured checkpoint id from `/health`, and parses and validates the answers: `keepP` must be in [0, 1] and `reason` must be one of the options.
- **Step:** `src/lib/laya-shadow.ts` holds `layaShadowEvaluate({ since, limit, budgetMs })`.
  - Candidates: recent non-trusted articles plus test-cohort articles, with no `LayaEvaluation` for the current checkpoint.
  - Batches of 16, with a 60-second budget.
  - Duplicates (P2002) are ignored. Errors are logged, never thrown into the pipeline.
- **Pipeline:** `runPipeline` calls the step after the Jev step, inside a catch-all, only when `LAYA_URL` is set. Limits: 2-day window, 100 articles, `budgetMs` 60000.
- **Backfill:** `pnpm laya:backfill --days 30 --limit 2000` evaluates history for a new checkpoint.

---

## Scoreboard

- `src/lib/scoreboard.ts` gains a `laya` source: keep when `keepP ≥ 0.5`. It uses the newest checkpoint that has evaluated the article, and the checkpoint id appears in the table caption.
- `loadScoreRows` includes the `LayaEvaluation` row for the current checkpoint.
- Laya appears in both the cohort and targeted tables, with the same columns as Jev and Ollama.

---

## Phase 2: Jev distillation

- **Trigger:** the export reports Jev coverage. `--distill` is used once at least 5,000 articles have a `JevEvaluation` for the current `QUESTION_SET`.
- **What changes:** with `--distill`, each Jev-evaluated row also carries Jev's 20 questions (definitions copied from `src/lib/jev.ts` `QUESTIONS`, by key), with Jev's answers as soft targets. Nouls use `{true: p, false: 1 − p}`. The Score uses its level probabilities.
- **Training and serving:** training is unchanged. The serving client keeps asking only `keep` and `reason`. The distilled questions improve the encoder, and can be asked later if useful.

---

## Configuration

| Variable | Where | Meaning |
|---|---|---|
| `LAYA_URL` | server `.env` | e.g. `http://127.0.0.1:8100`; unset means the shadow step is off |
| `LAYA_THREADS` | pm2 env for `laya` | torch CPU threads (2) |
| `LAYA_PORT`, `LAYA_HOST` | pm2 env for `laya` | `8100`, `127.0.0.1` |

## Failure handling

| Failure | Behaviour |
|---|---|
| Laya down, slow or returning errors | The shadow step logs and skips; 10s request timeout and 60s budget. Ingest and curation are unaffected. |
| Malformed answer | That article gets no row and is retried next run |
| Checkpoint fails the smoke test | Deploy rolls back automatically |
| Bad checkpoint discovered later | `laya-deploy.sh --rollback` |
| minos has under 15 GB free, or is on battery | `train.sh` refuses to start |
| Training interrupted | Rerun; exports and checkpoints are per-run directories |

## Testing

- **Unit tests (Vitest), for `laya-export` mapping:**
  - tier to target
  - Jev override below gold only
  - trusted-source and historical keeps
  - reason targets (admin hard, Jev soft, none)
  - cohort exclusion from train
  - the balance cap with a fixed seed
  - manifest counts
- **Unit tests (Vitest), for `laya` client parsing and validation**, the shadow step's batching and budget (with an injected fetch), and the scoreboard Laya row.
- **Python:** `laya/evaluate.py` metric functions, tested with `pytest` on minos. No model weights needed.
- **End to end:**
  - a tiny training run on minos (300 rows, 1 epoch)
  - `serve.py` on minos
  - the shadow step from the session machine against the local database, using `LAYA_URL` over Tailscale
- **On the server:** deploy smoke test, then one shadow run writing rows, then the scoreboard Laya row rendering.

## Rollout

1. Merge the export, the client, the shadow step, the schema and the scripts. The deploy migrates. `LAYA_URL` is unset, so nothing runs yet.
2. Set up minos and run the first training.
3. Set up `~/apps/laya` on the server, deploy the checkpoint, set `LAYA_URL` and restart the app.
4. Run `pnpm laya:backfill` for history, then let the pipeline keep it current.
5. Phase 2 once Jev coverage reaches 5,000.

## Open questions

None blocking. Epoch count and batch size come from the timing run.
