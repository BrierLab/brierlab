// Train and test the learned model.
//   node src/train.mjs eval   walk-forward test on past years, then the held-out
//                             recent trials, then a learning curve
//   node src/train.mjs fit    train on every resolved trial and forecast the live ones
//   node src/train.mjs features   write the live trials' inputs, so the site can rerun the model in the browser
// Training data: data/history_raw.jsonl (src/history.mjs). Every trial is
// described only by what was public before it read out.
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { ruleLabel } from "./features.mjs";
import { fit, importance, predict, rng } from "./gbm.mjs";
import { TrackRecord, keys, staticFeatures, time } from "./mlfeatures.mjs";

const mode = process.argv[2];
if (!["eval", "fit", "features"].includes(mode)) {
  console.error("usage: node src/train.mjs eval|fit|features");
  process.exit(1);
}
const DAY = 86_400_000;
const lines = (path) => readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

// One row per trial: when its result became public, and the last moment a
// forecast of it could honestly have been made (its primary completion date).
function row(p, label, source) {
  const st = p.statusModule ?? {};
  const posted = time(st.resultsFirstPostDateStruct?.date);
  let known = time(st.primaryCompletionDateStruct?.date) ?? time(st.completionDateStruct?.date);
  if (posted != null && (known == null || known >= posted)) known = posted - (known == null ? 365 * DAY : DAY);
  return {
    nct: p.identificationModule.nctId,
    source,
    label,
    posted,
    known,
    status: st.overallStatus,
    industry: p.sponsorCollaboratorsModule?.leadSponsor?.class === "INDUSTRY",
    phase3: (p.designModule?.phases ?? []).includes("PHASE3"),
    stat: staticFeatures(p),
    keys: keys(p),
  };
}

const history = [];
for await (const line of createInterface({ input: createReadStream("data/history_raw.jsonl") })) {
  const s = JSON.parse(line);
  const label = ruleLabel(s.primaries);
  if (label != null) history.push(row(s.protocolSection, label, "history"));
}

// Held-out trials: results posted after the history window. Graded by the
// model grader where it gave a verdict, which is stricter than the p-value rule.
const grade = new Map();
for (const r of existsSync("data/label_results.jsonl") ? lines("data/label_results.jsonl") : []) {
  if (r.label === "met") grade.set(r.nct, 1);
  else if (r.label === "not_met") grade.set(r.nct, 0);
}
const held = [];
for (const s of lines("data/test_raw.jsonl")) {
  const primaries = (s.resultsSection?.outcomeMeasuresModule?.outcomeMeasures ?? []).filter((o) => o.type === "PRIMARY");
  const nct = s.protocolSection.identificationModule.nctId;
  const label = grade.get(nct) ?? null;
  const rule = ruleLabel(primaries);
  if (label == null && rule == null) continue;
  const r = row(s.protocolSection, label ?? rule, "held");
  r.graded = label != null;
  r.rule = rule;
  held.push(r);
}

// Fill in track-record features. Results are filed in the order they became
// public, and each trial is read just before its own readout, so no trial
// ever sees its own result or anything that came later.
function addTrackRecords(queries, resolved, now) {
  const filed = [...resolved].sort((a, b) => a.posted - b.posted);
  const asked = [...queries].sort((a, b) => (a.known ?? now) - (b.known ?? now));
  const record = new TrackRecord();
  let i = 0;
  for (const q of asked) {
    const at = q.known ?? now;
    while (i < filed.length && filed[i].posted < at) {
      record.add(filed[i].keys, filed[i].label);
      i++;
    }
    q.x = { ...q.stat, ...record.read(q.keys) };
  }
}

const usable = (r) => r.status !== "TERMINATED"; // a terminated trial's enrollment count gives the ending away
const brier = (rows, p) => rows.reduce((s, r, i) => s + (p[i] - r.label) ** 2, 0) / rows.length;
function auc(rows, p) {
  const idx = rows.map((_, i) => i).sort((a, b) => p[a] - p[b]);
  let rank = 0;
  let pos = 0;
  for (let k = 0; k < idx.length; ) {
    let j = k;
    while (j < idx.length && p[idx[j]] === p[idx[k]]) j++;
    for (let m = k; m < j; m++) if (rows[idx[m]].label === 1) (rank += (k + j + 1) / 2), pos++;
    k = j;
  }
  const neg = rows.length - pos;
  return pos && neg ? (rank - (pos * (pos + 1)) / 2) / (pos * neg) : NaN;
}
function score(rows, p) {
  const rate = rows.reduce((s, r) => s + r.label, 0) / rows.length;
  const b = brier(rows, p);
  return { n: rows.length, rate, brier: b, skill: 1 - b / (rate * (1 - rate)), auc: auc(rows, p) };
}
const show = (name, s) =>
  console.log(
    `  ${name.padEnd(38)} n=${String(s.n).padEnd(5)} success ${(s.rate * 100).toFixed(0).padStart(3)}%  Brier ${s.brier.toFixed(4)}  skill ${(s.skill * 100).toFixed(1).padStart(6)}%  AUC ${s.auc.toFixed(3)}`,
  );

let names;
const vec = (r) => names.map((n) => r.x[n]);

// Plain logistic regression on the same features, as the simple model to beat.
function logistic(train) {
  const X0 = train.map(vec);
  const mean = names.map((_, j) => X0.reduce((s, r) => s + r[j], 0) / X0.length);
  const sd = names.map((_, j) => Math.sqrt(X0.reduce((s, r) => s + (r[j] - mean[j]) ** 2, 0) / X0.length) || 1);
  const X = X0.map((r) => r.map((v, j) => (v - mean[j]) / sd[j]));
  let w = names.map(() => 0);
  let bias = 0;
  for (let step = 0; step < 400; step++) {
    const gw = names.map(() => 0);
    let gb = 0;
    for (let i = 0; i < X.length; i++) {
      let z = bias;
      for (let j = 0; j < w.length; j++) z += X[i][j] * w[j];
      const err = 1 / (1 + Math.exp(-z)) - train[i].label;
      gb += err;
      for (let j = 0; j < w.length; j++) gw[j] += err * X[i][j];
    }
    bias -= (0.3 * gb) / X.length;
    w = w.map((wj, j) => wj - 0.3 * (gw[j] / X.length + 0.02 * wj));
  }
  return (r) => {
    let z = bias;
    vec(r).forEach((v, j) => (z += ((v - mean[j]) / sd[j]) * w[j]));
    return 1 / (1 + Math.exp(-z));
  };
}

const GRID = [];
for (const depth of [2, 3, 4]) for (const minLeaf of [25, 60]) GRID.push({ depth, minLeaf });
const STAGES = [100, 200, 300, 450, 600];
const train = (rows, o) => fit(rows.map(vec), rows.map((r) => r.label), { rate: 0.03, ...o });

mkdirSync("data/model", { recursive: true });

if (mode === "eval") {
  const now = Date.now();
  addTrackRecords([...history, ...held], history, now);
  names = Object.keys(history[0].x);
  const pool = history.filter(usable);
  console.log(`history: ${history.length} labelled trials, ${pool.length} usable for training, ${names.length} features\n`);

  // 1. Walk forward: train on everything posted before a date, test on the next stretch.
  const folds = [
    ["2022-07-15", "2023-07-15"],
    ["2023-07-15", "2024-07-15"],
    ["2024-07-15", "2025-07-15"],
    ["2025-07-15", "2026-07-15"],
  ].map(([a, z]) => ({ a, tr: pool.filter((r) => r.posted < time(a)), te: pool.filter((r) => r.posted >= time(a) && r.posted < time(z)) }));
  const table = new Map();
  const walk = [];
  for (const f of folds) {
    const lg = logistic(f.tr);
    const fold = { from: f.a, train: f.tr.length, test: f.te.length, logistic: score(f.te, f.te.map(lg)).skill, settings: {} };
    for (const g of GRID) {
      const m = train(f.tr, { ...g, trees: STAGES.at(-1) });
      for (const stage of STAGES) {
        const key = `${g.depth}/${g.minLeaf}/${stage}`;
        const s = score(f.te, f.te.map((r) => predict(m, vec(r), stage)));
        fold.settings[key] = s;
        table.set(key, [...(table.get(key) ?? []), s.brier]);
      }
    }
    walk.push(fold);
  }
  const ranked = [...table].map(([key, v]) => [key, v.reduce((s, x) => s + x, 0) / v.length]).sort((a, b) => a[1] - b[1]);
  const [depth, minLeaf, trees] = ranked[0][0].split("/").map(Number);
  const chosen = { depth, minLeaf, trees };
  console.log("walk-forward (settings chosen here, before looking at the held-out trials):");
  for (const f of walk) {
    const s = f.settings[ranked[0][0]];
    console.log(`  from ${f.from}: train ${f.train}, test ${f.test}  boosted skill ${(s.skill * 100).toFixed(1)}% AUC ${s.auc.toFixed(3)}  logistic skill ${(f.logistic * 100).toFixed(1)}%`);
  }
  console.log(`  chosen settings: depth ${depth}, min leaf ${minLeaf}, ${trees} trees\n`);

  // 2. The held-out trials, touched once with the chosen settings.
  const test = held.filter(usable);
  const model = train(pool, chosen);
  const pm = test.map((r) => predict(model, vec(r)));
  const lg = logistic(pool);
  const pl = test.map(lg);
  const load = (path) => new Map(existsSync(path) ? lines(path).filter((r) => typeof r.probability === "number").map((r) => [r.nct, r]) : []);
  const old = load("data/baseline_results.jsonl");
  const llm = load("data/forecast_results.jsonl");
  console.log("held-out trials (results posted 2026-07-15 or later, never trained on):");
  const slices = {
    "all": () => true,
    "industry": (r) => r.industry,
    "Phase 3": (r) => r.phase3,
    "language model does not recall": (r) => llm.has(r.nct) && !llm.get(r.nct).recalls_result,
    "not recalled, done 2025-07 or later": (r) => llm.has(r.nct) && !llm.get(r.nct).recalls_result && r.known >= time("2025-07-01"),
  };
  const heldOut = {};
  for (const [name, keep] of Object.entries(slices)) {
    const idx = test.map((r, i) => i).filter((i) => keep(test[i]) && old.has(test[i].nct) && llm.has(test[i].nct));
    if (idx.length < 10) continue;
    const rows = idx.map((i) => test[i]);
    console.log(` ${name}`);
    const out = {
      boosted: score(rows, idx.map((i) => pm[i])),
      logistic: score(rows, idx.map((i) => pl[i])),
      oldBaseline: score(rows, rows.map((r) => old.get(r.nct).probability)),
      languageModel: score(rows, rows.map((r) => llm.get(r.nct).probability)),
      average: score(rows, idx.map((i) => (pm[i] + llm.get(test[i].nct).probability) / 2)),
    };
    show("boosted trees (new)", out.boosted);
    show("logistic, same features", out.logistic);
    show("old 12-feature baseline", out.oldBaseline);
    show("language model (hindsight risk)", out.languageModel);
    show("average of boosted + language model", out.average);
    heldOut[name] = out;
  }

  // 3. Learning curve: same test, more and more training trials.
  console.log("\nlearning curve on the held-out trials (random subsets of history, 4 draws each):");
  const curve = [];
  for (const size of [250, 500, 1000, 2000, 4000, pool.length]) {
    const runs = [];
    for (let seed = 1; seed <= (size === pool.length ? 1 : 4); seed++) {
      const rand = rng(seed * 101);
      const sub = size === pool.length ? pool : [...pool].map((r) => [rand(), r]).sort((a, b) => a[0] - b[0]).slice(0, size).map((x) => x[1]);
      const m = train(sub, { ...chosen, seed });
      runs.push(score(test, test.map((r) => predict(m, vec(r)))));
    }
    const avg = (k) => runs.reduce((s, r) => s + r[k], 0) / runs.length;
    curve.push({ size, skill: avg("skill"), auc: avg("auc") });
    console.log(`  ${String(size).padStart(5)} trials: skill ${(avg("skill") * 100).toFixed(1).padStart(5)}%  AUC ${avg("auc").toFixed(3)}`);
  }

  console.log("\nwhat the model leans on:");
  const imp = importance(model, names).slice(0, 12);
  for (const f of imp) console.log(`  ${f.name.padEnd(22)} ${(f.share * 100).toFixed(1)}%`);

  writeFileSync(
    "data/model/eval.json",
    JSON.stringify({ ranAt: new Date().toISOString(), trainedOn: pool.length, features: names.length, chosen, walk: walk.map((f) => ({ from: f.from, train: f.train, test: f.test, logistic: f.logistic, boosted: f.settings[ranked[0][0]] })), heldOut, curve, importance: imp }, null, 1),
  );
  console.log("\nwrote data/model/eval.json");
}

if (mode === "fit" || mode === "features") {
  const evalPath = "data/model/eval.json";
  if (!existsSync(evalPath)) throw new Error("run `node src/train.mjs eval` first: it chooses the settings");
  const { chosen } = JSON.parse(readFileSync(evalPath, "utf8"));
  const now = Date.now();
  const live = lines("data/live_raw.jsonl").map((s) => ({ ...row(s.protocolSection, null, "live"), known: now }));
  const resolved = [...history, ...held.map((r) => ({ ...r }))];
  addTrackRecords([...resolved, ...live], resolved, now);
  names = Object.keys(resolved[0].x);
  const pool = resolved.filter(usable);
  writeFileSync("data/model/live_features.json", JSON.stringify({ names, vectors: Object.fromEntries(live.map((r) => [r.nct, vec(r)])) }));
  if (mode === "features") {
    console.log(`wrote inputs for ${live.length} live trials to data/model/live_features.json`);
    process.exit(0);
  }
  const model = train(pool, chosen);
  const version = `gbm-v1(n=${pool.length})`;
  const madeAt = new Date().toISOString();
  writeFileSync("data/model/gbm-v1.json", JSON.stringify({ version, madeAt, trainedOn: pool.length, features: names, ...model }));
  writeFileSync("data/live_ml_results.jsonl", live.map((r) => JSON.stringify({ nct: r.nct, probability: predict(model, vec(r)), model: version, madeAt })).join("\n") + "\n");
  const ps = live.map((r) => predict(model, vec(r)));
  console.log(`${version}: trained on ${pool.length} trials, forecast ${live.length} live trials, mean ${(ps.reduce((s, v) => s + v, 0) / ps.length).toFixed(3)}, range ${Math.min(...ps).toFixed(2)} to ${Math.max(...ps).toFixed(2)}`);
}
