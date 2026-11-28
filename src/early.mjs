// Put a newly sealed batch of forecasts into its holders-first window.
// The batch's fingerprint and size are public at once (site/early.json), so
// the seal can be checked by anyone from the first minute. The forecasts
// themselves (site/early/<name>.json) are served by the worker only to
// wallets holding the token until the window closes, then to everyone.
// site/early/ is not committed while a window is open.
// Usage: node src/early.mjs <seal-name> <cases.jsonl> [days, default 7]
//        node src/early.mjs close <seal-name>     (drop a batch from the list)
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const LIST = "site/early.json";
const list = existsSync(LIST) ? JSON.parse(readFileSync(LIST, "utf8")) : [];
const save = (next) => (next.length ? writeFileSync(LIST, JSON.stringify(next, null, 1)) : rmSync(LIST, { force: true }));

const [a, b, c] = process.argv.slice(2);
if (a === "close" && b) {
  rmSync(`site/early/${b}.json`, { force: true });
  save(list.filter((x) => x.name !== b));
  console.log(`closed ${b}`);
  process.exit(0);
}
if (!a || !b) {
  console.error("usage: node src/early.mjs <seal-name> <cases.jsonl> [days]\n       node src/early.mjs close <seal-name>");
  process.exit(1);
}
const days = Number(c ?? 7);
const seal = JSON.parse(readFileSync(`data/sealed/${a}.json`, "utf8"));
const cases = new Map(readFileSync(b, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((x) => [x.nct, x]));
const trials = seal.forecasts
  .filter((f) => cases.has(f.nct))
  .map((f) => {
    const x = cases.get(f.nct);
    return { nct: f.nct, title: x.title, sponsor: x.sponsor, phase: "Phase " + x.phase.replaceAll("PHASE", ""), due: x.primaryCompletion, method: f.method, probability: f.probability, leaf: f.leaf };
  })
  .sort((p, q) => (p.due < q.due ? -1 : 1));
const opensAt = new Date(Date.parse(seal.sealedAt) + days * 86_400_000).toISOString();
mkdirSync("site/early", { recursive: true });
writeFileSync(`site/early/${a}.json`, JSON.stringify({ name: a, sealedAt: seal.sealedAt, root: seal.root, opensAt, trials }));
save([...list.filter((x) => x.name !== a), { name: a, sealedAt: seal.sealedAt, root: seal.root, count: trials.length, opensAt }]);
console.log(`${a}: ${trials.length} forecasts, holders first until ${opensAt}`);
