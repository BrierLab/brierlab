// Later batches of forecasts and where their files live.
//   data/held/<name>/      a sealed batch that is not public yet: its cases,
//                          forecasts, sealed file and (once opened) its
//                          holders-first window. Never committed.
//   data/batches/<name>/   a released batch: cases and forecasts, public.
//   data/sealed/<name>.*   the fingerprint and its timestamp proof are public
//                          from the day of sealing; the sealed file joins
//                          them on release.
// A batch is released when its window has passed. The first record
// (data/live_*.jsonl) predates this layout and stays where it is.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

const HELD = "data/held";
const OUT = "data/batches";
const LIST = "site/early.json";
const FILES = ["cases.jsonl", "live_results.jsonl"];
const dirs = (root) => (existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort() : []);
const json = (path) => JSON.parse(readFileSync(path, "utf8"));

export const earlyList = () => (existsSync(LIST) ? json(LIST) : []);
export const saveEarlyList = (list) => (list.length ? writeFileSync(LIST, JSON.stringify(list, null, 1)) : rmSync(LIST, { force: true }));

// Take a freshly sealed batch out of public view until its window is opened.
export function hold(name) {
  mkdirSync(`${HELD}/${name}`, { recursive: true });
  for (const f of FILES) if (existsSync(`${OUT}/${name}/${f}`)) renameSync(`${OUT}/${name}/${f}`, `${HELD}/${name}/${f}`);
  if (existsSync(`data/sealed/${name}.json`)) renameSync(`data/sealed/${name}.json`, `${HELD}/${name}/seal.json`);
  rmSync(`${HELD}/${name}/window.json`, { force: true });
  rmSync(`site/early/${name}.json`, { force: true });
  rmSync(`site/sealed/${name}.json`, { force: true });
  saveEarlyList(earlyList().filter((x) => x.name !== name));
}

// Make every held batch whose window has passed public. Returns their names.
export function releaseDue(now = Date.now()) {
  const done = [];
  for (const name of dirs(HELD)) {
    const window = `${HELD}/${name}/window.json`;
    if (!existsSync(window) || Date.parse(json(window).opensAt) > now) continue;
    mkdirSync(`${OUT}/${name}`, { recursive: true });
    for (const f of FILES) renameSync(`${HELD}/${name}/${f}`, `${OUT}/${name}/${f}`);
    renameSync(`${HELD}/${name}/seal.json`, `data/sealed/${name}.json`);
    rmSync(`${HELD}/${name}`, { recursive: true, force: true });
    rmSync(`site/early/${name}.json`, { force: true });
    saveEarlyList(earlyList().filter((x) => x.name !== name));
    done.push(name);
  }
  return done;
}

// Every released batch, oldest first.
export function released() {
  return dirs(OUT)
    .filter((name) => existsSync(`data/sealed/${name}.json`) && FILES.every((f) => existsSync(`${OUT}/${name}/${f}`)))
    .map((name) => ({ name, seal: json(`data/sealed/${name}.json`), cases: `${OUT}/${name}/cases.jsonl`, results: `${OUT}/${name}/live_results.jsonl` }))
    .sort((a, b) => (a.seal.sealedAt < b.seal.sealedAt ? -1 : 1));
}

export const heldBatch = (name) => ({ seal: json(`${HELD}/${name}/seal.json`), cases: `${HELD}/${name}/cases.jsonl`, dir: `${HELD}/${name}` });

// Sealed batches that are not public yet, with what may be said about them:
// the fingerprint, the size and the sealing time.
export const heldList = () =>
  dirs(HELD)
    .filter((name) => existsSync(`${HELD}/${name}/seal.json`))
    .map((name) => {
      const s = json(`${HELD}/${name}/seal.json`);
      return { name, root: s.root, count: s.count, sealedAt: s.sealedAt };
    });
