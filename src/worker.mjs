// Serves the static site. Sends http and www visitors to https://brierlab.com
// so there is one address for every page. Also answers /api/watch: a live
// check of every sealed trial against the public registry.
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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.protocol === "http:" || url.hostname === "www.brierlab.com") {
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
    return env.ASSETS.fetch(request);
  },
};
