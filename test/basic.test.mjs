// Run with: npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { resultIsPublic } from "../src/briefs.mjs";
import { leafText } from "../src/record.mjs";
import { signIn, signInText, signedInAs } from "../src/token.mjs";
import { cleanPath } from "../src/worker.mjs";

const hex = (b) => Buffer.from(b).toString("hex");

test("the sealed text of a forecast never changes shape", () => {
  const f = { rationale: "ignored", nct: "NCT00000001", madeAt: "2026-01-01T00:00:00.000Z", model: "m", probability: 0.5, method: "live" };
  assert.equal(leafText(f), '{"nct":"NCT00000001","method":"live","probability":0.5,"model":"m","madeAt":"2026-01-01T00:00:00.000Z"}');
});

test("a brief's status line decides whether the result is out", () => {
  assert.equal(resultIsPublic("RESULT STATUS: PUBLIC\nMet its endpoint."), true);
  assert.equal(resultIsPublic("RESULT STATUS: NOT PUBLIC\nNothing found."), false);
  assert.equal(resultIsPublic("**RESULT ALREADY PUBLIC:** No. Nothing found."), false);
});

test("no spelling of the held folder gets past the worker", () => {
  for (const p of ["/early/a.json", "/%65arly/a.json", "/early%2Fa.json", "//early/a.json", "/EARLY/a.json", "/early/./a.json", "/%2565arly/a.json", "/early%5Ca.json"]) {
    assert.ok(cleanPath(p).includes("/early/"), p);
  }
  assert.equal(cleanPath("/how.html"), "/how.html");
});

test("wallet sign-in accepts the wallet's own signature and nothing else", async () => {
  const env = { SESSION_SECRET: "test-secret" };
  const key = crypto.getRandomValues(new Uint8Array(32));
  const address = "0x" + hex(keccak_256(secp256k1.getPublicKey(key, false).slice(1)).slice(12));
  const expires = new Date(Date.now() + 3_600_000).toISOString();
  const sign = (k, text) => {
    const body = Buffer.from(text);
    const digest = keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${body.length}`), body]));
    const sig = secp256k1.sign(digest, k, { prehash: false, format: "recovered" });
    return "0x" + hex(sig.slice(1)) + (27 + sig[0]).toString(16);
  };
  const session = await signIn(env, { address, expires, signature: sign(key, signInText(address, expires)) });
  assert.equal(session.address, address);
  const request = (pass) => new Request("https://brierlab.com/api/me", { headers: { authorization: `Bearer ${pass}` } });
  assert.equal(await signedInAs(env, request(session.pass)), address);
  assert.equal(await signedInAs(env, request(session.pass.slice(0, -1) + (session.pass.endsWith("0") ? "1" : "0"))), null);
  const other = crypto.getRandomValues(new Uint8Array(32));
  await assert.rejects(signIn(env, { address, expires, signature: sign(other, signInText(address, expires)) }), /not made by this wallet/);
  const late = new Date(Date.now() - 1000).toISOString();
  await assert.rejects(signIn(env, { address, expires: late, signature: sign(key, signInText(address, late)) }), /expired/);
});
