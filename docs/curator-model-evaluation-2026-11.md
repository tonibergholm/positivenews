# Curator model evaluation (2026-11-04)

## Decision

On 2026-11-04, production switched the Ollama curator from `llama3.2:1b` to `gemma3:4b`, and the Laya shadow was stopped to free RAM.

## Why

`llama3.2:1b` rarely produced valid output for the 10-article two-pass prompt. Its responses were cut off at `num_predict` 2048, returned an empty `results` list, prefixed ids with `id:`, or copied the title into `reason`. Production stops a run after two failed batches, so most articles stayed uncurated. When it did decide, it kept nearly everything.

## Method

- **Labels.** Jev v1 verdicts from `deriveVerdict` with the default thresholds, for the 3,183 articles that have both a `llama3.2:1b` decision and a Jev evaluation. Jev keeps 15% of them.
- **Split.** A hash split into dev (1,907 rows) and holdout (1,276 rows). Every article with an admin or reader-flag label went to the holdout.
- **Scoring.** Each model was scored through an unchanged copy of `src/lib/curator/` (`curateOllama`, the production prompts, batches of 10, temperature 0.1) on an M4 Pro.
- **Server check.** Latency and RAM were measured on the production server with 20 articles per model.

Jev is a model, not ground truth. The numbers below measure agreement with Jev.

## Results on dev (1,907 articles)

| Model | Decided | Keep rate | Balanced acc. | Kappa | Keeps Jev also keeps |
|---|---|---|---|---|---|
| llama3.2:1b (previous) | 4% | 99% | 0.51 | 0.00 | 13% |
| gemma3:1b | 9% | 100% | 0.50 | 0.00 | 18% |
| llama3.2:3b | 28% | 9% | 0.74 | 0.34 | 29% |
| gemma3:4b | 82% | 44% | 0.75 | 0.29 | 31% |

Two candidates did not run on the evaluation machine's Ollama 0.40.8:

- `qwen3.5` (2b and 4b) returned `structured output is unavailable` for `format: "json"`.
- `Ahma-3B` (Finnish) failed because its head size of 100 does not divide into the `q8_0` K-cache block of 32.

Both remain untested.

## Holdout (1,276 articles), gemma3:4b

| | Decided | Keep rate | Balanced acc. (FI / EN) |
|---|---|---|---|
| All | 81% | 46% | 0.76 (0.75 / 0.74) |

The holdout includes 12 articles that readers flagged as not positive. `llama3.2:1b` had kept all 12. `gemma3:4b` rejects 9, keeps 2 and leaves 1 undecided.

## Production server (4 vCPU EPYC, CPU only, 7.7 GB RAM, no swap)

- `gemma3:4b` decided 20 of 20 articles in 147 s, including the model load. It needs about 2.9 GB loaded at a 4096-token context.
- That does not fit next to Laya (about 2.3 GB RSS) and other apps. Laya was stopped, and Ollama runs with `OLLAMA_MAX_LOADED_MODELS=1`.
- The default 30 s `CURATOR_TIMEOUT_MS` timed out every call. Production now uses `CURATOR_TIMEOUT_MS=90000` and `CURATOR_BUDGET_MS=300000`.
- The first run with these settings decided 30 articles (16 keep, 14 reject) with no timeouts.

## Known limits and next steps

- `gemma3:4b` is still lenient. It keeps about 46% of articles where Jev keeps 15%, and about 7 in 10 of its keeps are Jev rejects. For higher quality, use `CURATOR_PROVIDER=jev`, which costs API credits and no server RAM.
- Ten articles per call is hard for small models. Smaller batches may raise the decided rate for any model.
- Rollback: restore `.env.bak-20261104-pre-gemma` on the server, `pm2 start laya`, `pm2 restart positivenews`.
