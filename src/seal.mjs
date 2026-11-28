// Seal a set of forecasts so nobody, including us, can change them later
// without it showing. Each forecast becomes one hash; the hashes are folded
// into a single Merkle root. Publishing or timestamping that one root commits
// to every forecast, and any single forecast can later be proven to belong to
// it without revealing the others.
// Usage: node src/seal.mjs <name> <results.jsonl> [more results.jsonl...]
// Writes data/sealed/<name>.json (the full record) and data/sealed/<name>.root
// (the 32 raw bytes of the root, the file to timestamp).
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { leafText } from "./record.mjs";

const [name, ...paths] = process.argv.slice(2);
if (!name || !paths.length) {
  console.error("usage: node src/seal.mjs <name> <results.jsonl> [more...]");
  process.exit(1);
}

const sha256 = (data) => createHash("sha256").update(data).digest();

const forecasts = [];
for (const path of paths) {
  // The file name says how the forecast was made, e.g. "live" or
  // "live_researched".
  const method = path.split("/").pop().replace(/_results\.jsonl$/, "");
  for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
    const r = JSON.parse(line);
    if (r.error || typeof r.probability !== "number") continue;
    forecasts.push({ nct: r.nct, method, probability: r.probability, model: r.model, madeAt: r.madeAt });
  }
}
if (!forecasts.length) {
  console.error("no forecasts to seal");
  process.exit(1);
}
forecasts.sort((a, b) => (a.nct + a.method < b.nct + b.method ? -1 : 1));

const leaves = forecasts.map((f) => sha256(leafText(f)));

// Standard pairwise Merkle tree; an odd node at the end of a level is paired
// with itself.
let level = leaves;
while (level.length > 1) {
  const next = [];
  for (let i = 0; i < level.length; i += 2) {
    next.push(sha256(Buffer.concat([level[i], level[i + 1] ?? level[i]])));
  }
  level = next;
}
const root = level[0];

mkdirSync("data/sealed", { recursive: true });
writeFileSync(`data/sealed/${name}.root`, root);
writeFileSync(
  `data/sealed/${name}.json`,
  JSON.stringify(
    {
      sealedAt: new Date().toISOString(),
      count: forecasts.length,
      root: root.toString("hex"),
      hashing: "leaf = sha256(JSON of {nct, method, probability, model, madeAt}); pairwise sha256 Merkle tree over leaves sorted by nct+method, odd node paired with itself",
      forecasts: forecasts.map((f, i) => ({ ...f, leaf: leaves[i].toString("hex") })),
    },
    null,
    1,
  ),
);
console.log(`sealed ${forecasts.length} forecasts, root ${root.toString("hex")}`);
