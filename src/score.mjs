// Score one or more sets of forecasts against trial outcomes.
// Outcomes come from the model grader (data/label_results.jsonl) when that
// file exists, otherwise from the rough p-value rule stored on each case.
// Usage: node src/score.mjs <cases.jsonl> <name=forecasts.jsonl> [more...]
import { existsSync, readFileSync } from "node:fs";

const [casesPath, ...forecastArgs] = process.argv.slice(2);
if (!casesPath || !forecastArgs.length) {
  console.error("usage: node src/score.mjs <cases.jsonl> <name=forecasts.jsonl> [more...]");
  process.exit(1);
}

const load = (path) => readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const cases = load(casesPath);

const labelPath = "data/label_results.jsonl";
const outcome = new Map();
let labelSource;
if (existsSync(labelPath)) {
  labelSource = "model grader";
  for (const r of load(labelPath)) {
    if (r.label === "met") outcome.set(r.nct, 1);
    else if (r.label === "not_met") outcome.set(r.nct, 0);
  }
} else {
  labelSource = "p-value rule (rough: ignores direction and non-inferiority)";
  for (const c of cases) if (c.ruleLabel != null) outcome.set(c.nct, c.ruleLabel);
}

const brier = (rows) => rows.reduce((s, r) => s + (r.p - r.y) ** 2, 0) / rows.length;

// Probability that a randomly chosen success was rated above a randomly
// chosen failure. 0.5 is coin-flipping.
function auc(rows) {
  const pos = rows.filter((r) => r.y === 1);
  const neg = rows.filter((r) => r.y === 0);
  if (!pos.length || !neg.length) return NaN;
  let wins = 0;
  for (const a of pos) for (const b of neg) wins += a.p > b.p ? 1 : a.p === b.p ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

function report(title, rows) {
  if (rows.length < 10) {
    console.log(`  ${title.padEnd(34)} n=${rows.length} (too few to score)`);
    return;
  }
  const rate = rows.reduce((s, r) => s + r.y, 0) / rows.length;
  const constant = brier(rows.map((r) => ({ ...r, p: rate })));
  const b = brier(rows);
  // Skill: share of the constant-guess error removed. Above zero beats
  // "always say the base rate"; zero or below adds nothing.
  const skill = 1 - b / constant;
  console.log(
    `  ${title.padEnd(34)} n=${String(rows.length).padEnd(4)} success ${(rate * 100).toFixed(0).padStart(3)}%  ` +
      `Brier ${b.toFixed(4)} vs constant ${constant.toFixed(4)}  skill ${(skill * 100).toFixed(1).padStart(6)}%  AUC ${auc(rows).toFixed(3)}`,
  );
}

console.log(`outcomes from: ${labelSource}; ${outcome.size} of ${cases.length} cases have a usable outcome\n`);

// Trials where any forecaster said it remembers the real result. The flag is
// applied to every forecast set, so a baseline can be compared with the AI on
// exactly the trials the AI could not have remembered.
const recalled = new Set();
for (const arg of forecastArgs) {
  for (const r of load(arg.split("=")[1])) if (r.recalls_result) recalled.add(r.nct);
}

for (const arg of forecastArgs) {
  const [name, path] = arg.split("=");
  const forecasts = new Map();
  for (const r of load(path)) {
    if (typeof r.probability !== "number") continue;
    forecasts.set(r.nct, Math.min(1, Math.max(0, r.probability)));
  }
  const rows = cases
    .filter((c) => outcome.has(c.nct) && forecasts.has(c.nct))
    .map((c) => ({ ...c, y: outcome.get(c.nct), p: forecasts.get(c.nct) }));

  console.log(`${name}: ${rows.length} scored`);
  const live = rows.filter((r) => r.status !== "TERMINATED");
  report("all except terminated (headline)", live);
  report("  Phase 3", live.filter((r) => r.phase.includes("PHASE3")));
  report("  Phase 2 only", live.filter((r) => !r.phase.includes("PHASE3")));
  report("  industry sponsor", live.filter((r) => r.sponsorClass === "INDUSTRY"));
  report("  non-industry sponsor", live.filter((r) => r.sponsorClass !== "INDUSTRY"));
  if (recalled.size) {
    report("  model says it recalls result", live.filter((r) => recalled.has(r.nct)));
    report("  model does not recall result", live.filter((r) => !recalled.has(r.nct)));
  }
  report("terminated trials", rows.filter((r) => r.status === "TERMINATED"));

  console.log("  calibration (headline set):");
  for (let lo = 0; lo < 1; lo += 0.2) {
    const bin = live.filter((r) => r.p >= lo && (r.p < lo + 0.2 || lo >= 0.8));
    if (!bin.length) continue;
    const avgP = bin.reduce((s, r) => s + r.p, 0) / bin.length;
    const hit = bin.reduce((s, r) => s + r.y, 0) / bin.length;
    console.log(
      `    forecast ${(lo * 100).toFixed(0).padStart(2)}-${((lo + 0.2) * 100).toFixed(0)}%: n=${String(bin.length).padEnd(4)} avg forecast ${(avgP * 100).toFixed(0)}%  actual ${(hit * 100).toFixed(0)}%`,
    );
  }
  console.log();
}
