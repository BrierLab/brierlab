// Switch the token on. Run once, the moment the token exists:
//   node src/launch.mjs <token address> [report price] [holding amount]
// It reads the token from the chain, refuses anything that does not look like
// a plain token on the expected chain, writes the token settings into
// wrangler.jsonc, opens the holders-first window on every held batch, builds
// the site, deploys, and then checks what the live site serves.
// Add --dry to stop before anything is written or deployed.
// Needs RPC_URL in the environment or in ~/.config/readout/rpc_url, and the
// worker must already have its own RPC_URL secret.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const CHAIN_ID = 4663;
const SITE = "https://brierlab.com";
const BURN = "0x000000000000000000000000000000000000dead";
const args = process.argv.slice(2).filter((a) => a !== "--dry");
const dry = process.argv.includes("--dry");
const [address, priceArg, holdArg] = args;
const stop = (why) => {
  console.error(`STOP: ${why}`);
  process.exit(1);
};
if (!/^0x[0-9a-fA-F]{40}$/.test(address ?? "")) stop("usage: node src/launch.mjs <token address> [report price] [holding amount] [--dry]");

const rpcUrl = process.env.RPC_URL ?? readFileSync(`${homedir()}/.config/readout/rpc_url`, "utf8").trim();
async function rpc(method, params) {
  const res = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}
const call = (data) => rpc("eth_call", [{ to: address, data }, "latest"]);
const text = (hex) => {
  const raw = Buffer.from(hex.slice(2), "hex");
  return raw.subarray(64, 64 + Number(BigInt("0x" + raw.subarray(32, 64).toString("hex")))).toString("utf8");
};

// 1. The token, as the chain describes it.
const chain = Number(await rpc("eth_chainId", []));
if (chain !== CHAIN_ID && !process.env.ALLOW_CHAIN) stop(`the RPC is on chain ${chain}, expected ${CHAIN_ID}`);
if ((await rpc("eth_getCode", [address, "latest"])) === "0x") stop("there is no contract at that address");
const decimals = Number(BigInt(await call("0x313ce567")));
const symbol = text(await call("0x95d89b41"));
const name = text(await call("0x06fdde03"));
const supply = BigInt(await call("0x18160ddd")) / 10n ** BigInt(decimals);
if (!symbol || supply <= 0n) stop("the contract does not answer like a token");
// A burn is a plain transfer to the burn address; check the token allows one.
const probe = await rpc("eth_call", [{ from: BURN, to: address, data: "0xa9059cbb" + BURN.slice(2).padStart(64, "0") + "0".repeat(64) }, "latest"]).catch((e) => e);
if (probe instanceof Error) stop(`a zero-value transfer to the burn address reverts (${probe.message}); burning may not work on this token`);

// 2. Prices. Unless given, a report costs 1/100,000 of supply and early
// access needs 1/1,000 of supply.
const price = Number(priceArg ?? supply / 100_000n);
const hold = Number(holdArg ?? supply / 1_000n);
if (!(price > 0) || !(hold > 0)) stop("the report price and holding amount must be above zero");
console.log(`token   ${name} (${symbol}) at ${address} on chain ${chain}`);
console.log(`supply  ${supply.toLocaleString()} ${symbol}, ${decimals} decimals`);
console.log(`report  burn ${price.toLocaleString()} ${symbol}`);
console.log(`early   hold ${hold.toLocaleString()} ${symbol}`);
const held = existsSync("data/held") ? readdirSync("data/held").filter((d) => existsSync(`data/held/${d}/seal.json`) && !existsSync(`data/held/${d}/window.json`)) : [];
console.log(`batches to open for holders first: ${held.join(", ") || "none"}`);
const vars = { DAILY_FREE: "3", TOKEN_ADDRESS: address, TOKEN_CHAIN_ID: String(chain), REPORT_PRICE: String(price), HOLD_MIN: String(hold) };
if (dry) {
  console.log("\ndry run: nothing written, nothing deployed. Settings that would be used:");
  for (const [k, v] of Object.entries(vars)) if (k !== "DAILY_FREE") console.log(`${k}=${v}`);
  process.exit(0);
}

// 3. Settings, window, build, deploy.
const run = (cmd, a) => execFileSync(cmd, a, { stdio: "inherit" });
const config = readFileSync("wrangler.jsonc", "utf8");
const line = /"vars": \{[^}]*\},/;
if (!line.test(config)) stop("could not find the vars line in wrangler.jsonc");
if (!execFileSync("npx", ["-y", "wrangler@latest", "secret", "list"]).toString().includes("RPC_URL")) stop("the worker has no RPC_URL secret yet; set it first");
writeFileSync("wrangler.jsonc", config.replace(line, `"vars": ${JSON.stringify(vars)},`));
for (const b of held) run("node", ["src/early.mjs", "open", b, "7"]);
run("node", ["src/site.mjs", "live-2026-11-22"]);
run("npx", ["-y", "wrangler@latest", "deploy"]);

// 4. What a stranger is now served.
let live = null;
for (let i = 0; i < 20 && !live?.token; i++) {
  live = await (await fetch(`${SITE}/api/reports?launch=${Date.now()}`)).json().catch(() => null);
  if (!live?.token) await new Promise((r) => setTimeout(r, 3000));
}
if (!live?.token) stop("deployed, but the live site does not report a token. Check the worker's RPC_URL secret.");
if (live.token.address !== address.toLowerCase() || live.token.symbol !== symbol) stop(`the live site reports a different token: ${JSON.stringify(live.token)}`);
const allowed = new Set([address.toLowerCase(), BURN]);
const strays = new Set();
for (const path of ["/", "/how", "/data.js", "/api/reports", "/early.json"]) {
  const body = await (await fetch(`${SITE}${path}?launch=${Date.now()}`)).text();
  for (const m of body.matchAll(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g)) if (!allowed.has(m[0].toLowerCase())) strays.add(`${path}: ${m[0]}`);
}
if (strays.size) stop(`the live site names another address:\n  ${[...strays].join("\n  ")}`);
const early = await (await fetch(`${SITE}/early.json?launch=${Date.now()}`)).json().catch(() => []);
console.log(`\nLIVE: ${symbol} is switched on at ${SITE}. Report price ${price.toLocaleString()}, holding amount ${hold.toLocaleString()}, ${early.length} batch(es) open to holders first.`);
