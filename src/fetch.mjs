// Pull randomized Phase 2/3 drug and biologic trials from ClinicalTrials.gov
// whose results were first posted inside a date window.
// Usage: node src/fetch.mjs <from YYYY-MM-DD> <to YYYY-MM-DD|MAX> <out.jsonl> [upcoming]
// With "upcoming", the window applies to the planned primary completion date
// instead, and only industry-run trials that are still under way are kept:
// these are the trials to forecast before they read out.
import { createWriteStream } from "node:fs";

const [from, to, out, mode] = process.argv.slice(2);
if (!from || !to || !out || (mode && mode !== "upcoming")) {
  console.error("usage: node src/fetch.mjs <from> <to|MAX> <out.jsonl> [upcoming]");
  process.exit(1);
}
const upcoming = mode === "upcoming";

const BASE = "https://clinicaltrials.gov/api/v2/studies";
const advanced = [
  "AREA[StudyType]INTERVENTIONAL",
  "(AREA[Phase]PHASE2 OR AREA[Phase]PHASE3)",
  "(AREA[InterventionType]DRUG OR AREA[InterventionType]BIOLOGICAL)",
  "AREA[DesignAllocation]RANDOMIZED",
  ...(upcoming ? ["AREA[LeadSponsorClass]INDUSTRY"] : []),
].join(" AND ");
const dateField = upcoming ? "PrimaryCompletionDate" : "ResultsFirstPostDate";

const stream = createWriteStream(out);
let token = null;
let n = 0;
do {
  const url = new URL(BASE);
  url.searchParams.set("query.term", `AREA[${dateField}]RANGE[${from},${to}]`);
  url.searchParams.set("filter.advanced", advanced);
  if (upcoming) {
    url.searchParams.set("filter.overallStatus", "ACTIVE_NOT_RECRUITING|RECRUITING|ENROLLING_BY_INVITATION");
  }
  url.searchParams.set("pageSize", "100");
  if (token) url.searchParams.set("pageToken", token);

  let res;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(url);
    if (res.ok) break;
    if (attempt >= 4) throw new Error(`ClinicalTrials.gov ${res.status} after retries`);
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
  const page = await res.json();
  for (const s of page.studies ?? []) {
    stream.write(JSON.stringify(s) + "\n");
    n++;
  }
  token = page.nextPageToken ?? null;
  process.stderr.write(`\r${n} studies`);
} while (token);

await new Promise((r) => stream.end(r));
console.error(`\nwrote ${n} studies to ${out}`);
