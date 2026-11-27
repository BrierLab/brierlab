// The outcome ledger and the live score.
// data/outcomes.jsonl holds one line per trial whose result is known, each
// with a public source and the words that decide it. The rules:
//   1. A trial is "met" when the sponsor or the registry reports that the
//      first-listed primary endpoint was met with statistical significance in
//      the drug's favor, and "not_met" when it reports that it was not.
//   2. A trial stopped for futility, lack of efficacy or safety is "not_met".
//      A trial stopped or withdrawn for any other reason, or whose endpoint
//      has no pass/fail reading, is "void" and is never scored.
//   3. A trial whose result was already public when we sealed is never scored.
//   4. Each forecaster is scored on its latest forecast sealed at least one
//      full day before the result was reported. A forecaster with no such
//      seal for a trial is not scored on that trial.
import { existsSync, readdirSync, readFileSync } from "node:fs";

export const LEDGER = "data/outcomes.jsonl";
export const VERDICTS = ["met", "not_met", "void"];
const DAY = 86_400_000;

export const readLedger = () =>
  existsSync(LEDGER) ? readFileSync(LEDGER, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

// Every sealed set, oldest first, grouped by forecaster.
function seals() {
  const sets = readdirSync("data/sealed")
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ name: f.replace(/\.json$/, ""), ...JSON.parse(readFileSync(`data/sealed/${f}`, "utf8")) }))
    .sort((a, b) => (a.sealedAt < b.sealedAt ? -1 : 1));
  const who = (name) => (name.endsWith("-ml") ? "learned" : name.endsWith("-baseline") ? "baseline" : "headline");
  return sets.map((s) => ({ name: s.name, who: who(s.name), at: Date.parse(s.sealedAt), forecasts: s.forecasts }));
}

// The forecast a sealed set holds for a trial. The headline set holds two per
// screened trial; the one made with the evidence brief is the published one.
function forecastIn(set, nct) {
  const mine = set.forecasts.filter((f) => f.nct === nct);
  return (mine.find((f) => f.method === "live_researched") ?? mine[0])?.probability ?? null;
}

export const FORECASTERS = { headline: "Published forecast", learned: "Learned model", baseline: "Statistical baseline" };

// publicAtSeal: the trials rule 3 excludes.
export function scoreLive(publicAtSeal = new Set()) {
  const all = seals();
  const resolved = [];
  for (const o of readLedger()) {
    const row = { ...o, counted: false, forecasts: {} };
    if (o.outcome === "void") row.why = "void";
    else if (publicAtSeal.has(o.nct)) row.why = "already public when sealed";
    else {
      const reported = Date.parse(o.reportedOn);
      for (const who of Object.keys(FORECASTERS)) {
        const set = all.filter((s) => s.who === who && s.at + DAY <= reported && forecastIn(s, o.nct) != null).at(-1);
        if (set) row.forecasts[who] = { p: forecastIn(set, o.nct), seal: set.name };
      }
      row.counted = row.forecasts.headline != null;
      if (!row.counted) row.why = "reported before the forecast was sealed";
    }
    resolved.push(row);
  }
  const counted = resolved.filter((r) => r.counted);
  const table = {};
  for (const who of Object.keys(FORECASTERS)) {
    const rows = counted.filter((r) => r.forecasts[who]);
    if (!rows.length) continue;
    const y = (r) => (r.outcome === "met" ? 1 : 0);
    table[who] = {
      n: rows.length,
      brier: rows.reduce((s, r) => s + (r.forecasts[who].p - y(r)) ** 2, 0) / rows.length,
      // Calling the side it leaned toward: above 50% and met, or below and not met.
      right: rows.filter((r) => r.forecasts[who].p !== 0.5 && r.forecasts[who].p > 0.5 === (y(r) === 1)).length,
    };
  }
  return { resolved, scored: counted.length, met: counted.filter((r) => r.outcome === "met").length, table };
}
