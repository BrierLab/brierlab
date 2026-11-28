# Brier Lab

Forecasts of whether Phase 2 and 3 drug trials will meet their primary endpoint. Each forecast is sealed before the result is known and scored in public when the trial reports.

Site: https://brierlab.com

## Status

- 539 forecasts across 505 trials are sealed in `data/sealed/live-2026-11-22.json`.
- A second forecaster, a learned model (boosted decision trees trained on about 9,400 past trials from the registry), has its own forecasts for the same 505 trials sealed in `data/sealed/live-2026-11-27-ml.json`. [MODEL.md](MODEL.md) is its fact sheet: data, inputs, tests, results and limits. It runs live in the browser at https://brierlab.com/how. Each of its forecasts cites its precedents: the past trials the trees sort the same way, with their outcomes (`node src/train.mjs precedents`). On TOP, the public benchmark that published trial-outcome models report on, the same method scores ROC-AUC 0.677, 0.698 and 0.761 for Phases I, II and III: level with the best published results, not shown to be ahead of all of them (`src/top.mjs`, table in MODEL.md).
- Nothing has been scored yet. No accuracy is claimed. The step that checks results exists (`src/resolve.mjs`); its first run found two trials whose results were announced before the seal, and those are recorded and not scored.
- Evidence reports can be requested on the site for any sealed trial that has only a record-based forecast (`src/ondemand.mjs`). A few are free each day. Each report's forecast is hashed and submitted to OpenTimestamps when it is made, and `src/pull.mjs` copies the reports into `data/on_demand_results.jsonl`.
- The backtest files in `data/` (`forecast_results.jsonl`, `label_results.jsonl`, `baseline_results.jsonl`) are not evidence of skill. The model had already seen many of those results, so scores computed from them are contaminated. Only forecasts sealed before a result count.
- The learned model's test in `data/model/eval.json` uses trials it never trained on, and since version 3 it does not use the fields the registry rewrites after a trial ends (final headcount, site list). Other text in a record can still be edited, so its live results may be lower.

## How it works

1. `src/fetch.mjs` pulls trial records from the ClinicalTrials.gov API.
2. `src/prepare.mjs` builds one case per trial, with outcome-revealing fields removed.
3. `src/batch.mjs` runs the model over the cases: a forecast from the record alone, an evidence brief from a web search for the trials closest to reporting, and a second forecast that uses the brief.
4. `src/baseline.mjs` fits a plain logistic regression on record features, as the comparison.
5. `src/history.mjs` pulls every past trial with posted results, and `src/train.mjs` trains and tests the learned model on them (`src/gbm.mjs` is the tree learner, `src/mlfeatures.mjs` the features). Each trial is described only by what was public before it read out. `npm run retrain` pulls newly posted results, retests and refits; it is run by hand. `src/card.mjs` rewrites MODEL.md from the test results.
6. `src/seal.mjs` hashes every forecast and folds the hashes into one Merkle root.
7. `src/site.mjs` builds the site's data from the sealed file. The site never shows a number that is not in it.
8. `src/score.mjs` computes Brier score and AUC.
9. `src/resolve.mjs` checks the sealed trials against the registry (`check`), records each known result in `data/outcomes.jsonl` with its source and the words that decide it (`add`), and prints the live score (`score`). The scoring rules are at the top of `src/outcomes.mjs`. The registry check is automatic; finding and reading a sponsor's announcement is done by hand. The site also asks the registry live, at most every six hours, through `/api/watch` in `src/worker.mjs`, and shows what has changed since sealing.

10. `src/ondemand.mjs` runs in the site's worker: on request it reads a trial's registry record, gathers an evidence brief, forecasts with it, and records the forecast's hash with an OpenTimestamps proof. `src/pull.mjs` copies those reports into the repository, and they are scored under rule 5 in `src/outcomes.mjs`.
11. `src/token.mjs` holds the worker's wallet checks (sign-in by signature, a balance check, a burn check). They are off unless a token address is configured, and none is. `src/launch.mjs <token address>` is the one command that switches them on: it reads the token from the chain, refuses anything that does not look like a plain token, writes the settings, opens the holders-first window on any held batch, deploys, and checks what the live site serves.
12. A later batch of forecasts is made with the same scripts, with its files under `data/batches/<seal-name>/`, sealed with `src/seal.mjs` and timestamped with `src/stamp.mjs`. `src/early.mjs hold` takes it out of public view (its fingerprint and timestamp proof stay public), and `src/early.mjs open` starts a window in which the worker serves it only to wallets that pass the balance check. When the window has passed, the next `src/site.mjs` run releases it into the record (`src/batches.mjs`), where it is checked and scored like the first.

Each script has a usage note at the top.

## Checking the seal

Download the sealed file from the site's Verify section and run the two short scripts shown there. One rehashes a single forecast, the other rebuilds the root. The root of the first record was submitted to OpenTimestamps on 24 November 2026; the proof is `data/sealed/live-2026-11-22.root.ots`.

## Running it

Needs Node 20 or later. The forecasting and scoring scripts have no dependencies; the site's worker uses two small libraries for checking wallet signatures (`npm install`). Model calls go through OpenRouter; set `OPENROUTER_API_KEY`. The worker needs its own secrets (`OPENROUTER_KEY`, `SESSION_SECRET`) and a `REPORTS` key-value store.

```
npm run site      # build site data and serve the site at localhost:4173
npx wrangler deploy
```

Trial records come from ClinicalTrials.gov. Brier Lab is independent and is not affiliated with any trial sponsor or regulator. Nothing here is medical or investment advice.
