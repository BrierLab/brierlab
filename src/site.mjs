// Build the data the site shows from the live record, so the page never
// carries a number that is not in the sealed file.
// Usage: node src/site.mjs <seal-name>      (run from the repo root)
// Writes site/data.js and copies the sealed file to site/sealed/.
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resultIsPublic } from "./briefs.mjs";

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
    rationale: (r ?? b).rationale,
    sources: r ? (brief?.sources ?? []).length : 0,
    state: alreadyPublic ? "public" : r ? "screened" : "unscreened",
    // The sealed hash of the forecast the site shows for this trial.
    leaf: leafOf.get(`${c.nct} ${r ? "live_researched" : "live"}`) ?? null,
  });
}
trials.sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : a.nct < b.nct ? -1 : 1));

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
const stamp = existsSync(otsPath)
  ? {
      state: readFileSync(otsPath).includes(BITCOIN_TAG) ? "confirmed" : "pending",
      date: submittedOn(),
    }
  : { state: "none", date: null };
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
          text: `The statistical model's own forecasts for all ${baselineSeal.count} trials are sealed too, so the comparison is fair when results arrive. Fingerprint ${baselineSeal.root.slice(0, 12)}…`,
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
  {
    date: "Open",
    kind: "open",
    text:
      (stamp.state === "none" ? "Not done yet: an outside timestamp on the fingerprints, and the step" : "Not done yet: the step") +
      " that checks each trial's real result and scores it.",
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
  // No outcome-resolution step exists yet, so nothing has been scored.
  scored: 0,
  log,
  trials,
};

mkdirSync("site/sealed", { recursive: true });
copyFileSync(`data/sealed/${sealName}.json`, `site/sealed/${sealName}.json`);
if (stamp.state !== "none") {
  copyFileSync(`data/sealed/${sealName}.root`, `site/sealed/${sealName}.root`);
  copyFileSync(otsPath, `site/sealed/${sealName}.root.ots`);
}
writeFileSync("site/data.js", `window.READOUT = ${JSON.stringify(data)};\n`);
const count = (s) => trials.filter((t) => t.state === s).length;
console.log(
  `site data: ${trials.length} trials (${count("screened")} screened, ${count("unscreened")} unscreened, ${count("public")} already public), seal ${seal.root.slice(0, 12)}`,
);
