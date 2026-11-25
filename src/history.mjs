// Pull the full history of randomized Phase 2/3 drug trials with posted
// results from ClinicalTrials.gov, and keep a slim copy of each: the
// registration record plus the p-values on its primary outcomes. This is the
// training set for the learned model (src/train.mjs).
// Usage: node src/history.mjs <from YYYY-MM-DD> <to YYYY-MM-DD> <out.jsonl>
import { createWriteStream } from "node:fs";

const [from, to, out] = process.argv.slice(2);
if (!from || !to || !out) {
  console.error("usage: node src/history.mjs <from> <to> <out.jsonl>");
  process.exit(1);
}

const BASE = "https://clinicaltrials.gov/api/v2/studies";
const advanced = [
  "AREA[StudyType]INTERVENTIONAL",
  "(AREA[Phase]PHASE2 OR AREA[Phase]PHASE3)",
  "(AREA[InterventionType]DRUG OR AREA[InterventionType]BIOLOGICAL)",
  "AREA[DesignAllocation]RANDOMIZED",
].join(" AND ");

// Site lists and reference lists are large and unused; keep counts only.
function slim(s) {
  const p = { ...s.protocolSection };
  const locations = p.contactsLocationsModule?.locations ?? [];
  p.contactsLocationsModule = {
    siteCount: locations.length,
    countries: [...new Set(locations.map((l) => l.country).filter(Boolean))],
  };
  delete p.referencesModule;
  const primaries = (s.resultsSection?.outcomeMeasuresModule?.outcomeMeasures ?? [])
    .filter((o) => o.type === "PRIMARY")
    .map((o) => ({
      title: o.title,
      analyses: (o.analyses ?? []).map((a) => ({
        pValue: a.pValue,
        nonInferiorityType: a.nonInferiorityType,
        statisticalMethod: a.statisticalMethod,
      })),
    }));
  return { protocolSection: p, primaries };
}

const stream = createWriteStream(out);
let token = null;
let n = 0;
do {
  const url = new URL(BASE);
  url.searchParams.set("query.term", `AREA[ResultsFirstPostDate]RANGE[${from},${to}]`);
  url.searchParams.set("filter.advanced", advanced);
  url.searchParams.set("fields", "protocolSection,resultsSection.outcomeMeasuresModule");
  url.searchParams.set("pageSize", "200");
  if (token) url.searchParams.set("pageToken", token);

  let res;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(url).catch(() => null);
    if (res?.ok) break;
    if (attempt >= 6) throw new Error(`ClinicalTrials.gov ${res?.status ?? "network error"} after retries`);
    await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
  }
  const page = await res.json();
  for (const s of page.studies ?? []) {
    stream.write(JSON.stringify(slim(s)) + "\n");
    n++;
  }
  token = page.nextPageToken ?? null;
  process.stderr.write(`\r${n} studies`);
} while (token);

await new Promise((r) => stream.end(r));
console.error(`\nwrote ${n} studies to ${out}`);
