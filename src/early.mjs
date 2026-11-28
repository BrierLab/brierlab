// Holders-first windows for new batches of forecasts.
//   node src/early.mjs hold <seal-name>          take a freshly sealed batch out of public view
//   node src/early.mjs open <seal-name> [days]   start its window now (default 7 days)
// While a window is open the batch's fingerprint and size are public
// (site/early.json) and the forecasts themselves (site/early/<name>.json) are
// served by the worker only to wallets holding the token. When the window
// has passed, the next site build (src/site.mjs) releases the batch into the
// main record. File layout: src/batches.mjs.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { earlyList, heldBatch, hold, saveEarlyList } from "./batches.mjs";

const [mode, name, daysArg] = process.argv.slice(2);
if (!["hold", "open"].includes(mode) || !name) {
  console.error("usage: node src/early.mjs hold <seal-name>\n       node src/early.mjs open <seal-name> [days]");
  process.exit(1);
}
if (mode === "hold") {
  hold(name);
  console.log(`${name} is held: its forecasts are in data/held/${name}/ and are not public`);
  process.exit(0);
}
const days = Number(daysArg ?? 7);
const b = heldBatch(name);
const cases = new Map(readFileSync(b.cases, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((x) => [x.nct, x]));
const trials = b.seal.forecasts
  .filter((f) => cases.has(f.nct))
  .map((f) => {
    const x = cases.get(f.nct);
    return { nct: f.nct, title: x.title, sponsor: x.sponsor, phase: "Phase " + x.phase.replaceAll("PHASE", ""), due: x.primaryCompletion, method: f.method, probability: f.probability, leaf: f.leaf };
  })
  .sort((p, q) => (p.due < q.due ? -1 : 1));
const openedAt = new Date().toISOString();
const opensAt = new Date(Date.now() + days * 86_400_000).toISOString();
const head = { name, sealedAt: b.seal.sealedAt, root: b.seal.root, openedAt, opensAt };
writeFileSync(`${b.dir}/window.json`, JSON.stringify(head));
mkdirSync("site/early", { recursive: true });
writeFileSync(`site/early/${name}.json`, JSON.stringify({ ...head, trials }));
saveEarlyList([...earlyList().filter((x) => x.name !== name), { ...head, count: trials.length }]);
console.log(`${name}: ${trials.length} forecasts, holders first until ${opensAt}`);
