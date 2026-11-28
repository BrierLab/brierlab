// Serves the static site. Sends http and www visitors to https://brierlab.com
// so there is one address for every page. Also answers /api/watch: a live
// check of every sealed trial against the public registry; /api/report and
// /api/reports: evidence reports made on request (src/ondemand.mjs); and the
// wallet routes, which stay off until a token address is set (src/token.mjs).
import { commission, getReport, listReports } from "./ondemand.mjs";
import { Refused, holds, signIn, signInText, signedInAs, tokenInfo } from "./token.mjs";

const REGISTRY = "https://clinicaltrials.gov/api/v2/studies";
const HOURS = 6;

// Ask the registry what has changed since sealing. watchlist.json (written by
// src/site.mjs) holds each sealed trial's status and finish date at sealing
// and whether its outcome is already in our ledger.
async function watch(request, env) {
  const list = await (await env.ASSETS.fetch(new URL("/watchlist.json", request.url))).json();
  const was = new Map(list.map((t) => [t.nct, t]));
  const ids = [...was.keys()];
  const pages = await Promise.all(
    Array.from({ length: Math.ceil(ids.length / 100) }, async (_, i) => {
      const url = new URL(REGISTRY);
      url.searchParams.set("filter.ids", ids.slice(i * 100, i * 100 + 100).join(","));
      url.searchParams.set("fields", "protocolSection.identificationModule.nctId,protocolSection.statusModule,hasResults");
      url.searchParams.set("pageSize", "100");
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`registry ${res.status}`);
      return (await res.json()).studies ?? [];
    }),
  );
  const today = new Date().toISOString().slice(0, 10);
  const out = { checkedAt: new Date().toISOString(), trials: ids.length, checked: 0, resultsPosted: [], stopped: [], pastFinish: 0, unread: 0 };
  for (const s of pages.flat()) {
    const nct = s.protocolSection.identificationModule.nctId;
    const st = s.protocolSection.statusModule ?? {};
    const before = was.get(nct);
    if (!before) continue;
    out.checked++;
    const finish = st.primaryCompletionDateStruct?.date;
    const stopped = ["TERMINATED", "WITHDRAWN", "SUSPENDED"].includes(st.overallStatus) && st.overallStatus !== before.status;
    if (s.hasResults) out.resultsPosted.push(nct);
    if (stopped) out.stopped.push({ nct, status: st.overallStatus, why: (st.whyStopped ?? "").slice(0, 200) });
    if (finish && (finish.length === 7 ? `${finish}-28` : finish) <= today) out.pastFinish++;
    // Something the registry now shows that our ledger has not recorded yet.
    if ((s.hasResults || stopped) && !before.inLedger) out.unread++;
  }
  return out;
}

const fresh = { headers: { "cache-control": "no-store" } };

async function routes(request, env, ctx, url) {
  const path = url.pathname;
  const get = request.method === "GET";
  if (path === "/api/reports" && get) return Response.json(await listReports(env), fresh);
  if (path === "/api/report" && request.method === "POST") return commission(request, env, ctx);
  const one = path.match(/^\/api\/report\/(NCT\d{8})(?:\.(txt|ots))?$/);
  if (one && get) return getReport(env, one[1], one[2]);

  // Wallet routes. With no token set they answer 404 like any unknown path.
  const token = path === "/api/signin" || path === "/api/session" || path === "/api/me" || path.startsWith("/early/") ? await tokenInfo(env) : null;
  if (path === "/api/signin" && request.method === "POST" && token) {
    const address = String((await request.json().catch(() => ({}))).address ?? "");
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Refused("That is not a wallet address.");
    const expires = new Date(Date.now() + 24 * 3_600_000).toISOString();
    return Response.json({ address: address.toLowerCase(), expires, text: signInText(address, expires) }, fresh);
  }
  if (path === "/api/session" && request.method === "POST" && token) return Response.json(await signIn(env, await request.json().catch(() => ({}))), fresh);
  if (path === "/api/me" && get && token) {
    const address = await signedInAs(env, request);
    if (!address) throw new Refused("Sign in with a wallet first.", 401);
    return Response.json({ address, ...(await holds(env, token, address)) }, fresh);
  }

  // Forecast batches in their holders-first window. early.json (written by
  // src/early.mjs) says when each batch opens to everyone. Before that the
  // file is served only to a signed-in wallet holding enough of the token.
  if (path.startsWith("/early/") && get) {
    const list = await env.ASSETS.fetch(new URL("/early.json", url)).then((r) => (r.ok ? r.json() : [])).catch(() => []);
    const batch = list.find((b) => `/early/${b.name}.json` === path);
    if (!batch) return null;
    if (Date.parse(batch.opensAt) > Date.now()) {
      const address = token && (await signedInAs(env, request));
      if (!address) throw new Refused("This batch is open to token holders first. Sign in with a wallet to read it now.", 401);
      if (!(await holds(env, token, address)).holder) throw new Refused(`Reading this batch early needs ${token.holdMin} ${token.symbol} in the signed-in wallet.`, 403);
    }
    const file = await env.ASSETS.fetch(new URL(path, url));
    return new Response(file.body, { status: file.status, headers: { "content-type": "application/json", "cache-control": "private, no-store" } });
  }
  return null;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // A copy running on a developer's own machine (LOCAL=1 in .dev.vars) is left alone.
    const local = env.LOCAL === "1";
    if (!local && (url.protocol === "http:" || url.hostname === "www.brierlab.com")) {
      url.protocol = "https:";
      url.hostname = "brierlab.com";
      return Response.redirect(url.toString(), 301);
    }
    if (url.pathname === "/api/watch") {
      const key = new Request(new URL("/api/watch", url).toString());
      const hit = await caches.default.match(key);
      if (hit) return hit;
      try {
        const res = Response.json(await watch(request, env), { headers: { "cache-control": `public, max-age=600, s-maxage=${HOURS * 3600}` } });
        ctx.waitUntil(caches.default.put(key, res.clone()));
        return res;
      } catch (e) {
        return Response.json({ error: "The registry did not answer. The page shows our last saved check instead." }, { status: 502, headers: { "cache-control": "no-store" } });
      }
    }
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/early/")) {
      try {
        return (await routes(request, env, ctx, url)) ?? Response.json({ error: "Nothing here." }, { status: 404 });
      } catch (e) {
        if (e instanceof Refused) return Response.json({ error: e.message }, { status: e.status, headers: { "cache-control": "no-store" } });
        console.error(url.pathname, e?.message);
        return Response.json({ error: "Something went wrong on our side. Try again in a minute." }, { status: 500, headers: { "cache-control": "no-store" } });
      }
    }
    return env.ASSETS.fetch(request);
  },
};
