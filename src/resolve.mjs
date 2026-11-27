// Check the sealed trials against the world and keep the outcome ledger.
//   node src/resolve.mjs check    ask the registry what changed since sealing: results posted,
//                                 trials stopped, finish dates moved. Writes data/watch.json.
//   node src/resolve.mjs add <nct> <met|not_met|void> <reported YYYY-MM-DD> <source url> <deciding words...>
//                                 record one outcome, with its source
//   node src/resolve.mjs score    print the live score
// The registry check is automatic. Reading a sponsor's announcement is not:
// a person or an assistant finds it, and `add` records it with the link and
// the sentence that decides it, so anyone can check the call.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { ruleLabel } from "./features.mjs";
import { FORECASTERS, LEDGER, VERDICTS, readLedger, scoreLive } from "./outcomes.mjs";

const [mode, ...args] = process.argv.slice(2);
const lines = (path) => readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const cases = lines("data/live_cases.jsonl");
const sealedAt = new Map(lines("data/live_raw.jsonl").map((s) => [s.protocolSection.identificationModule.nctId, s.protocolSection.statusModule ?? {}]));

if (mode === "check") {
  const ids = cases.map((c) => c.nct);
  const now = [];
  for (let i = 0; i < ids.length; i += 100) {
    const url = new URL("https://clinicaltrials.gov/api/v2/studies");
    url.searchParams.set("filter.ids", ids.slice(i, i + 100).join(","));
    url.searchParams.set("fields", "protocolSection.identificationModule.nctId,protocolSection.statusModule,hasResults,resultsSection.outcomeMeasuresModule");
    url.searchParams.set("pageSize", "100");
    let res;
    for (let attempt = 0; ; attempt++) {
      res = await fetch(url).catch(() => null);
      if (res?.ok) break;
      if (attempt >= 6) throw new Error(`ClinicalTrials.gov ${res?.status ?? "network error"} after retries`);
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
    }
    now.push(...((await res.json()).studies ?? []));
  }
  const done = new Set(readLedger().map((o) => o.nct));
  const today = new Date().toISOString().slice(0, 10);
  const watch = { checkedAt: new Date().toISOString(), trials: ids.length, pastFinish: [], resultsPosted: [], stopped: [], moved: [] };
  for (const s of now) {
    const nct = s.protocolSection.identificationModule.nctId;
    const st = s.protocolSection.statusModule ?? {};
    const was = sealedAt.get(nct) ?? {};
    const finish = st.primaryCompletionDateStruct?.date;
    const open = !done.has(nct);
    if (s.hasResults) {
      const primaries = (s.resultsSection?.outcomeMeasuresModule?.outcomeMeasures ?? []).filter((o) => o.type === "PRIMARY");
      const rule = ruleLabel(primaries);
      watch.resultsPosted.push({ nct, posted: st.resultsFirstPostDateStruct?.date, pValueRule: rule == null ? "no p-value" : rule ? "significant" : "not significant", inLedger: !open });
    }
    if (["TERMINATED", "WITHDRAWN", "SUSPENDED"].includes(st.overallStatus) && st.overallStatus !== was.overallStatus) watch.stopped.push({ nct, status: st.overallStatus, why: st.whyStopped ?? "", inLedger: !open });
    if (finish && finish !== was.primaryCompletionDateStruct?.date) watch.moved.push({ nct, from: was.primaryCompletionDateStruct?.date, to: finish });
    if (open && finish && (finish.length === 7 ? `${finish}-28` : finish) <= today && !["TERMINATED", "WITHDRAWN"].includes(st.overallStatus)) watch.pastFinish.push({ nct, finish, status: st.overallStatus });
  }
  watch.pastFinish.sort((a, b) => (a.finish < b.finish ? -1 : 1));
  writeFileSync("data/watch.json", JSON.stringify(watch, null, 1));
  console.log(`checked ${now.length} of ${ids.length} sealed trials against the registry`);
  console.log(`  results posted on the registry: ${watch.resultsPosted.length}`);
  console.log(`  stopped or withdrawn since sealing: ${watch.stopped.length}`);
  console.log(`  finish date moved since sealing: ${watch.moved.length}`);
  console.log(`  past their finish date with no outcome in the ledger: ${watch.pastFinish.length}`);
  console.log("wrote data/watch.json");
} else if (mode === "add") {
  const [nct, outcome, reportedOn, source, ...words] = args;
  const quote = words.join(" ").trim();
  if (!cases.some((c) => c.nct === nct)) throw new Error(`${nct} is not a sealed trial`);
  if (!VERDICTS.includes(outcome)) throw new Error(`outcome must be one of ${VERDICTS.join(", ")}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reportedOn ?? "") || Number.isNaN(Date.parse(reportedOn))) throw new Error("reported date must be YYYY-MM-DD");
  if (!/^https:\/\//.test(source ?? "")) throw new Error("source must be an https link");
  if (quote.length < 20) throw new Error("give the words from the source that decide the outcome");
  if (readLedger().some((o) => o.nct === nct)) throw new Error(`${nct} is already in the ledger; edit ${LEDGER} by hand to correct it, and say so in the notebook`);
  appendFileSync(LEDGER, JSON.stringify({ nct, outcome, reportedOn, source, quote, recordedAt: new Date().toISOString() }) + "\n");
  console.log(`recorded ${nct}: ${outcome}, reported ${reportedOn}`);
} else if (mode === "score") {
  const s = scoreLive();
  console.log(`${s.resolved.length} outcomes in the ledger, ${s.scored} counted (${s.met} met). This view does not apply the "already public when sealed" rule; the site does.`);
  for (const [who, t] of Object.entries(s.table)) console.log(`  ${FORECASTERS[who].padEnd(22)} n=${String(t.n).padEnd(4)} Brier ${t.brier.toFixed(4)}  leaned the right way ${t.right} of ${t.n}`);
  for (const r of s.resolved.filter((x) => !x.counted)) console.log(`  not counted: ${r.nct} (${r.why})`);
} else {
  console.error("usage: node src/resolve.mjs check | add <nct> <met|not_met|void> <reported YYYY-MM-DD> <source url> <deciding words...> | score");
  process.exit(1);
}
