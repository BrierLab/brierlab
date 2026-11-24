// Run one model pass over every case through OpenRouter's batch API
// (asynchronous, discounted). Two tasks:
//   label    - grade each trial's posted results as met / not_met / unclear
//   forecast - estimate the probability of meeting the primary endpoint
// The batch id is saved before polling starts, so rerunning the command
// resumes the existing batch instead of paying for a second one.
// Usage: node src/batch.mjs <label|forecast> [cases.jsonl] [--sync N]
//   --sync N runs only the first N cases one at a time and prints them,
//   for checking the request shape before paying for a full batch.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { appendFileSync } from "node:fs";
import { resultIsPublic } from "./briefs.mjs";
import { FORECAST_SYSTEM, LABEL_SYSTEM, forecastLiveSystem, researchSystem } from "./prompts.mjs";

const MODEL = "anthropic/claude-opus-5.5";
const API = "https://openrouter.ai/api/v1";
const TODAY = new Date().toISOString().slice(0, 10);

const FORECAST_SCHEMA = {
  type: "object",
  properties: {
    probability: { type: "number" },
    recalls_result: { type: "boolean" },
    rationale: { type: "string" },
  },
  required: ["probability", "recalls_result", "rationale"],
  additionalProperties: false,
};
const validForecast = (o) =>
  typeof o.probability === "number" &&
  o.probability >= 0 &&
  o.probability <= 1 &&
  typeof o.recalls_result === "boolean";

// Evidence briefs written by the research task, keyed by trial.
const briefs = new Map();
if (existsSync("data/research_results.jsonl")) {
  for (const line of readFileSync("data/research_results.jsonl", "utf8").split("\n").filter(Boolean)) {
    const r = JSON.parse(line);
    // A trial whose result is already out is not a forecast; leave it out.
    if (r.brief && !resultIsPublic(r.brief)) briefs.set(r.nct, r.brief);
  }
}

// Live tasks work on trials that have not read out:
//   live             - forecast from the registration record alone
//   research         - search the web and write an evidence brief (one call
//                      per trial, run directly, not batched)
//   live_researched  - forecast from the record plus its evidence brief
const TASKS = {
  live: {
    system: forecastLiveSystem(TODAY),
    input: (c) => c.forecastInput,
    schema: FORECAST_SCHEMA,
    valid: validForecast,
  },
  live_researched: {
    system: forecastLiveSystem(TODAY),
    only: (c) => briefs.has(c.nct),
    input: (c) => `${c.forecastInput}\n\nEvidence brief:\n${briefs.get(c.nct)}`,
    schema: FORECAST_SCHEMA,
    valid: validForecast,
  },
  research: {
    system: researchSystem(TODAY),
    input: (c) => c.forecastInput,
    web: true,
    // Search results are bulky, so evidence gathering runs on a cheaper
    // model (override with RESEARCH_MODEL); the forecast itself stays on
    // the strongest one.
    model: process.env.RESEARCH_MODEL ?? "anthropic/claude-haiku-5.5",
  },
  label: {
    system: LABEL_SYSTEM,
    input: (c) => c.labelInput,
    schema: {
      type: "object",
      properties: {
        label: { type: "string", enum: ["met", "not_met", "unclear"] },
        reason: { type: "string" },
      },
      required: ["label", "reason"],
      additionalProperties: false,
    },
    valid: (o) => ["met", "not_met", "unclear"].includes(o.label) && typeof o.reason === "string",
  },
  forecast: {
    system: FORECAST_SYSTEM,
    input: (c) => c.forecastInput,
    schema: {
      type: "object",
      properties: {
        probability: { type: "number" },
        recalls_result: { type: "boolean" },
        rationale: { type: "string" },
      },
      required: ["probability", "recalls_result", "rationale"],
      additionalProperties: false,
    },
    valid: (o) =>
      typeof o.probability === "number" &&
      o.probability >= 0 &&
      o.probability <= 1 &&
      typeof o.recalls_result === "boolean",
  },
};

const args = process.argv.slice(2);
const syncAt = args.indexOf("--sync");
const syncCount = syncAt >= 0 ? Number(args[syncAt + 1]) : 0;
if (syncAt >= 0) args.splice(syncAt, 2);
const [taskName, casesPath = "data/cases.jsonl"] = args;
const task = TASKS[taskName];
if (!task) {
  console.error("usage: node src/batch.mjs <label|forecast|live|research|live_researched> <cases.jsonl> [--sync N] [--limit N]");
  process.exit(1);
}

const key =
  process.env.OPENROUTER_API_KEY ??
  readFileSync(`${homedir()}/.config/readout/openrouter_key`, "utf8").trim();
const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

const limitAt = args.indexOf("--limit");
const limit = limitAt >= 0 ? Number(args[limitAt + 1]) : Infinity;
const cases = readFileSync(casesPath, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .filter((c) => !task.only || task.only(c))
  .slice(0, limit);

const body = (c) => ({
  // Batches are pre-authorised at max_tokens per request, so the ceiling is
  // kept near what a forecast really needs (a few hundred tokens).
  max_tokens: task.web || taskName === "label" ? 16000 : 3000,
  reasoning: { effort: task.web ? "medium" : "high" },
  // A research call returns prose with sources; every other task returns
  // JSON that must match its schema.
  ...(task.web
    ? { plugins: [{ id: "web", engine: "native", max_results: 5 }] }
    : {
        response_format: {
          type: "json_schema",
          json_schema: { name: taskName, strict: true, schema: task.schema },
        },
      }),
  messages: [
    { role: "system", content: task.system },
    { role: "user", content: task.input(c) },
  ],
});

// Turn one chat-completion response into a result row. A refusal, a cut-off
// answer, or output that fails the schema becomes an error row, never a guess.
function toRow(nct, response) {
  const choice = response?.choices?.[0];
  if (!choice) return { nct, error: "no_choice" };
  if (choice.finish_reason !== "stop") return { nct, error: choice.finish_reason ?? "unknown_finish" };
  const stamp = { model: response.model ?? MODEL, madeAt: new Date().toISOString() };
  if (task.web) {
    const brief = (choice.message?.content ?? "").trim();
    if (!brief) return { nct, error: "empty_brief" };
    const sources = [
      ...new Set((choice.message?.annotations ?? []).map((a) => a.url_citation?.url).filter(Boolean)),
    ];
    return { nct, brief, sources, cost: response.usage?.cost ?? null, ...stamp };
  }
  let parsed;
  try {
    parsed = JSON.parse(choice.message?.content ?? "");
  } catch {
    return { nct, error: "bad_json" };
  }
  if (!task.valid(parsed)) return { nct, error: "bad_output" };
  return { nct, ...parsed, ...stamp };
}

// retryNotFound: a batch can return 404 for a few seconds after it is
// created, so polling treats "not found" as "not yet visible".
async function call(path, init, { retryNotFound = false } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}`, { ...init, headers });
    if (res.ok) return res.json();
    const retryable = res.status === 429 || res.status >= 500 || (retryNotFound && res.status === 404);
    if (!retryable || attempt >= 5) {
      throw new Error(`OpenRouter ${res.status} on ${path}: ${(await res.text()).slice(0, 500)}`);
    }
    await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
  }
}

if (syncCount > 0) {
  for (const c of cases.slice(0, syncCount)) {
    const response = await call("/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: task.model ?? MODEL, ...body(c) }),
    });
    console.log(JSON.stringify(toRow(c.nct, response)));
    console.log("  usage", JSON.stringify(response.usage));
  }
  process.exit(0);
}

const idPath = `data/${taskName}_batch.json`;
const outPath = `data/${taskName}_results.jsonl`;

// Research runs as direct calls, four at a time, appending each brief as it
// lands. Trials that already have a row are skipped, so it can be rerun.
if (task.web) {
  const done = new Set(
    existsSync(outPath)
      ? readFileSync(outPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => !r.error).map((r) => r.nct)
      : [],
  );
  const queue = cases.filter((c) => !done.has(c.nct));
  console.log(`${done.size} already done, ${queue.length} to research`);
  let spent = 0;
  let failed = 0;
  const worker = async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      let row;
      try {
        const response = await call("/chat/completions", {
          method: "POST",
          body: JSON.stringify({ model: task.model ?? MODEL, ...body(c) }),
        });
        row = toRow(c.nct, response);
        spent += response.usage?.cost ?? 0;
      } catch (err) {
        row = { nct: c.nct, error: String(err.message).slice(0, 200) };
      }
      if (row.error) failed++;
      appendFileSync(outPath, JSON.stringify(row) + "\n");
      console.log(`${c.nct} ${row.error ? "FAILED " + row.error : "ok"}  running cost $${spent.toFixed(2)}`);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  console.log(`research finished: ${failed} failed, cost $${spent.toFixed(2)}`);
  process.exit(0);
}

let batchId;
if (existsSync(idPath)) {
  batchId = JSON.parse(readFileSync(idPath, "utf8")).id;
  console.log(`resuming batch ${batchId}`);
} else {
  // OpenRouter requires "requests" to be the last key in the body.
  const created = await call("/batches", {
    method: "POST",
    body: JSON.stringify({
      endpoint: "/v1/chat/completions",
      model: MODEL,
      requests: cases.map((c) => ({ custom_id: c.nct, body: body(c) })),
    }),
  });
  batchId = created.id ?? created.data?.id;
  if (!batchId) throw new Error(`no batch id in response: ${JSON.stringify(created).slice(0, 300)}`);
  writeFileSync(idPath, JSON.stringify({ id: batchId, task: taskName, model: MODEL, n: cases.length }));
  console.log(`created batch ${batchId} with ${cases.length} requests`);
}

const FINAL = ["completed", "failed", "expired", "cancelled"];
let batch;
while (true) {
  const got = await call(`/batches/${batchId}`, { method: "GET" }, { retryNotFound: true });
  batch = got.data ?? got;
  if (FINAL.includes(batch.status)) break;
  console.log(`status ${batch.status}`);
  await new Promise((r) => setTimeout(r, 60_000));
}
if (batch.status !== "completed") {
  throw new Error(`batch ${batchId} ended as ${batch.status}: ${JSON.stringify(batch.errors ?? batch.error ?? "")}`);
}

const problems = {};
const lines = [];
for (const item of batch.results ?? []) {
  const row = item.error
    ? { nct: item.custom_id, error: `request_error: ${JSON.stringify(item.error).slice(0, 200)}` }
    : toRow(item.custom_id, item.response?.body);
  if (row.error) problems[row.error.split(":")[0]] = (problems[row.error.split(":")[0]] ?? 0) + 1;
  lines.push(JSON.stringify(row));
}
writeFileSync(outPath, lines.join("\n") + "\n");

console.log(`wrote ${lines.length} rows to ${outPath}`);
console.log("problems", problems);
console.log("usage", JSON.stringify(batch.usage));
