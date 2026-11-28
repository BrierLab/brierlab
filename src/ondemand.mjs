// Reports made on request. A visitor picks a sealed trial that has only a
// record-based forecast; the worker reads the registry, searches the web for
// evidence, forecasts with that evidence, and records the forecast's hash
// with an outside timestamp. Reports live in the REPORTS store, one per trial.
// Paid for one of two ways: a small free allowance each day, or (once a token
// exists) by burning the report price from a signed-in wallet.
import { resultIsPublic } from "./briefs.mjs";
import { forecastLiveSystem, researchSystem } from "./prompts.mjs";
import { forecastInput, leafText } from "./record.mjs";
import { Refused, burned, signedInAs, tokenInfo } from "./token.mjs";

const MODELS = "https://openrouter.ai/api/v1/chat/completions";
const REGISTRY = "https://clinicaltrials.gov/api/v2/studies";
const CALENDARS = ["https://alice.btc.calendar.opentimestamps.org", "https://bob.btc.calendar.opentimestamps.org"];
const FORECAST_MODEL = "anthropic/claude-opus-5.5";
const RESEARCH_MODEL = "anthropic/claude-haiku-5.5";
export const METHOD = "on_demand";

const enc = new TextEncoder();
const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (text) => new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text)));
const today = () => new Date().toISOString().slice(0, 10);
const freePerDay = (env) => Math.max(0, Number(env.DAILY_FREE ?? 0) || 0);

const FORECAST_SCHEMA = {
  type: "object",
  properties: { probability: { type: "number" }, recalls_result: { type: "boolean" }, rationale: { type: "string" } },
  required: ["probability", "recalls_result", "rationale"],
  additionalProperties: false,
};

async function ask(env, body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(MODELS, {
      method: "POST",
      headers: { authorization: `Bearer ${env.OPENROUTER_KEY}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const out = await res.json();
      const choice = out.choices?.[0];
      if (choice?.finish_reason === "stop") return { message: choice.message, cost: out.usage?.cost ?? 0, model: out.model ?? body.model };
      throw new Error(`model stopped early: ${choice?.finish_reason ?? "no answer"}`);
    }
    if (attempt >= 1 || (res.status !== 429 && res.status < 500)) throw new Error(`model service answered ${res.status}`);
    await new Promise((r) => setTimeout(r, 4000));
  }
}

// An OpenTimestamps proof for a 32-byte hash: the standard file header, the
// hash, then what the calendar server returns. It starts as a promise from
// the calendar and can be upgraded to a Bitcoin proof by any OpenTimestamps
// tool once the calendar's next Bitcoin transaction confirms.
const OTS_HEADER = [0x00, ...enc.encode("OpenTimestamps"), 0x00, 0x00, ...enc.encode("Proof"), 0x00, 0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94, 0x01, 0x08];
async function stamp(digest) {
  for (const calendar of CALENDARS) {
    try {
      const res = await fetch(`${calendar}/digest`, {
        method: "POST",
        headers: { accept: "application/vnd.opentimestamps.v1", "content-type": "application/x-www-form-urlencoded" },
        body: digest,
      });
      if (!res.ok) continue;
      const answer = new Uint8Array(await res.arrayBuffer());
      if (answer.length < 40 || answer.length > 4096) continue;
      const file = Uint8Array.from([...OTS_HEADER, ...digest, ...answer]);
      return { calendar, proof: btoa(String.fromCharCode(...file)) };
    } catch {}
  }
  return null;
}

// One line per finished report, read from the store's own key list so two
// reports finishing together cannot overwrite each other.
async function summaries(env) {
  const out = {};
  let cursor;
  do {
    const page = await env.REPORTS.list({ prefix: "report:", cursor });
    for (const k of page.keys) out[k.name.slice(7)] = k.metadata;
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return out;
}

export async function listReports(env) {
  const perDay = freePerDay(env);
  const [reports, used, token] = await Promise.all([
    summaries(env),
    env.REPORTS.get(`day:${today()}`),
    tokenInfo(env).catch(() => null),
  ]);
  return { perDay, left: Math.max(0, perDay - Number(used ?? 0)), reports, token };
}

// What the public sees of a stored report: not the proof bytes (served as
// their own file), not what it cost us, and for a paid one only the burn.
function shown({ proof, cost, paid, ...rest }) {
  return { ...rest, stamped: !!proof, paid: paid ? { tx: paid.tx, amount: paid.amount, symbol: paid.symbol } : false };
}

export async function getReport(env, nct, part) {
  const report = await env.REPORTS.get(`report:${nct}`, "json");
  if (!report) return null;
  if (part === "txt") return new Response(report.sealedText, { headers: { "content-type": "text/plain; charset=utf-8", "content-disposition": `attachment; filename="${nct}.txt"` } });
  if (part === "ots") {
    if (!report.proof) return null;
    return new Response(Uint8Array.from(atob(report.proof), (c) => c.charCodeAt(0)), {
      headers: { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${nct}.txt.ots"` },
    });
  }
  return Response.json(shown(report), { headers: { "cache-control": "no-store" } });
}

// The work itself. say() reports each step to the waiting page.
async function make(env, nct, say) {
  say({ step: "record" });
  const res = await fetch(`${REGISTRY}/${nct}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Refused("The trial registry did not answer. Nothing was used up; try again in a minute.", 502);
  const study = await res.json();
  if (study.hasResults) throw new Refused("This trial has already posted results on the registry, so a forecast would not count.", 409);
  const input = forecastInput(study.protocolSection, true);
  const day = today();
  let cost = 0;

  say({ step: "research" });
  const research = await ask(env, {
    model: RESEARCH_MODEL,
    max_tokens: 16000,
    reasoning: { effort: "medium" },
    plugins: [{ id: "web", engine: "native", max_results: 5 }],
    messages: [{ role: "system", content: researchSystem(day) }, { role: "user", content: input }],
  });
  cost += research.cost;
  const brief = (research.message?.content ?? "").trim();
  if (!brief) throw new Error("empty brief");
  // Sources are the links the search tool reported plus any written into the brief.
  const sources = [
    ...new Set([
      ...(research.message?.annotations ?? []).map((a) => a.url_citation?.url).filter(Boolean),
      ...[...brief.matchAll(/\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))+)\)/g)].map((m) => m[1]),
    ]),
  ];
  const report = { nct, method: METHOD, brief, sources, researchModel: research.model };

  if (resultIsPublic(brief)) {
    // The search found the trial's own result. That is worth knowing, but a
    // forecast made now would not be a forecast.
    Object.assign(report, { status: "public", madeAt: new Date().toISOString() });
  } else {
    say({ step: "forecast" });
    const answer = await ask(env, {
      model: FORECAST_MODEL,
      max_tokens: 3000,
      reasoning: { effort: "high" },
      response_format: { type: "json_schema", json_schema: { name: "forecast", strict: true, schema: FORECAST_SCHEMA } },
      messages: [{ role: "system", content: forecastLiveSystem(day) }, { role: "user", content: `${input}\n\nEvidence brief:\n${brief}` }],
    });
    cost += answer.cost;
    const f = JSON.parse(answer.message?.content ?? "");
    if (!(typeof f.probability === "number" && f.probability >= 0 && f.probability <= 1) || typeof f.recalls_result !== "boolean") throw new Error("forecast failed its checks");
    Object.assign(report, {
      status: f.recalls_result ? "public" : "forecast",
      probability: f.probability,
      rationale: f.rationale,
      model: answer.model,
      madeAt: new Date().toISOString(),
    });
    say({ step: "seal" });
    report.sealedText = leafText(report);
    const digest = await sha256(report.sealedText);
    report.leaf = hex(digest);
    const stamped = await stamp(digest);
    if (stamped) Object.assign(report, stamped);
  }
  report.cost = Math.round(cost * 1e4) / 1e4;
  return report;
}

// Take a request for a report: check it is allowed, then stream progress
// while the work runs. Every refusal says why in plain words.
export async function commission(request, env, ctx) {
  if (!env.OPENROUTER_KEY) throw new Refused("Reports on request are not switched on.", 503);
  const origin = request.headers.get("origin");
  if (origin && new URL(origin).host !== new URL(request.url).host) throw new Refused("Requests must come from this site.", 403);
  const body = await request.json().catch(() => ({}));
  const nct = String(body.nct ?? "").toUpperCase();
  if (!/^NCT\d{8}$/.test(nct)) throw new Refused("That is not a trial number.");

  const list = await (await env.ASSETS.fetch(new URL("/watchlist.json", request.url))).json();
  const trial = list.find((t) => t.nct === nct);
  if (!trial) throw new Refused("That trial is not in the sealed record.", 404);
  if (trial.state !== "unscreened" || trial.inLedger) throw new Refused("That trial already has an evidence-backed forecast or a result.", 409);
  if (await env.REPORTS.get(`report:${nct}`)) throw new Refused("That trial already has a report.", 409);
  if (await env.REPORTS.get(`lock:${nct}`)) throw new Refused("A report on that trial is being written right now. Check back in a few minutes.", 409);

  // How this one is paid for.
  let paid = null;
  const day = today();
  const visitor = hex(await sha256(`${day} ${request.headers.get("cf-connecting-ip") ?? "local"} ${env.SESSION_SECRET ?? ""}`)).slice(0, 24);
  if (body.tx) {
    const token = await tokenInfo(env);
    if (!token) throw new Refused("There is no token to pay with.", 404);
    const wallet = await signedInAs(env, request);
    if (!wallet) throw new Refused("Sign in with the wallet that made the burn.", 401);
    const tx = String(body.tx).toLowerCase();
    if (await env.REPORTS.get(`tx:${tx}`)) throw new Refused("That burn has already paid for a report.", 409);
    await burned(env, token, tx, wallet);
    paid = { tx, wallet, amount: token.reportPrice, symbol: token.symbol };
    await env.REPORTS.put(`tx:${tx}`, `pending ${nct}`, { expirationTtl: 900 });
  } else {
    const used = Number((await env.REPORTS.get(`day:${day}`)) ?? 0);
    if (used >= freePerDay(env)) throw new Refused("Today's free reports have been used. The count resets at midnight UTC.", 429);
    if (await env.REPORTS.get(`visitor:${visitor}`)) throw new Refused("One free report per visitor per day. Come back tomorrow.", 429);
    await Promise.all([
      env.REPORTS.put(`day:${day}`, String(used + 1), { expirationTtl: 3 * 86400 }),
      env.REPORTS.put(`visitor:${visitor}`, nct, { expirationTtl: 86400 }),
    ]);
  }
  await env.REPORTS.put(`lock:${nct}`, "1", { expirationTtl: 900 });

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const say = (o) => writer.write(enc.encode(JSON.stringify(o) + "\n")).catch(() => {});
  // A line every few seconds keeps the connection open through the search.
  const pulse = setInterval(() => say({ wait: true }), 10_000);
  const work = (async () => {
    let spent = false;
    try {
      const report = await make(env, nct, (o) => {
        if (o.step === "forecast" || o.step === "seal") spent = true;
        say(o);
      });
      spent = true;
      if (paid) report.paid = paid;
      const { status, probability = null, madeAt, leaf = null, sources } = report;
      await env.REPORTS.put(`report:${nct}`, JSON.stringify(report), {
        metadata: { status, probability, madeAt, leaf, sources: sources.length, paid: !!paid, stamped: !!report.proof },
      });
      if (paid) await env.REPORTS.put(`tx:${paid.tx}`, nct);
      await say({ done: true, report: shown(report) });
    } catch (e) {
      // Nothing was produced. A free request that never reached a paid step
      // goes back into today's allowance; a burn can be used again.
      if (paid) await env.REPORTS.delete(`tx:${paid.tx}`);
      else if (!spent) {
        const used = Number((await env.REPORTS.get(`day:${day}`)) ?? 1);
        await Promise.all([
          env.REPORTS.put(`day:${day}`, String(Math.max(0, used - 1)), { expirationTtl: 3 * 86400 }),
          env.REPORTS.delete(`visitor:${visitor}`),
        ]);
      }
      console.error("report failed", nct, e?.message);
      await say({ error: e instanceof Refused ? e.message : "The report could not be finished. Nothing was published; you can try again." });
    } finally {
      clearInterval(pulse);
      await env.REPORTS.delete(`lock:${nct}`);
      await writer.close().catch(() => {});
    }
  })();
  ctx.waitUntil(work);
  return new Response(readable, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
}
