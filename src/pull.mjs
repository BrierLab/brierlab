// Copy the evidence reports made on request from the live site into the
// repository, so they are kept with the rest of the record and scored by the
// same rules. Writes data/on_demand_results.jsonl (one report per line) and
// each report's timestamp proof under data/on_demand/.
// Usage: node src/pull.mjs [site, default https://brierlab.com]
import { mkdirSync, writeFileSync } from "node:fs";

const site = process.argv[2] ?? "https://brierlab.com";
const list = await (await fetch(`${site}/api/reports`)).json();
const ncts = Object.keys(list.reports ?? {}).sort();
mkdirSync("data/on_demand", { recursive: true });
const lines = [];
for (const nct of ncts) {
  const { paid, stamped, ...report } = await (await fetch(`${site}/api/report/${nct}`)).json();
  // Whether a report was paid for is kept as a yes or no, never the wallet.
  lines.push(JSON.stringify({ ...report, paid: !!paid }));
  if (stamped) {
    const proof = await fetch(`${site}/api/report/${nct}.ots`);
    if (proof.ok) writeFileSync(`data/on_demand/${nct}.txt.ots`, Buffer.from(await proof.arrayBuffer()));
  }
}
writeFileSync("data/on_demand_results.jsonl", lines.length ? lines.join("\n") + "\n" : "");
console.log(`${lines.length} reports on request saved`);
