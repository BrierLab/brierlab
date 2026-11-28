// Train and test the learned model.
//   node src/train.mjs eval   walk-forward test on past years, then the held-out
//                             recent trials, then a learning curve
//   node src/train.mjs fit    train on every resolved trial and forecast the live ones
//   node src/train.mjs precedents   for each live trial, the past trials the saved model treats most like it
//   node src/train.mjs predict <raw.jsonl> <out.jsonl>   forecast a new batch of open trials with the saved
//                             model, without retraining it or touching the first record's files
//   node src/train.mjs features   write the live trials' inputs, so the site can rerun the model in the browser
// Training data: data/history_raw.jsonl (src/history.mjs). Every trial is
// described only by what was public before it read out.
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { ruleLabel } from "./features.mjs";
import { fit, importance, predict, rng } from "./gbm.mjs";
import { AFTER_THE_FACT, TrackRecord, designFeatures, keys, readText, staticFeatures, textKeys, time } from "./mlfeatures.mjs";

const mode = process.argv[2];
if (!["eval", "fit", "features", "precedents", "predict"].includes(mode)) {
  console.error("usage: node src/train.mjs eval|fit|features|precedents|predict <raw.jsonl> <out.jsonl>");
  process.exit(1);
}
const DAY = 86_400_000;
// Disease tags on a full registry record, in the same shape src/history.mjs keeps.
const meshOf = (s) => {
  const browse = s.derivedSection?.conditionBrowseModule ?? {};
  return { terms: (browse.meshes ?? []).map((m) => m.term), parents: (browse.ancestors ?? []).map((m) => m.term) };
};
const VERSION = "gbm-v3";
const lines = (path) => readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

// One row per trial: when its result became public, and the last moment a
// forecast of it could honestly have been made (its primary completion date).
function row(p, label, source, mesh) {
  const st = p.statusModule ?? {};
  const posted = time(st.resultsFirstPostDateStruct?.date);
  let known = time(st.primaryCompletionDateStruct?.date) ?? time(st.completionDateStruct?.date);
  if (posted != null && (known == null || known >= posted)) known = posted - (known == null ? 365 * DAY : DAY);
  return {
    nct: p.identificationModule.nctId,
    title: p.identificationModule.briefTitle ?? "",
    source,
    label,
    posted,
    known,
    status: st.overallStatus,
    industry: p.sponsorCollaboratorsModule?.leadSponsor?.class === "INDUSTRY",
    phase3: (p.designModule?.phases ?? []).includes("PHASE3"),
    stat: { ...staticFeatures(p), ...designFeatures(p) },
    keys: keys(p, mesh),
    text: textKeys(p),
  };
}

const history = [];
for await (const line of createInterface({ input: createReadStream("data/history_raw.jsonl") })) {
  const s = JSON.parse(line);
  const label = ruleLabel(s.primaries);
  if (label != null) history.push(row(s.protocolSection, label, "history", s.mesh));
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
  const r = row(s.protocolSection, label ?? rule, "held", meshOf(s));
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
      record.add({ ...filed[i].keys.file, ...filed[i].text }, filed[i].label);
      i++;
    }
    q.x = { ...q.stat, ...record.read(q.keys.read), ...readText(record, q.text) };
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
for (const depth of [3, 4, 5]) for (const minLeaf of [25, 60]) for (const colsample of [1, 0.5]) GRID.push({ depth, minLeaf, colsample });
const STAGES = [200, 400, 600, 800, 1000];
const train = (rows, o) => fit(rows.map(vec), rows.map((r) => r.label), { rate: 0.02, ...o });

mkdirSync("data/model", { recursive: true });

// Precedent memory. Two trials are alike when the model's trees sort them
// the same way: similarity is the share of trees in which both end in the
// same leaf. For each live trial this lists the past trials most like it,
// with what happened to them, so a forecast can cite what it rests on.
const NEAR = 25;
function signatures(model) {
  const ids = model.trees.map(() => new Map());
  return (list) =>
    list.map((r) => {
      const x = vec(r);
      return Uint8Array.from(model.trees, (tree, k) => {
        let node = tree;
        while (node.f !== undefined) node = x[node.f] <= node.t ? node.l : node.r;
        if (!ids[k].has(node)) ids[k].set(node, ids[k].size);
        return ids[k].get(node);
      });
    });
}
function nearest(sig, past, T) {
  const sims = new Float32Array(past.length);
  for (let i = 0; i < past.length; i++) {
    let same = 0;
    for (let k = 0; k < T; k++) same += past[i][k] === sig[k];
    sims[i] = same / T;
  }
  return { sims, order: Array.from(sims.keys()).sort((a, z) => sims[z] - sims[a]).slice(0, NEAR) };
}
// The closest precedents' success rate, pulled a little toward the overall rate.
const fromPrecedents = (labels, base) => (labels.reduce((s, v) => s + v, 0) + 5 * base) / (labels.length + 5);

function precedents(pool, live, chosen) {
  const saved = JSON.parse(readFileSync(`data/model/${VERSION}.json`, "utf8"));
  if (saved.features.join() !== names.join()) throw new Error("the saved model's inputs do not match; refit first");
  const sealed = new Map(lines("data/live_ml_results.jsonl").map((r) => [r.nct, r.probability]));
  for (const r of live) if (Math.abs(predict(saved, vec(r)) - sealed.get(r.nct)) > 1e-9) throw new Error(`${r.nct}: the saved model no longer reproduces its forecast`);
  const T = saved.trees.length;
  const sign = signatures(saved);
  const past = sign(pool);
  const base = pool.reduce((s, r) => s + r.label, 0) / pool.length;
  const trials = {};
  sign(live).forEach((sig, q) => {
    const { sims, order } = nearest(sig, past, T);
    const labels = order.map((i) => pool[i].label);
    trials[live[q].nct] = {
      estimate: fromPrecedents(labels, base),
      met: labels.reduce((s, v) => s + v, 0),
      list: order.slice(0, 8).map((i) => [pool[i].nct, pool[i].title.slice(0, 90), new Date(pool[i].posted).getUTCFullYear(), Math.round(sims[i] * 100), pool[i].label]),
    };
  });

  // How good is a forecast made from precedents alone? Same four walk-forward years as the main test.
  const acc = { n: 0, trees: 0, alone: 0, aloneAuc: 0, blend: 0 };
  for (const [a, z] of [["2022-07-15", "2023-07-15"], ["2023-07-15", "2024-07-15"], ["2024-07-15", "2025-07-15"], ["2025-07-15", "2026-07-15"]]) {
    const tr = pool.filter((r) => r.posted < time(a));
    const te = pool.filter((r) => r.posted >= time(a) && r.posted < time(z));
    const m = train(tr, chosen);
    const s = signatures(m);
    const before = s(tr);
    const rate = tr.reduce((t, r) => t + r.label, 0) / tr.length;
    const pt = te.map((r) => predict(m, vec(r)));
    const pp = s(te).map((sig) => fromPrecedents(nearest(sig, before, m.trees.length).order.map((i) => tr[i].label), rate));
    acc.n += te.length;
    acc.trees += score(te, pt).skill * te.length;
    acc.alone += score(te, pp).skill * te.length;
    acc.aloneAuc += score(te, pp).auc * te.length;
    acc.blend += score(te, pt.map((v, i) => 0.7 * v + 0.3 * pp[i])).skill * te.length;
  }
  const walk = { n: acc.n, trees: acc.trees / acc.n, alone: acc.alone / acc.n, aloneAuc: acc.aloneAuc / acc.n, blend: acc.blend / acc.n };
  writeFileSync("data/model/precedents.json", JSON.stringify({ version: saved.version, near: NEAR, pastTrials: pool.length, walk, trials }));
  console.log(`precedents for ${live.length} live trials from ${pool.length} past trials`);
  console.log(`walk-forward, ${walk.n} trials: trees ${(walk.trees * 100).toFixed(1)}%, precedents alone ${(walk.alone * 100).toFixed(1)}% (AUC ${walk.aloneAuc.toFixed(3)}), blend ${(walk.blend * 100).toFixed(1)}%`);
}

if (mode === "eval") {
  const now = Date.now();
  addTrackRecords([...history, ...held], history, now);
  names = Object.keys(history[0].x).filter((n) => !AFTER_THE_FACT.includes(n));
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
        const key = `${g.depth}/${g.minLeaf}/${g.colsample}/${stage}`;
        const s = score(f.te, f.te.map((r) => predict(m, vec(r), stage)));
        fold.settings[key] = s;
        table.set(key, [...(table.get(key) ?? []), s.brier]);
      }
    }
    walk.push(fold);
  }
  const ranked = [...table].map(([key, v]) => [key, v.reduce((s, x) => s + x, 0) / v.length]).sort((a, b) => a[1] - b[1]);
  const [depth, minLeaf, colsample, trees] = ranked[0][0].split("/").map(Number);
  const chosen = { depth, minLeaf, colsample, trees };
  console.log("walk-forward (settings chosen here, before looking at the held-out trials):");
  for (const f of walk) {
    const s = f.settings[ranked[0][0]];
    console.log(`  from ${f.from}: train ${f.train}, test ${f.test}  boosted skill ${(s.skill * 100).toFixed(1)}% AUC ${s.auc.toFixed(3)}  logistic skill ${(f.logistic * 100).toFixed(1)}%`);
  }
  console.log(`  chosen settings: depth ${depth}, min leaf ${minLeaf}, input share ${colsample}, ${trees} trees`);
  // All four walk-forward years scored together: the largest fair test we have.
  const pooled = walk.reduce((s, f) => s + f.settings[ranked[0][0]].brier * f.test, 0) / walk.reduce((s, f) => s + f.test, 0);
  const tested = walk.reduce((s, f) => s + f.test, 0);
  const meanSkill = walk.reduce((s, f) => s + f.settings[ranked[0][0]].skill * f.test, 0) / tested;
  const meanAuc = walk.reduce((s, f) => s + f.settings[ranked[0][0]].auc * f.test, 0) / tested;
  const meanLogistic = walk.reduce((s, f) => s + f.logistic * f.test, 0) / tested;
  console.log(`  across ${tested} walk-forward trials: skill ${(meanSkill * 100).toFixed(1)}%  AUC ${meanAuc.toFixed(3)}  Brier ${pooled.toFixed(4)}  (logistic skill ${(meanLogistic * 100).toFixed(1)}%)\n`);

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
    JSON.stringify({ ranAt: new Date().toISOString(), version: VERSION, trainedOn: pool.length, features: names.length, chosen, walkAll: { n: tested, skill: meanSkill, auc: meanAuc, brier: pooled, logistic: meanLogistic }, walk: walk.map((f) => ({ from: f.from, train: f.train, test: f.test, logistic: f.logistic, boosted: f.settings[ranked[0][0]] })), heldOut, curve, importance: imp }, null, 1),
  );
  console.log("\nwrote data/model/eval.json");
}

if (mode === "predict") {
  const [rawPath, outPath] = process.argv.slice(3);
  if (!rawPath || !outPath) throw new Error("usage: node src/train.mjs predict <raw.jsonl> <out.jsonl>");
  const saved = JSON.parse(readFileSync(`data/model/${VERSION}.json`, "utf8"));
  const now = Date.now();
  const fresh = lines(rawPath).map((s) => ({ ...row(s.protocolSection, null, "live", meshOf(s)), known: now }));
  const resolved = [...history, ...held.map((r) => ({ ...r }))];
  addTrackRecords([...resolved, ...fresh], resolved, now);
  names = saved.features;
  const missing = names.filter((n) => !(n in fresh[0].x));
  if (missing.length) throw new Error(`the saved model expects inputs this code no longer makes: ${missing.join(", ")}`);
  const madeAt = new Date().toISOString();
  const ps = fresh.map((r) => predict(saved, vec(r)));
  writeFileSync(outPath, fresh.map((r, i) => JSON.stringify({ nct: r.nct, probability: ps[i], model: saved.version, madeAt })).join("\n") + "\n");
  console.log(`${saved.version}: forecast ${fresh.length} trials, mean ${(ps.reduce((s, v) => s + v, 0) / ps.length).toFixed(3)}, range ${Math.min(...ps).toFixed(2)} to ${Math.max(...ps).toFixed(2)}`);
  process.exit(0);
}

if (mode === "fit" || mode === "features" || mode === "precedents") {
  const evalPath = "data/model/eval.json";
  if (!existsSync(evalPath)) throw new Error("run `node src/train.mjs eval` first: it chooses the settings");
  const { chosen } = JSON.parse(readFileSync(evalPath, "utf8"));
  const now = Date.now();
  const live = lines("data/live_raw.jsonl").map((s) => ({ ...row(s.protocolSection, null, "live", meshOf(s)), known: now }));
  const resolved = [...history, ...held.map((r) => ({ ...r }))];
  addTrackRecords([...resolved, ...live], resolved, now);
  names = Object.keys(resolved[0].x).filter((n) => !AFTER_THE_FACT.includes(n));
  const pool = resolved.filter(usable);
  writeFileSync("data/model/live_features.json", JSON.stringify({ names, vectors: Object.fromEntries(live.map((r) => [r.nct, vec(r)])) }));
  if (mode === "features") {
    console.log(`wrote inputs for ${live.length} live trials to data/model/live_features.json`);
    process.exit(0);
  }
  if (mode === "precedents") {
    precedents(pool, live, chosen);
    process.exit(0);
  }
  const model = train(pool, chosen);
  const version = `${VERSION}(n=${pool.length})`;
  const madeAt = new Date().toISOString();
  writeFileSync(`data/model/${VERSION}.json`, JSON.stringify({ version, madeAt, trainedOn: pool.length, features: names, ...model }));
  writeFileSync("data/live_ml_results.jsonl", live.map((r) => JSON.stringify({ nct: r.nct, probability: predict(model, vec(r)), model: version, madeAt })).join("\n") + "\n");
  const ps = live.map((r) => predict(model, vec(r)));
  console.log(`${version}: trained on ${pool.length} trials, forecast ${live.length} live trials, mean ${(ps.reduce((s, v) => s + v, 0) / ps.length).toFixed(3)}, range ${Math.min(...ps).toFixed(2)} to ${Math.max(...ps).toFixed(2)}`);
}
