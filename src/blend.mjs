// The published forecast is a blend of two forecasters: the language model
// and the statistical baseline. Each is turned into log-odds, the two are
// weighted, and the result is stretched or shrunk toward 50%:
//   logit(p) = s * (w * logit(model) + (1 - w) * logit(baseline))
// w says how much to trust the model over the baseline; s below 1 pulls
// overconfident forecasts back toward the middle.
//
// Usage (run from the repo root):
//   node src/blend.mjs fit     fit w and s on the backtest and report how the
//                              blend would have scored on trials it never saw
//   node src/blend.mjs apply   blend the live forecasts with the live baseline
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const mode = process.argv[2];
if (mode !== "fit" && mode !== "apply") {
  console.error("usage: node src/blend.mjs <fit|apply>");
  process.exit(1);
}

const load = (path) => readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const probabilities = (path) =>
  new Map(load(path).filter((r) => typeof r.probability === "number").map((r) => [r.nct, r]));

// Log-odds blow up at 0 and 1, so forecasts are held inside 2% to 98%.
const logit = (p) => {
  const q = Math.min(0.98, Math.max(0.02, p));
  return Math.log(q / (1 - q));
};
const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const blend = (model, baseline, { w, s }) => sigmoid(s * (w * logit(model) + (1 - w) * logit(baseline)));

const PARAMS_PATH = "data/blend_params.json";

if (mode === "apply") {
  const params = JSON.parse(readFileSync(PARAMS_PATH, "utf8"));
  const base = probabilities("data/live_results.jsonl");
  const researched = existsSync("data/live_researched_results.jsonl")
    ? probabilities("data/live_researched_results.jsonl")
    : new Map();
  const baseline = probabilities("data/live_baseline_results.jsonl");
  const madeAt = new Date().toISOString();
  const lines = [];
  for (const [nct, b] of baseline) {
    // The evidence-backed forecast is used where one exists.
    const model = researched.get(nct) ?? base.get(nct);
    if (!model) continue;
    lines.push(
      JSON.stringify({
        nct,
        probability: blend(model.probability, b.probability, params),
        model: `blend-v1(w=${params.w},s=${params.s})`,
        madeAt,
      }),
    );
  }
  writeFileSync("data/live_blend_results.jsonl", lines.join("\n") + "\n");
  console.log(`blended ${lines.length} live forecasts with w=${params.w}, s=${params.s}`);
  process.exit(0);
}

// fit
const outcome = new Map();
for (const r of load("data/label_results.jsonl")) {
  if (r.label === "met") outcome.set(r.nct, 1);
  else if (r.label === "not_met") outcome.set(r.nct, 0);
}
const model = probabilities("data/forecast_results.jsonl");
const baseline = probabilities("data/baseline_results.jsonl");
const rows = load("data/cases.jsonl")
  .filter((c) => c.status !== "TERMINATED" && outcome.has(c.nct) && model.has(c.nct) && baseline.has(c.nct))
  .map((c) => ({
    nct: c.nct,
    y: outcome.get(c.nct),
    m: model.get(c.nct).probability,
    b: baseline.get(c.nct).probability,
    recalled: model.get(c.nct).recalls_result,
    // Trials that finished after mid-2025 are the ones the model is least
    // likely to have read about.
    recent: (c.primaryCompletion ?? "") >= "2025-07",
  }));

const brier = (list, p) => list.reduce((sum, r) => sum + (p(r) - r.y) ** 2, 0) / list.length;
const GRID = [];
for (let w = 0; w <= 1.0001; w += 0.05) {
  for (let s = 0.4; s <= 1.6001; s += 0.05) GRID.push({ w: +w.toFixed(2), s: +s.toFixed(2) });
}
const best = (list) => {
  let top = null;
  let topScore = Infinity;
  for (const g of GRID) {
    const score = brier(list, (r) => blend(r.m, r.b, g));
    if (score < topScore - 1e-12) {
      topScore = score;
      top = g;
    }
  }
  return top;
};

// The model's memory of a result is not a forecast, so the weights are fit
// only on trials it says it does not recall.
const fitSet = rows.filter((r) => !r.recalled);

// Leave one out: each trial is forecast by a blend fitted on all the others,
// so the reported score is for trials the blend never saw.
for (const r of fitSet) {
  r.cv = blend(r.m, r.b, best(fitSet.filter((o) => o !== r)));
}

const line = (title, list) => {
  if (list.length < 10) return console.log(`${title.padEnd(44)} n=${list.length} (too few)`);
  const rate = list.reduce((s, r) => s + r.y, 0) / list.length;
  const constant = brier(list, () => rate);
  const skill = (p) => `${((1 - brier(list, p) / constant) * 100).toFixed(1).padStart(6)}%`;
  console.log(
    `${title.padEnd(44)} n=${String(list.length).padEnd(4)} model ${skill((r) => r.m)}  baseline ${skill((r) => r.b)}  blend ${skill((r) => r.cv)}`,
  );
};
console.log("Brier skill against always guessing the base rate (higher is better; blend is leave-one-out)\n");
line("not recalled", fitSet);
line("not recalled, finished 2025-07 or later", fitSet.filter((r) => r.recent));
line("not recalled, finished before 2025-07", fitSet.filter((r) => !r.recent));

const params = best(fitSet);
writeFileSync(PARAMS_PATH, JSON.stringify({ ...params, fitOn: fitSet.length, fitAt: new Date().toISOString() }) + "\n");
console.log(`\nfitted on ${fitSet.length} trials: w=${params.w} (weight on the model), s=${params.s} (stretch)`);
console.log(`wrote ${PARAMS_PATH}`);
