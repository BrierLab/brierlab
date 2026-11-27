// Write MODEL.md, the learned model's fact sheet, from the test results in
// data/model/eval.json, so the document cannot drift from the numbers.
// Usage: node src/card.mjs
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const e = JSON.parse(readFileSync("data/model/eval.json", "utf8"));
const v1 = existsSync("data/model/eval-v1.json") ? JSON.parse(readFileSync("data/model/eval-v1.json", "utf8")) : null;
const pc = (x) => (x * 100).toFixed(1) + "%";
const n = (x) => x.toLocaleString("en-US");
const all = e.heldOut.all;
const rows = (list) => list.map((r) => `| ${r.join(" | ")} |`).join("\n");
const slice = (name, label) => {
  const s = e.heldOut[name];
  return s ? [label, s.boosted.n, pc(s.boosted.skill), s.boosted.auc.toFixed(3), pc(s.logistic.skill), pc(s.oldBaseline.skill)] : null;
};
const top = existsSync("data/model/top.json") ? JSON.parse(readFileSync("data/model/top.json", "utf8")) : null;
const f3 = (x) => x.toFixed(3);
const PH = ["I", "II", "III"];
// Published scores on the same benchmark. HINT, SPOT and LIFTED are from the
// LIFTED paper's table (arXiv 2402.06512); the language-model row is the best
// of four variants per phase from arXiv 2610.41710.
const PUBLISHED = [
  ["HINT (2022, as rerun in the LIFTED paper)", [0.621, 0.628, 0.708], [0.584, 0.591, 0.859]],
  ["SPOT (2023, as rerun in the LIFTED paper)", [0.646, 0.63, 0.71], [0.698, 0.626, 0.817]],
  ["LIFTED (2025)", [0.649, 0.651, 0.735], [0.707, 0.698, 0.883]],
  ["Biomedical language models (2026 preprint, best of four per phase)", [0.653, 0.701, 0.772], [0.68, 0.741, 0.901]],
];
const benchmark = !top
  ? ""
  : `## Public benchmark

TOP is the public test set from the HINT paper (Fu et al., 2022) that published trial-outcome models report on. We ran the same method on it: the same tree learner and the same kinds of inputs, trained on the benchmark's ${n(top.strict.trainedOn)} training and validation trials, then scored on its test trials. Settings were chosen on the validation trials. This tests the method, not the exact model that forecasts our open trials, because the benchmark's label is "the trial succeeded", which is broader than "the primary endpoint was met".

The headline run leaves out six inputs the registry rewrites after a trial ends (final headcount, final site list), because a stopped trial shows a small headcount and that gives the ending away.

ROC-AUC, higher is better. Ours shows the range from resampling the test trials.

| Model | Phase I (${top.strict.phases.I.n} trials) | Phase II (${n(top.strict.phases.II.n)}) | Phase III (${n(top.strict.phases.III.n)}) |
|---|---|---|---|
${rows([["**Brier Lab learned model**", ...PH.map((ph) => `**${f3(top.strict.phases[ph].roc)}** (${top.strict.phases[ph].rocRange.map(f3).join(" to ")})`)], ...PUBLISHED.map(([name, roc]) => [name, ...roc.map(f3)])])}

PR-AUC, higher is better.

| Model | Phase I | Phase II | Phase III |
|---|---|---|---|
${rows([["**Brier Lab learned model**", ...PH.map((ph) => `**${f3(top.strict.phases[ph].pr)}** (${top.strict.phases[ph].prRange.map(f3).join(" to ")})`)], ...PUBLISHED.map(([name, , pr]) => [name, ...pr.map(f3)])])}

How to read this:

- It is level with the best published results. It is ahead of HINT, SPOT and LIFTED on ROC-AUC in every phase, and ahead of every published number we found in Phase I on ROC-AUC.
- It is not shown to be the best. The 2026 language-model preprint is slightly higher in Phase III (0.772 against ${f3(top.strict.phases.III.roc)}) and about equal in Phase II. Those gaps are inside the ranges above, so the test cannot separate the two.
- On F1 it scores ${PH.map((ph) => f3(top.strict.phases[ph].f1)).join(", ")}. Saying "success" for every trial scores ${PH.map((ph) => f3(top.strict.phases[ph].f1AllYes)).join(", ")}. No model we found, ours included, clearly beats that, so F1 says little on this benchmark.
- With the six after-the-fact inputs put back, the same method scores ${PH.map((ph) => f3(top.full.phases[ph].roc)).join(", ")} on ROC-AUC. We do not count that run, and it is a reason to distrust any benchmark score that uses final headcounts.
- Published papers use slightly different versions of the benchmark files and different ways of averaging runs, so differences of a point or two between rows are not meaningful.
- The registry records are as they stand today, for us and for every other model on the list. Some text may have been edited after a trial ended.
- This run used the version 2 inputs minus the after-the-fact ones. The wider set we also scored (word-level track records added, which is most of what version 3 changed) came out at ${PH.map((ph) => f3(top.wide.phases[ph].roc)).join(", ")}, so version 3 would not be expected to move these numbers. We have not rerun the benchmark for version 3, to avoid looking at its test trials again.
- We looked at the test trials twice: once with one model, once with five averaged. The scores moved by at most 0.002. We also tried a wider input set (word-level track records); it did not help on the validation trials, scored about the same on the test trials, and is not the headline.

`;
const v2 = existsSync("data/model/eval-v2.json") ? JSON.parse(readFileSync("data/model/eval-v2.json", "utf8")) : null;
const prec = existsSync("data/model/precedents.json") ? JSON.parse(readFileSync("data/model/precedents.json", "utf8")) : null;
const v1Walk = v1 ? v1.walk.reduce((s, f) => s + f.boosted.skill * f.test, 0) / v1.walk.reduce((s, f) => s + f.test, 0) : null;

const md = `# The learned model

Generated by \`node src/card.mjs\` from \`data/model/eval.json\`. Do not edit by hand.

## What it is

A gradient-boosted decision tree model that estimates the chance a Phase 2 or Phase 3 drug trial meets its primary endpoint. It is ${e.chosen.trees} trees of depth ${e.chosen.depth} over ${e.features} inputs, written in plain JavaScript with no dependencies (\`src/gbm.mjs\`, about 150 lines). The same trees run in the browser on the site's How it works page and reproduce every sealed forecast exactly.

It runs beside the language-model forecast. It does not replace it, and nothing here says which of the two is better: that is decided by sealed forecasts on trials that have not reported.

## Data

- ${n(e.trainedOn)} randomized Phase 2 and 3 drug trials with results posted on ClinicalTrials.gov between 2008 and mid-2026. \`src/history.mjs\` downloads them; the data is public and free.
- The outcome label is read from the posted p-values on the first primary endpoint. Checked against a careful reading of 203 trials, this rule agreed on 93%.
- Trials that were terminated are left out of training.

## Inputs

- Facts from the registration record: phase, sponsor type, arms and what each arm gets, blinding, control, number of endpoints, endpoint type and timing, start year.
- Track records: how earlier trials turned out for the same sponsor, drug, drug at the same and the earlier phase, drug in the same disease, condition, disease category and endpoint wording, and for trials that shared words in the title, drug names or entry criteria.

## Guards against hindsight

- A trial's track-record inputs count only results that were public before that trial's own primary completion date. No trial sees its own result or anything later.
- Status, stop reasons, completion dates and results dates are never inputs.
- The registry's drug tags are not used. A drug tends to get a tag once it is well known, which would leak the outcome.
- The fields the registry rewrites once a trial ends (final headcount, final site list and countries) are not inputs. Versions 1 and 2 used them; version 3 does not.
- Known gap: other text in a registry record can still be edited after a trial ends, so live performance may be lower than the tests below.

## How it is tested

1. Walk-forward. Train on everything posted before a date, test on the next twelve months, four times. Model settings are chosen here.
2. Held-out. Trials whose results were posted on or after 15 July 2026, never used for training or for choosing settings. This set has now been looked at for three model versions, so its number is less clean than the walk-forward one.
3. Learning curve. The same settings trained on random subsets of the history, tested on the held-out trials. The track-record inputs are still built from the full history, so the small-subset rows flatter the model.

"Skill" is the share of squared error removed compared with always guessing the average success rate. Zero means no better than that guess.

## Results

Walk-forward, ${n(e.walkAll.n)} trials: skill ${pc(e.walkAll.skill)}, AUC ${e.walkAll.auc.toFixed(3)}, Brier ${e.walkAll.brier.toFixed(4)}. Logistic regression on the same inputs: ${pc(e.walkAll.logistic)}.

| Test year from | Trained on | Tested on | Skill | AUC | Logistic skill |
|---|---|---|---|---|---|
${rows(e.walk.map((f) => [f.from, n(f.train), f.test, pc(f.boosted.skill), f.boosted.auc.toFixed(3), pc(f.logistic)]))}

Held-out trials:

| Slice | Trials | Skill | AUC | Logistic, same inputs | Earlier 12-input baseline |
|---|---|---|---|---|---|
${rows([slice("all", "All"), slice("industry", "Industry sponsor"), slice("Phase 3", "Phase 3"), slice("language model does not recall", "Trials the language model does not recall")].filter(Boolean))}

The last row is the hard one: these are lesser-known trials with a ${pc(e.heldOut["language model does not recall"]?.boosted.rate ?? 0)} success rate, far below the average the model was trained on, and it adds almost nothing there.

Learning curve:

| Past trials trained on | Skill | AUC |
|---|---|---|
${rows(e.curve.map((c) => [n(c.size), pc(c.skill), c.auc.toFixed(3)]))}

What it leans on most (share of total split gain): ${e.importance.slice(0, 8).map((f) => `${f.name} ${Math.round(f.share * 100)}%`).join(", ")}.

${prec ? `## Precedent memory

The model can cite what a forecast rests on. Two trials count as alike when the trees sort them the same way: similarity is the share of the ${e.chosen.trees} trees in which both end in the same leaf. For every open trial, \`node src/train.mjs precedents\` lists the ${prec.near} past trials most like it and what happened to them. The site shows the closest eight.

- The precedents are alike in the ways the model weighs (sponsor, design, track record). They are often in a different disease.
- Tested on the same ${n(prec.walk.n)} walk-forward trials: a forecast made from the ${prec.near} closest precedents alone has skill ${pc(prec.walk.alone)} and AUC ${prec.walk.aloneAuc.toFixed(3)}, against ${pc(prec.walk.trees)} for the full model.
- Blending the two scored ${pc(prec.walk.blend)}, no better than the trees alone. So precedents explain a forecast and do not change it.
- Leaf-sharing similarity is a known technique from tree models in general. We did not find it used to cite precedents in published trial-outcome models, but we have not searched exhaustively and do not claim it is new.

` : ""}${benchmark}## Limits

- No live trial has been scored yet. Every number above is a test on past trials.
${top ? "- On the public benchmark the method is level with the best published models, not ahead of all of them. See above." : "- No comparison with other published models has been run."}
- It reads the registry record only. It knows nothing about the drug's biology, earlier data that was never posted to the registry, or news.
- Retraining is run by hand (\`npm run retrain\`). Each retrain is sealed as a new version before its forecasts are shown.

## Versions

${v1 ? `- v1: ${v1.features} inputs, ${v1.chosen.trees} trees. Walk-forward skill ${pc(v1Walk)}, held-out skill ${pc(v1.heldOut.all.boosted.skill)}, AUC ${v1.heldOut.all.boosted.auc.toFixed(3)}.\n` : ""}${v2 ? `- v2: ${v2.features} inputs, ${v2.chosen.trees} trees. Added disease categories, drug history by phase and by disease, endpoint timing, and a wider settings search. Walk-forward skill ${pc(v2.walkAll.skill)}, held-out skill ${pc(v2.heldOut.all.boosted.skill)}, AUC ${v2.heldOut.all.boosted.auc.toFixed(3)}.\n` : ""}- v3: ${e.features} inputs, ${e.chosen.trees} trees. Drops the six inputs the registry rewrites after a trial ends, and adds more design facts and word-level track records. Walk-forward skill ${pc(e.walkAll.skill)}, held-out skill ${pc(all.boosted.skill)}, AUC ${all.boosted.auc.toFixed(3)}.

## Reproduce

\`\`\`
npm run history            # download the training history (about 290 MB)
node src/train.mjs eval    # walk-forward, held-out and learning-curve tests
node src/train.mjs fit     # train on everything, forecast the open trials
node src/train.mjs precedents  # the past trials each open forecast rests on
node src/top.mjs fetch     # public benchmark: registry records for its trials (its tables go in data/top/ first)
node src/top.mjs eval      # public benchmark: train on its training trials, score its test trials
node src/card.mjs          # rewrite this file
\`\`\`
`;
writeFileSync("MODEL.md", md);
console.log("wrote MODEL.md");
