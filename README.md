# Brier Lab

Forecasts of whether Phase 2 and 3 drug trials will meet their primary endpoint. Each forecast is sealed before the result is known and scored in public when the trial reports.

Site: https://brierlab.com

## Status

- 539 forecasts across 505 trials are sealed in `data/sealed/live-2026-11-22.json`.
- Nothing has been scored yet. No accuracy is claimed.
- The step that looks up each trial's real result and scores the forecast is not built yet.
- The backtest files in `data/` (`forecast_results.jsonl`, `label_results.jsonl`, `baseline_results.jsonl`) are not evidence of skill. The model had already seen many of those results, so scores computed from them are contaminated. Only forecasts sealed before a result count.

## How it works

1. `src/fetch.mjs` pulls trial records from the ClinicalTrials.gov API.
2. `src/prepare.mjs` builds one case per trial, with outcome-revealing fields removed.
3. `src/batch.mjs` runs the model over the cases: a forecast from the record alone, an evidence brief from a web search for the trials closest to reporting, and a second forecast that uses the brief.
4. `src/baseline.mjs` fits a plain logistic regression on record features, as the comparison.
5. `src/seal.mjs` hashes every forecast and folds the hashes into one Merkle root.
6. `src/site.mjs` builds the site's data from the sealed file. The site never shows a number that is not in it.
7. `src/score.mjs` computes Brier score and AUC.

Each script has a usage note at the top.

## Checking the seal

Download the sealed file from the site's Verify section and run the two short scripts shown there. One rehashes a single forecast, the other rebuilds the root. The root of the first record was submitted to OpenTimestamps on 24 November 2026; the proof is `data/sealed/live-2026-11-22.root.ots`.

## Running it

Needs Node 20 or later and no dependencies. Model calls go through OpenRouter; set `OPENROUTER_API_KEY`.

```
npm run site      # build site data and serve the site at localhost:4173
npx wrangler deploy
```

Trial records come from ClinicalTrials.gov. Brier Lab is independent and is not affiliated with any trial sponsor or regulator. Nothing here is medical or investment advice.
