// Build the data the site shows from the live record, so the page never
// carries a number that is not in the sealed file.
// Usage: node src/site.mjs <seal-name>      (run from the repo root)
// Writes site/data.js and copies the sealed file to site/sealed/.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resultIsPublic } from "./briefs.mjs";
import { FORECASTERS, readRequested, scoreLive } from "./outcomes.mjs";

const [sealName] = process.argv.slice(2);
if (!sealName) {
  console.error("usage: node src/site.mjs <seal-name>");
  process.exit(1);
}

const rows = (path) =>
  existsSync(path)
    ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
const byNct = (list) => new Map(list.filter((r) => !r.error).map((r) => [r.nct, r]));

const seal = JSON.parse(readFileSync(`data/sealed/${sealName}.json`, "utf8"));
const sealed = new Set(seal.forecasts.map((f) => `${f.nct} ${f.method}`));
const leafOf = new Map(seal.forecasts.map((f) => [`${f.nct} ${f.method}`, f.leaf]));
const base = byNct(rows("data/live_results.jsonl"));
const researched = byNct(rows("data/live_researched_results.jsonl"));
const briefs = byNct(rows("data/research_results.jsonl"));

// The learned model (src/train.mjs): its latest sealed forecasts and its test results.
const mlSealName = readdirSync("data/sealed").filter((f) => f.endsWith("-ml.json")).sort().at(-1)?.replace(/\.json$/, "");
const mlSeal = mlSealName ? JSON.parse(readFileSync(`data/sealed/${mlSealName}.json`, "utf8")) : null;
const learned = new Map((mlSeal?.forecasts ?? []).map((f) => [f.nct, f.probability]));
const evalPath = "data/model/eval.json";
const top = existsSync("data/model/top.json") ? JSON.parse(readFileSync("data/model/top.json", "utf8")) : null;
const precedents = existsSync("data/model/precedents.json") ? JSON.parse(readFileSync("data/model/precedents.json", "utf8")) : null;
const test = existsSync(evalPath) ? JSON.parse(readFileSync(evalPath, "utf8")) : null;

const phaseName = (p) => "Phase " + p.replaceAll("PHASE", "");

const trials = [];
for (const c of rows("data/live_cases.jsonl")) {
  const b = sealed.has(`${c.nct} live`) ? base.get(c.nct) : null;
  const r = sealed.has(`${c.nct} live_researched`) ? researched.get(c.nct) : null;
  if (!b && !r) continue;
  const brief = briefs.get(c.nct);
  // A trial whose own result was already out when we looked is shown but
  // never counted. Everything else is either screened (a web search found
  // no result) or unscreened (nobody has looked yet).
  const alreadyPublic = (brief && resultIsPublic(brief.brief)) || b?.recalls_result || r?.recalls_result;
  trials.push({
    nct: c.nct,
    title: c.title,
    sponsor: c.sponsor,
    phase: phaseName(c.phase),
    due: c.primaryCompletion,
    enrollment: c.enrollment,
    base: b?.probability ?? null,
    researched: r?.probability ?? null,
    // The learned model's own sealed forecast, shown beside the headline one.
    learned: learned.get(c.nct) ?? null,
    rationale: (r ?? b).rationale,
    sources: r ? (brief?.sources ?? []).length : 0,
    state: alreadyPublic ? "public" : r ? "screened" : "unscreened",
    // The sealed hash of the forecast the site shows for this trial.
    leaf: leafOf.get(`${c.nct} ${r ? "live_researched" : "live"}`) ?? null,
  });
}
// Evidence reports made on request since sealing (src/pull.mjs copies them
// from the live site). One that produced a forecast becomes the trial's
// published forecast. One that found the result already out changes nothing
// here: the sealed forecast stands until the result is read into the ledger.
const requested = readRequested();
for (const r of requested) {
  const t = trials.find((x) => x.nct === r.nct);
  if (!t) continue;
  t.report = { status: r.status, probability: r.probability ?? null, madeAt: r.madeAt, leaf: r.leaf ?? null, sources: r.sources.length, paid: !!r.paid, stamped: existsSync(`data/on_demand/${r.nct}.txt.ots`) };
  if (r.status === "forecast" && t.state === "unscreened") Object.assign(t, { researched: r.probability, sources: r.sources.length, state: "screened", leaf: r.leaf });
}
trials.sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : a.nct < b.nct ? -1 : 1));

// The live score: outcomes from the ledger (data/outcomes.jsonl), scored
// under the rules in src/outcomes.mjs. watch.json is the last registry check.
const live = scoreLive(new Set(trials.filter((t) => t.state === "public").map((t) => t.nct)));
const watch = existsSync("data/watch.json") ? JSON.parse(readFileSync("data/watch.json", "utf8")) : null;
const outcomeOf = new Map(live.resolved.map((r) => [r.nct, r]));
for (const t of trials) {
  const o = outcomeOf.get(t.nct);
  if (o) t.outcome = { result: o.outcome, reportedOn: o.reportedOn, source: o.source, quote: o.quote, counted: o.counted, why: o.why ?? null };
}
const uncounted = live.resolved.filter((r) => !r.counted);

// The lab notebook: what was tried and found, in order, negative results
// included. Counts come from the data so the page cannot drift from it.
const screened = trials.filter((t) => t.state === "screened");
const briefList = [...briefs.values()];
const foundPublic = briefList.filter((b) => resultIsPublic(b.brief)).length;
const avgShift = screened.reduce((s, t) => s + Math.abs(t.researched - t.base), 0) / (screened.length || 1);
const baselineSealPath = "data/sealed/live-2026-11-23-baseline.json";
const baselineSeal = existsSync(baselineSealPath) ? JSON.parse(readFileSync(baselineSealPath, "utf8")) : null;
// The outside timestamp. A proof starts out "pending" (held by calendar
// servers) and becomes "confirmed" once it is anchored in a Bitcoin block.
const otsPath = `data/sealed/${sealName}.root.ots`;
const BITCOIN_TAG = Buffer.from("0588960d73d71901", "hex");
// The submission day is written down once, because upgrading the proof later
// rewrites the file and would otherwise move the date.
function submittedOn() {
  const note = `${otsPath}.date`;
  if (!existsSync(note)) writeFileSync(note, statSync(otsPath).mtime.toISOString().slice(0, 10) + "\n");
  return readFileSync(note, "utf8").trim();
}
// The same for any other sealed set. A proof only shows the set existed on the
// day it was submitted, which can be later than the day it was sealed.
function stampNote(name) {
  const path = `data/sealed/${name}.root.ots`;
  if (!existsSync(path)) return "It has no outside timestamp yet.";
  const note = `${path}.date`;
  if (!existsSync(note)) writeFileSync(note, statSync(path).mtime.toISOString().slice(0, 10) + "\n");
  const on = new Date(readFileSync(note, "utf8").trim() + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  mkdirSync("site/sealed", { recursive: true });
  for (const ext of [".json", ".root", ".root.ots"]) copyFileSync(`data/sealed/${name}${ext}`, `site/sealed/${name}${ext}`);
  return readFileSync(path).includes(BITCOIN_TAG)
    ? `Its fingerprint was submitted to OpenTimestamps on ${on} and is now in the Bitcoin blockchain.`
    : `Its fingerprint was submitted to OpenTimestamps on ${on} and is waiting to be written into a Bitcoin block.`;
}
const stamp = existsSync(otsPath)
  ? {
      state: readFileSync(otsPath).includes(BITCOIN_TAG) ? "confirmed" : "pending",
      date: submittedOn(),
    }
  : { state: "none", date: null };
const pc = (x) => Math.round(x * 100);
const log = [
  {
    date: "2026-11-22",
    kind: "finding",
    text: "Tests on past trials cannot prove a forecaster. On 207 trials that had already reported, the model said it remembered the real result for 131. Scores from the past are set aside; only forecasts sealed before a result count.",
  },
  {
    date: seal.sealedAt.slice(0, 10),
    kind: "sealed",
    text: `${seal.count} forecasts sealed across ${trials.length} trials that have not reported. Fingerprint ${seal.root.slice(0, 12)}…`,
  },
  {
    date: "2026-11-22",
    kind: "finding",
    text: `${foundPublic} of the first ${briefList.length} trials we researched had already announced results, and the model flagged ${trials.filter((t) => t.state === "public").length - foundPublic} more by itself. All are excluded. Trials not yet researched are marked "not yet screened" and do not count until they are.`,
  },
  {
    date: "2026-11-22",
    kind: "finding",
    text: `Gathering evidence moved a forecast by ${Math.round(avgShift * 100)} points on average. Whether those moves make forecasts better is unknown until the trials report.`,
  },
  {
    date: "2026-11-23",
    kind: "negative",
    text: "We tried blending the model's forecast with a plain statistical model. On past trials it did not improve the forecast, so the published number stays the model's own.",
  },
  ...(baselineSeal
    ? [
        {
          date: baselineSeal.sealedAt.slice(0, 10),
          kind: "sealed",
          text: `The statistical model's own forecasts for all ${baselineSeal.count} trials are sealed too, so the comparison is fair when results arrive. Fingerprint ${baselineSeal.root.slice(0, 12)}… ${stampNote("live-2026-11-23-baseline")}`,
        },
      ]
    : []),
  ...(stamp.state === "none"
    ? []
    : [
        {
          date: stamp.date,
          kind: "sealed",
          text:
            stamp.state === "confirmed"
              ? "The fingerprint of the first record is timestamped in the Bitcoin blockchain through OpenTimestamps. The proof file is in the Verify section."
              : "The fingerprint of the first record was submitted to OpenTimestamps, an outside timestamping service. It is waiting to be written into a Bitcoin block.",
        },
      ]),
  ...(test && mlSeal
    ? [
        {
          date: mlSeal.sealedAt.slice(0, 10),
          kind: "finding",
          text: `We built a second forecaster that learns from results: boosted decision trees trained on ${test.trainedOn.toLocaleString("en-US")} past trials from the public registry. On ${test.heldOut.all.boosted.n} recent trials it never saw, it removed ${pc(test.heldOut.all.boosted.skill)}% of the error of always guessing the average, against ${pc(test.heldOut.all.oldBaseline.skill)}% for our earlier statistical model. It does not use the fields the registry rewrites after a trial ends, such as the final headcount. Other text in a record can still be edited, so expect less on live trials.`,
        },
        {
          date: mlSeal.sealedAt.slice(0, 10),
          kind: "finding",
          text: `More data helps it. Trained on ${test.curve[0].size} past trials, the same model scored about ${pc(test.curve[0].skill)}% on the same kind of test; on ${test.curve.at(-1).size.toLocaleString("en-US")}, about ${pc(test.curve.at(-1).skill)}%. Retraining on newly posted results is a manual step today, and each retrain is sealed as a new version.`,
        },
        {
          date: mlSeal.sealedAt.slice(0, 10),
          kind: "sealed",
          text: `The learned model's forecasts for all ${mlSeal.count} open trials are sealed, so it is scored on the same trials as the published forecast. Fingerprint ${mlSeal.root.slice(0, 12)}… ${stampNote(mlSealName)}`,
        },
        ...(precedents
          ? [
              {
                date: "2026-11-27",
                kind: "finding",
                text: `The learned model now cites its precedents. For each open trial it lists the past trials its decision trees sort the same way, with what happened to them. A forecast made from the ${precedents.near} closest precedents alone removed ${pc(precedents.walk.alone)}% of the error on four years of past trials, against ${pc(precedents.walk.trees)}% for the full model. Blending the two did not help, so precedents explain a forecast and do not change it.`,
              },
            ]
          : []),
        ...(top
          ? [
              {
                date: top.ranAt.slice(0, 10),
                kind: "finding",
                text: `We scored the learned model's method on TOP, the public test set that published trial-outcome models report on. ROC-AUC, where 0.5 is a coin flip and 1 is perfect: ${["I", "II", "III"].map((ph) => `Phase ${ph} ${top.strict.phases[ph].roc.toFixed(3)}`).join(", ")}. That is level with the best published results we found (0.653, 0.701, 0.772) and ahead of the earlier published models, but the test cannot separate us from the top one, so we do not claim first place. The full table is in MODEL.md in the public repo.`,
              },
            ]
          : []),
      ]
    : []),
  ...(watch
    ? [
        {
          date: watch.checkedAt.slice(0, 10),
          kind: "finding",
          text: `We built the step that checks results and scores forecasts. It asks the registry about all ${watch.trials} sealed trials: ${watch.resultsPosted.length} have results posted there, ${watch.stopped.length} have been stopped, and ${watch.pastFinish.length + live.resolved.length} are past their finish date. Every outcome goes into a public ledger with its source and the words that decide it. Forecasts scored so far: ${live.scored}.`,
        },
      ]
    : []),
  ...(uncounted.some((r) => r.why === "reported before the forecast was sealed")
    ? [
        {
          date: watch?.checkedAt.slice(0, 10) ?? "2026-11-27",
          kind: "negative",
          text: `Our screening missed ${uncounted.filter((r) => r.why === "reported before the forecast was sealed").length} trials whose sponsors had already announced the result before we sealed. Nobody had searched for them, so they sat in the record as open. They are now marked with the announcement and are not scored, whichever way our forecast leaned. We then checked the registry record of every sealed trial: these were the only ones that had finished before we sealed. A sponsor can still announce early findings from a trial that is running, so each result's date is checked against the seal before it counts.`,
        },
      ]
    : []),
  {
    date: "2026-11-28",
    kind: "finding",
    text:
      "Anyone can now ask for an evidence report on a trial that has only a record-based forecast. We search for earlier results, forecast again with what we find, and send that forecast's fingerprint to OpenTimestamps the moment it is made. A few are free each day." +
      (requested.length ? ` ${requested.length} ${requested.length === 1 ? "has" : "have"} been made so far; the first three were requested by us while testing.` : ""),
  },
  {
    date: "Open",
    kind: "open",
    text:
      (stamp.state === "none" ? "Not done yet: an outside timestamp on the fingerprints. " : "") +
      "The registry is now checked automatically, at most every six hours, and the record page shows what it finds. Still by hand: sponsor announcements are found and read by a person or an assistant, then recorded with a link." +
      (live.scored ? "" : " No trial has been scored yet."),
  },
];

const data = {
  seal: {
    name: sealName,
    root: seal.root,
    count: seal.count,
    sealedAt: seal.sealedAt,
    // True only once an outside service has timestamped the root.
    timestamped: stamp.state !== "none",
    stamp,
  },
  // Forecasts scored against a real result, under the rules in src/outcomes.mjs.
  scored: live.scored,
  results: {
    checkedAt: watch?.checkedAt ?? null,
    pastFinish: watch ? watch.pastFinish.length + live.resolved.length : null,
    reported: live.resolved.length,
    notCounted: uncounted.length,
    met: live.met,
    table: Object.entries(live.table).map(([who, t]) => ({ name: FORECASTERS[who], ...t })),
  },
  // The learned model: how many past trials it was trained on and where its sealed forecasts are.
  learned: test && mlSeal ? { trainedOn: Number(/n=(\d+)/.exec(mlSeal.forecasts[0].model)?.[1] ?? test.trainedOn), seal: mlSealName, root: mlSeal.root, count: mlSeal.count } : null,
  log,
  trials,
};

mkdirSync("site/sealed", { recursive: true });
// What the live registry check (src/worker.mjs, /api/watch) compares against:
// each sealed trial's status when it was sealed, and whether we have read its outcome.
{
  const atSeal = new Map(rows("data/live_raw.jsonl").map((s) => [s.protocolSection.identificationModule.nctId, s.protocolSection.statusModule?.overallStatus ?? null]));
  writeFileSync("site/watchlist.json", JSON.stringify(trials.map((t) => ({ nct: t.nct, status: atSeal.get(t.nct) ?? null, state: t.state, inLedger: !!t.outcome }))));
}
copyFileSync(`data/sealed/${sealName}.json`, `site/sealed/${sealName}.json`);
if (mlSealName) copyFileSync(`data/sealed/${mlSealName}.json`, `site/sealed/${mlSealName}.json`);
if (stamp.state !== "none") {
  copyFileSync(`data/sealed/${sealName}.root`, `site/sealed/${sealName}.root`);
  copyFileSync(otsPath, `site/sealed/${sealName}.root.ots`);
}
// Everything the How it works page needs to rerun the learned model in the
// browser: the trees, each open trial's inputs, the sealed answers to check
// against, and the test results.
const modelPath = "data/model/" + (readdirSync("data/model").filter((f) => /^gbm-v\d+\.json$/.test(f)).sort().at(-1) ?? "none");
const inputsPath = "data/model/live_features.json";
if (test && mlSeal && existsSync(modelPath) && existsSync(inputsPath)) {
  const m = JSON.parse(readFileSync(modelPath, "utf8"));
  const inputs = JSON.parse(readFileSync(inputsPath, "utf8"));
  const strip = (n) => (n.f === undefined ? { v: n.v } : { f: n.f, t: n.t, l: strip(n.l), r: strip(n.r) });
  const all = test.heldOut.all;
  const pick = (r) => ({ skill: r.skill, auc: r.auc });
  const model = {
    version: m.version,
    trainedOn: m.trainedOn,
    names: m.features,
    base: m.base,
    trees: m.trees.map(strip),
    vectors: inputs.vectors,
    sealed: Object.fromEntries(mlSeal.forecasts.map((f) => [f.nct, f.probability])),
    root: mlSeal.root,
    test: {
      trainedOn: test.trainedOn,
      n: all.boosted.n,
      boosted: pick(all.boosted),
      logistic: pick(all.logistic),
      oldBaseline: pick(all.oldBaseline),
      walk: test.walkAll ?? null,
      curve: test.curve,
      importance: test.importance,
    },
  };
  // Precedents are only shown when they were computed for this exact model.
  if (precedents?.version === m.version) model.precedents = { near: precedents.near, pastTrials: precedents.pastTrials, walk: precedents.walk, trials: precedents.trials };
  writeFileSync("site/model.js", `window.MODEL = ${JSON.stringify(model)};\n`);
}
writeFileSync("site/data.js", `window.READOUT = ${JSON.stringify(data)};\n`);
const count = (s) => trials.filter((t) => t.state === s).length;
console.log(
  `site data: ${trials.length} trials (${count("screened")} screened, ${count("unscreened")} unscreened, ${count("public")} already public), seal ${seal.root.slice(0, 12)}`,
);
