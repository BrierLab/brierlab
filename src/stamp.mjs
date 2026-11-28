// Ask an OpenTimestamps calendar to timestamp a file, and write the proof
// beside it as <file>.ots. The proof begins as the calendar's promise and can
// be upgraded to a Bitcoin proof by any OpenTimestamps tool a few hours later.
// Only the file's SHA-256 hash leaves this machine.
// Usage: node src/stamp.mjs <file>
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const [file] = process.argv.slice(2);
if (!file) {
  console.error("usage: node src/stamp.mjs <file>");
  process.exit(1);
}
if (existsSync(`${file}.ots`)) {
  console.error(`${file}.ots already exists; a proof is never overwritten`);
  process.exit(1);
}
const digest = createHash("sha256").update(readFileSync(file)).digest();
const HEADER = Buffer.concat([Buffer.from([0]), Buffer.from("OpenTimestamps"), Buffer.from([0, 0]), Buffer.from("Proof"), Buffer.from([0, 0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94, 0x01, 0x08])]);
for (const calendar of ["https://alice.btc.calendar.opentimestamps.org", "https://bob.btc.calendar.opentimestamps.org"]) {
  const res = await fetch(`${calendar}/digest`, { method: "POST", headers: { accept: "application/vnd.opentimestamps.v1" }, body: digest }).catch(() => null);
  if (!res?.ok) continue;
  const answer = Buffer.from(await res.arrayBuffer());
  if (answer.length < 40) continue;
  writeFileSync(`${file}.ots`, Buffer.concat([HEADER, digest, answer]));
  console.log(`${file}.ots written, promised by ${calendar}`);
  process.exit(0);
}
console.error("no calendar answered");
process.exit(1);
