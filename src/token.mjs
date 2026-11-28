// Token checks for the site's worker. Everything here is off until
// TOKEN_ADDRESS is set: with no address there is no token, and the site shows
// nothing about one. With an address set it answers three questions from the
// chain itself: does this visitor control this wallet, how many tokens does
// the wallet hold, and did this transaction burn the price of a report.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

export const BURN = "0x000000000000000000000000000000000000dead";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const SIGN_IN_HOURS = 24;
const enc = new TextEncoder();
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (s) => Uint8Array.from(s.replace(/^0x/, "").match(/../g) ?? [], (b) => parseInt(b, 16));
const isAddress = (s) => typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);

export class Refused extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

async function rpc(env, method, params) {
  const res = await fetch(env.RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = res.ok ? await res.json() : null;
  if (!body || body.error) throw new Error(`chain ${method} failed`);
  return body.result;
}

const call = (env, data) => rpc(env, "eth_call", [{ to: env.TOKEN_ADDRESS, data }, "latest"]);

// What the site needs to know about the token, or null when there is none.
// Name and decimals are read from the token contract once and kept.
export async function tokenInfo(env) {
  if (!isAddress(env.TOKEN_ADDRESS) || !env.RPC_URL) return null;
  const address = env.TOKEN_ADDRESS.toLowerCase();
  let meta = await env.REPORTS.get(`token:${address}`, "json");
  if (!meta) {
    const [dec, sym] = await Promise.all([call(env, "0x313ce567"), call(env, "0x95d89b41")]);
    const raw = unhex(sym);
    // symbol() returns a string: offset, length, then the bytes.
    const len = Number(BigInt("0x" + hex(raw.slice(32, 64))));
    meta = { decimals: Number(BigInt(dec)), symbol: new TextDecoder().decode(raw.slice(64, 64 + len)) };
    await env.REPORTS.put(`token:${address}`, JSON.stringify(meta));
  }
  return {
    address,
    chainId: Number(env.TOKEN_CHAIN_ID),
    symbol: meta.symbol,
    decimals: meta.decimals,
    reportPrice: Number(env.REPORT_PRICE),
    holdMin: Number(env.HOLD_MIN),
    burn: BURN,
  };
}

const units = (whole, decimals) => BigInt(Math.round(whole * 1e6)) * 10n ** BigInt(decimals) / 1_000_000n;

export async function balanceOf(env, address) {
  return BigInt(await call(env, "0x70a08231" + address.slice(2).toLowerCase().padStart(64, "0")));
}

// The words a wallet signs to sign in. Signing sends nothing to the chain.
export const signInText = (address, expires) =>
  `brierlab.com asks you to sign in with your wallet.\n\nWallet: ${address.toLowerCase()}\nExpires: ${expires}\n\nSigning is free and sends no transaction.`;

// Which address produced this signature over this text (the wallet standard
// for signed messages: a fixed prefix, the length, then the text).
function signer(text, signature) {
  const body = enc.encode(text);
  const prefix = enc.encode(`\x19Ethereum Signed Message:\n${body.length}`);
  const digest = keccak_256(Uint8Array.from([...prefix, ...body]));
  const sig = unhex(signature);
  if (sig.length !== 65) throw new Refused("That signature is not the right length.");
  const recovery = sig[64] >= 27 ? sig[64] - 27 : sig[64];
  const key = secp256k1.Signature.fromBytes(sig.slice(0, 64), "compact")
    .addRecoveryBit(recovery)
    .recoverPublicKey(digest)
    .toBytes(false);
  return "0x" + hex(keccak_256(key.slice(1)).slice(12));
}

async function mac(env, text) {
  const key = await crypto.subtle.importKey("raw", enc.encode(env.SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(text))));
}

// Trade a signed sign-in text for a pass the browser sends with later requests.
export async function signIn(env, { address, expires, signature }) {
  if (!env.SESSION_SECRET) throw new Refused("Wallet sign-in is not switched on.", 404);
  if (!isAddress(address) || typeof expires !== "string" || typeof signature !== "string") throw new Refused("Sign-in needs a wallet address, an expiry and a signature.");
  const until = Date.parse(expires);
  if (!(until > Date.now()) || until > Date.now() + (SIGN_IN_HOURS + 1) * 3_600_000) throw new Refused("That sign-in has expired. Sign in again.");
  let who;
  try {
    who = signer(signInText(address, expires), signature);
  } catch (e) {
    if (e instanceof Refused) throw e;
    throw new Refused("That signature could not be read.");
  }
  if (who !== address.toLowerCase()) throw new Refused("That signature was not made by this wallet.", 401);
  const pass = `${who}.${until}`;
  return { pass: `${pass}.${await mac(env, pass)}`, address: who, expires };
}

// The wallet a request is signed in as, or null.
export async function signedInAs(env, request) {
  const pass = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const [address, until, sum] = pass.split(".");
  if (!env.SESSION_SECRET || !isAddress(address) || !sum || !(Number(until) > Date.now())) return null;
  return (await mac(env, `${address}.${until}`)) === sum ? address : null;
}

export async function holds(env, token, address) {
  const balance = await balanceOf(env, address);
  return { balance: Number(balance / 10n ** BigInt(Math.max(0, token.decimals - 4))) / 1e4, holder: balance >= units(token.holdMin, token.decimals) };
}

// Did this transaction burn the price of one report from this wallet? The
// chain's own receipt decides: a successful transaction with a transfer of
// the token from the wallet to the burn address, for at least the price.
export async function burned(env, token, tx, from) {
  if (typeof tx !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(tx)) throw new Refused("That is not a transaction hash.");
  const receipt = await rpc(env, "eth_getTransactionReceipt", [tx]);
  if (!receipt) throw new Refused("The chain has not confirmed that transaction yet. Try again in a few seconds.", 425);
  if (receipt.status !== "0x1") throw new Refused("That transaction failed on the chain, so nothing was burned.");
  const topic = (a) => "0x" + a.slice(2).toLowerCase().padStart(64, "0");
  const need = units(token.reportPrice, token.decimals);
  const ok = (receipt.logs ?? []).some(
    (l) =>
      l.address.toLowerCase() === token.address &&
      l.topics?.[0] === TRANSFER &&
      l.topics[1] === topic(from) &&
      l.topics[2] === topic(BURN) &&
      BigInt(l.data) >= need,
  );
  if (!ok) throw new Refused(`That transaction did not burn ${token.reportPrice} ${token.symbol} from the signed-in wallet.`);
  return true;
}
