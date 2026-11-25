// Score the learned model's method on the public TOP benchmark (Fu et al.,
// "HINT", 2022), the test set that published trial-outcome models report on.
//   node src/top.mjs fetch   pull the registry record for every benchmark trial
//   node src/top.mjs eval    train on the benchmark's training trials, test on its test trials
// The benchmark tables are not ours and are not kept in this repo. Download
// phase_{I,II,III}_{train,valid,test}.csv from
// github.com/futianfan/clinical-trial-outcome-prediction (data/) into data/top/.
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fit, importance, predict } from "./gbm.mjs";
import { TrackRecord, keys, staticFeatures, time, words } from "./mlfeatures.mjs";

const mode = process.argv[2];
const PHASES = ["I", "II", "III"];
const SPLITS = ["train", "valid", "test"];
const RAW = "data/top_raw.jsonl";

// Minimal CSV reader: quoted fields may hold commas, quotes and line breaks.
function csv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") row.push(cell), (cell = "");
    else if (c === "\n") row.push(cell), rows.push(row), (row = []), (cell = "");
    else if (c !== "\r") cell += c;
  }
  if (cell || row.length) row.push(cell), rows.push(row);
  const head = rows.shift();
  return rows.filter((r) => r.length === head.length).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

// nct -> { label, in: Set("II/test", ...) }
function benchmark() {
  const trials = new Map();
  for (const ph of PHASES)
    for (const sp of SPLITS)
      for (const r of csv(readFileSync(`data/top/phase_${ph}_${sp}.csv`, "utf8"))) {
        const t = trials.get(r.nctid) ?? { nct: r.nctid, label: Number(r.label), in: new Set() };
        t.in.add(`${ph}/${sp}`);
        trials.set(r.nctid, t);
      }
  return trials;
}

if (mode === "fetch") {
  const ids = [...benchmark().keys()];
  const out = createWriteStream(RAW);
  let n = 0;
  for (let i = 0; i < ids.length; i += 100) {
    const url = new URL("https://clinicaltrials.gov/api/v2/studies");
    url.searchParams.set("filter.ids", ids.slice(i, i + 100).join(","));
    url.searchParams.set("fields", "protocolSection,derivedSection.conditionBrowseModule");
    url.searchParams.set("pageSize", "100");
    let res;
    for (let attempt = 0; ; attempt++) {
      res = await fetch(url).catch(() => null);
      if (res?.ok) break;
      if (attempt >= 6) throw new Error(`ClinicalTrials.gov ${res?.status ?? "network error"} after retries`);
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
    }
    for (const s of (await res.json()).studies ?? []) {
      const p = { ...s.protocolSection };
      const locations = p.contactsLocationsModule?.locations ?? [];
      p.contactsLocationsModule = { siteCount: locations.length, countries: [...new Set(locations.map((l) => l.country).filter(Boolean))] };
      delete p.referencesModule;
      const browse = s.derivedSection?.conditionBrowseModule ?? {};
      out.write(JSON.stringify({ protocolSection: p, mesh: { terms: (browse.meshes ?? []).map((m) => m.term), parents: (browse.ancestors ?? []).map((m) => m.term) } }) + "\n");
      n++;
    }
    process.stderr.write(`\r${n}/${ids.length}`);
  }
  await new Promise((r) => out.end(r));
  console.error(`\nwrote ${n} records to ${RAW}`);
  process.exit(0);
}
if (mode !== "eval") {
  console.error("usage: node src/top.mjs fetch|eval");
  process.exit(1);
}

// Inputs that the registry rewrites once a trial ends (final headcount, final
// site list). A stopped trial shows a small headcount, which gives the ending
// away, so the headline run leaves all of these out.
const AFTER_THE_FACT = ["logEnrollment", "logEnrollPerSite", "logSites", "countryCount", "usOnly", "hasUs"];
const YEAR = 365 * 86_400_000;

// Word-level track records, used only by the "wide" run: how earlier trials
// whose title, drug names or entry criteria shared a word turned out.
const uniq = (list) => [...new Set(list)];
function textKeys(p) {
  const interventions = p.armsInterventionsModule?.interventions ?? [];
  return {
    titleWord: uniq(words([p.identificationModule?.briefTitle, p.identificationModule?.officialTitle].join(" "))),
    drugWord: uniq(interventions.flatMap((i) => words(i.name))),
    criteriaWord: uniq(words(p.eligibilityModule?.eligibilityCriteria)).slice(0, 400),
    interventionType: uniq(interventions.map((i) => i.type).filter(Boolean)),
    collaborator: uniq((p.sponsorCollaboratorsModule?.collaborators ?? []).map((c) => c.name?.toLowerCase()).filter(Boolean)),
  };
}
function readText(record, text) {
  const prior = record.n ? record.met / record.n : 0.5;
  const out = {};
  for (const [name, list] of Object.entries(text)) {
    const table = record.tables.get(name);
    const lifts = [];
    for (const key of list) {
      const row = table?.get(key);
      if (row && row[0] >= 8) lifts.push((row[1] + 8 * prior) / (row[0] + 8) - prior);
    }
    lifts.sort((a, b) => a - b);
    out[`${name}_mean`] = lifts.length ? lifts.reduce((s, v) => s + v, 0) / lifts.length : 0;
    out[`${name}_low`] = lifts.length ? lifts[Math.floor(lifts.length * 0.1)] : 0;
    out[`${name}_high`] = lifts.length ? lifts[Math.floor(lifts.length * 0.9)] : 0;
    out[`${name}_seen`] = Math.log10(lifts.length + 1);
  }
  return out;
}

const trials = benchmark();
const rows = [];
for (const line of readFileSync(RAW, "utf8").split("\n").filter(Boolean)) {
  const s = JSON.parse(line);
  const p = s.protocolSection;
  const t = trials.get(p.identificationModule.nctId);
  if (!t) continue;
  const st = p.statusModule ?? {};
  const phases = p.designModule?.phases ?? [];
  const done = time(st.primaryCompletionDateStruct?.date) ?? time(st.completionDateStruct?.date);
  const start = time(st.startDateStruct?.date) ?? (done != null ? done - 2 * YEAR : null);
  const stat = staticFeatures(p);
  stat.phase1 = phases.includes("PHASE1") ? 1 : 0;
  stat.phase2 = phases.includes("PHASE2") ? 1 : 0;
  rows.push({ ...t, start: start ?? 0, done: done ?? (start ?? 0) + 3 * YEAR, stat, keys: keys(p, s.mesh), text: textKeys(p) });
}
const inSplit = (r, sp, ph) => (ph ? r.in.has(`${ph}/${sp}`) : PHASES.some((x) => r.in.has(`${x}/${sp}`)));
const isTest = (r) => inSplit(r, "test");
const isValid = (r) => !isTest(r) && inSplit(r, "valid");
const isTrain = (r) => !isTest(r) && !isValid(r);
console.log(`benchmark trials: ${trials.size}, with a registry record: ${rows.length}`);

// Track records: a trial reads, on the day it started, how earlier trials
// with the same sponsor, drug or disease turned out. Only training-side
// labels are ever filed; the labels of test trials are never used.
function addTrackRecords(file, wide) {
  const filed = rows.filter(file).sort((a, b) => a.done - b.done);
  const asked = [...rows].sort((a, b) => a.start - b.start);
  const record = new TrackRecord();
  let i = 0;
  for (const q of asked) {
    while (i < filed.length && filed[i].done < q.start) record.add({ ...filed[i].keys.file, ...(wide ? filed[i].text : {}) }, filed[i].label), i++;
    q.x = { ...q.stat, ...record.read(q.keys.read), ...(wide ? readText(record, q.text) : {}) };
  }
}

function rocAuc(y, p) {
  const idx = y.map((_, i) => i).sort((a, b) => p[a] - p[b]);
  let rank = 0, pos = 0;
  for (let k = 0; k < idx.length; ) {
    let j = k;
    while (j < idx.length && p[idx[j]] === p[idx[k]]) j++;
    for (let m = k; m < j; m++) if (y[idx[m]] === 1) (rank += (k + j + 1) / 2), pos++;
    k = j;
  }
  return (rank - (pos * (pos + 1)) / 2) / (pos * (y.length - pos));
}
// Area under the precision-recall curve, as average precision.
function prAuc(y, p) {
  const idx = y.map((_, i) => i).sort((a, b) => p[b] - p[a]);
  const total = y.reduce((s, v) => s + v, 0);
  let tp = 0, seen = 0, area = 0;
  for (let k = 0; k < idx.length; ) {
    let j = k, hit = 0;
    while (j < idx.length && p[idx[j]] === p[idx[k]]) hit += y[idx[j]], j++;
    tp += hit;
    seen = j;
    area += (hit / total) * (tp / seen);
    k = j;
  }
  return area;
}
function f1(y, p, cut = 0.5) {
  let tp = 0, fp = 0, fn = 0;
  y.forEach((v, i) => (p[i] >= cut ? (v ? tp++ : fp++) : v && fn++));
  return tp ? (2 * tp) / (2 * tp + fp + fn) : 0;
}
function metrics(y, p) {
  const rate = y.reduce((s, v) => s + v, 0) / y.length;
  const brier = y.reduce((s, v, i) => s + (p[i] - v) ** 2, 0) / y.length;
  return { n: y.length, rate, roc: rocAuc(y, p), pr: prAuc(y, p), f1: f1(y, p), f1AllYes: (2 * rate) / (1 + rate), skill: 1 - brier / (rate * (1 - rate)) };
}
// Spread from resampling the test trials 1,000 times.
function interval(y, p, fn) {
  let a = 12345;
  const rand = () => ((a = (Math.imul(a, 1664525) + 1013904223) >>> 0) / 4294967296);
  const v = [];
  for (let b = 0; b < 1000; b++) {
    const yy = [], pp = [];
    for (let i = 0; i < y.length; i++) {
      const k = Math.floor(rand() * y.length);
      yy.push(y[k]), pp.push(p[k]);
    }
    v.push(fn(yy, pp));
  }
  v.sort((x, z) => x - z);
  return [v[25], v[975]];
}

const GRID = [];
for (const depth of [3, 4, 5]) for (const minLeaf of [25, 60]) for (const colsample of [1, 0.5]) GRID.push({ depth, minLeaf, colsample });
const STAGES = [200, 400, 600, 800, 1000];

const SEEDS = [7, 17, 27, 37, 47];
function run(label, drop, wide) {
  // Choose settings: train-only track records, fit on train, score on the benchmark's validation trials.
  addTrackRecords(isTrain, wide);
  const names = Object.keys(rows[0].x).filter((n) => !drop.includes(n));
  const vec = (r) => names.map((n) => r.x[n]);
  const tr = rows.filter(isTrain), va = rows.filter(isValid);
  const yv = va.map((r) => r.label);
  let best = null;
  for (const g of GRID) {
    const m = fit(tr.map(vec), tr.map((r) => r.label), { rate: 0.02, ...g, trees: STAGES.at(-1) });
    for (const stage of STAGES) {
      const p = va.map((r) => predict(m, vec(r), stage));
      const loss = -va.reduce((s, r, i) => s + Math.log(r.label ? p[i] : 1 - p[i]), 0) / va.length;
      if (!best || loss < best.loss) best = { ...g, trees: stage, loss, roc: rocAuc(yv, p), p };
    }
  }
  const { loss, roc, p: pv, ...chosen } = best;
  // The yes/no cutoff that gives the best F1 on the validation trials.
  let cut = 0.5, top = 0;
  for (let c = 0.2; c <= 0.7; c += 0.01) if (f1(yv, pv, c) > top) (top = f1(yv, pv, c)), (cut = Math.round(c * 100) / 100);
  console.log(`\n${label}: ${names.length} inputs; settings chosen on ${va.length} validation trials: depth ${chosen.depth}, min leaf ${chosen.minLeaf}, input share ${chosen.colsample}, ${chosen.trees} trees (validation ROC ${roc.toFixed(3)}, log loss ${loss.toFixed(4)}, cutoff ${cut})`);
  if (process.env.VALID_ONLY) return null;

  // Final: track records from train + validation, fit on both (five seeds averaged), score the test trials once.
  addTrackRecords((r) => !isTest(r), wide);
  const pool = rows.filter((r) => !isTest(r));
  const models = SEEDS.map((seed) => fit(pool.map(vec), pool.map((r) => r.label), { rate: 0.02, ...chosen, seed }));
  const forecast = (r) => models.reduce((s, m) => s + predict(m, vec(r)), 0) / models.length;
  const out = { inputs: names.length, chosen, cut, trainedOn: pool.length, phases: {} };
  for (const ph of PHASES) {
    const te = rows.filter((r) => r.in.has(`${ph}/test`));
    const y = te.map((r) => r.label), p = te.map(forecast);
    const m = metrics(y, p);
    m.f1Cut = f1(y, p, cut);
    m.rocRange = interval(y, p, rocAuc);
    m.prRange = interval(y, p, prAuc);
    out.phases[ph] = m;
    console.log(`  Phase ${ph.padEnd(3)} n=${m.n} success ${(m.rate * 100).toFixed(0)}%  ROC-AUC ${m.roc.toFixed(3)} [${m.rocRange.map((v) => v.toFixed(3)).join(", ")}]  PR-AUC ${m.pr.toFixed(3)} [${m.prRange.map((v) => v.toFixed(3)).join(", ")}]  F1 ${m.f1.toFixed(3)} at 0.5, ${m.f1Cut.toFixed(3)} at ${cut} (all-yes ${m.f1AllYes.toFixed(3)})  skill ${(m.skill * 100).toFixed(1)}%`);
  }
  out.importance = importance(models[0], names).slice(0, 12);
  console.log("  leans on: " + out.importance.slice(0, 8).map((f) => `${f.name} ${(f.share * 100).toFixed(0)}%`).join(", "));
  return out;
}

const strict = run("strict (nothing the registry rewrites after a trial ends)", AFTER_THE_FACT, false);
const wide = run("strict + word-level track records", AFTER_THE_FACT, true);
if (process.env.VALID_ONLY) process.exit(0);
const full = run("all inputs (includes final headcount and site list)", [], false);
mkdirSync("data/model", { recursive: true });
writeFileSync("data/model/top.json", JSON.stringify({ ranAt: new Date().toISOString(), trials: rows.length, strict, wide, full }, null, 1));
console.log("\nwrote data/model/top.json");
