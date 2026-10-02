// The gate (POST /api/voters) and the signed voter token.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import * as likes from "../functions/api/likes.js";
import * as me from "../functions/api/me.js";
import * as voters from "../functions/api/voters.js";
import { LIMITS } from "../functions/_lib/config.js";
import { signVoterToken, verifyVoterToken } from "../functions/_lib/token.js";
import { SECRET, acceptedBeforeLimit, addTrack, call, freshIp, makeEnv, signUp } from "./helpers.mjs";

let env, dispose;
before(async () => { ({ env, dispose } = await makeEnv()); await addTrack(env, "brian"); });
after(() => dispose());
const post = (body, ip = freshIp()) => call(voters.onRequest, env, { method: "POST", path: "/api/voters", body, ip });

test("name, email and city are all required, and the answer says which", async () => {
  for (const missing of ["name", "email", "city"]) {
    const body = { name: "Jane Doe", email: "jane.required@example.com", city: "Atlanta" };
    body[missing] = "   ";
    const res = await post(body);
    assert.equal(res.status, 400, missing);
    assert.ok(res.body.fields[missing], `fields.${missing} explains itself`);
  }
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM voters").first()).n, 0, "nothing was saved");
});

test("email format is checked", async () => {
  for (const email of ["nope", "a@b", "a b@example.com", "@example.com", "jane@", "jane@example", "jane@@example.com"]) {
    const res = await post({ name: "Jane", email, city: "Atlanta" });
    assert.equal(res.status, 400, email);
    assert.equal(res.body.error, "invalid_fields");
  }
});

test("email is lowercased and trimmed before saving; name and city are trimmed", async () => {
  await post({ name: "  Jane   Doe ", email: "  Jane.Trim@Example.COM  ", city: "  Atlanta " });
  const row = await env.DB.prepare("SELECT name, email, city, marketing_opt_in, flagged FROM voters WHERE email = 'jane.trim@example.com'").first();
  assert.deepEqual(row, { name: "Jane Doe", email: "jane.trim@example.com", city: "Atlanta", marketing_opt_in: 0, flagged: 0 });
});

test("marketing opt-in is off unless the box was ticked, and is stored", async () => {
  await post({ name: "No Tick", email: "notick@example.com", city: "X" });
  await post({ name: "Ticked", email: "ticked@example.com", city: "X", marketing_opt_in: true });
  await post({ name: "Stringy", email: "stringy@example.com", city: "X", marketing_opt_in: "true" });
  const rows = (await env.DB.prepare("SELECT email, marketing_opt_in AS o FROM voters WHERE email IN ('notick@example.com','ticked@example.com','stringy@example.com') ORDER BY email").all()).results;
  assert.deepEqual(rows, [{ email: "notick@example.com", o: 0 }, { email: "stringy@example.com", o: 0 }, { email: "ticked@example.com", o: 1 }]);
});

test("a filled honeypot is rejected and saves nothing", async () => {
  const res = await post({ name: "Bot", email: "bot@example.com", city: "X", website: "http://spam.example" });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "rejected");
  assert.equal(await env.DB.prepare("SELECT id FROM voters WHERE email = 'bot@example.com'").first(), null);
});

test("throwaway inboxes cannot sign up (including subdomains)", async () => {
  for (const email of ["x@mailinator.com", "x@sub.mailinator.com", "x@yopmail.com", "x@guerrillamail.com"]) {
    const res = await post({ name: "Temp", email, city: "X" });
    assert.equal(res.status, 400, email);
    assert.equal(res.body.error, "throwaway_email");
  }
});

test("the same email again is the same voter — one account per email", async () => {
  const a = await signUp(env, voters, { email: "same@example.com", name: "First Time" });
  const b = await signUp(env, voters, { email: "  SAME@example.com ", name: "Someone Else", city: "Elsewhere" });
  assert.equal(await verifyVoterToken(env, a.token), await verifyVoterToken(env, b.token));
  assert.equal(a.returning, false);
  assert.equal(b.returning, true);
  assert.equal(b.voter.first_name, "First", "the first sign-up's name stays on file");
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM voters WHERE email = 'same@example.com'").first()).n, 1);
});

test("+tags and Gmail dots do not make a second voter", async () => {
  const a = await signUp(env, voters, { email: "jane.doe@gmail.com" });
  const b = await signUp(env, voters, { email: "janedoe+vote2@gmail.com" });
  const c = await signUp(env, voters, { email: "j.a.n.e.doe@googlemail.com" });
  const ids = await Promise.all([a, b, c].map((r) => verifyVoterToken(env, r.token)));
  assert.equal(new Set(ids).size, 1);
});

test("a returning voter gets their likes back", async () => {
  const a = await signUp(env, voters, { email: "returning@example.com" });
  await call(likes.onRequest, env, { method: "POST", path: "/api/likes", token: a.token, body: { track: "brian" } });
  const again = await signUp(env, voters, { email: "returning@example.com" });
  assert.deepEqual(again.liked, ["brian"]);
  const mine = await call(me.onRequest, env, { path: "/api/me", token: again.token });
  assert.deepEqual(mine.body, { voter: { first_name: "Jane" }, liked: ["brian"] });
});

test("a voter cannot be spoofed: forged, tampered and foreign-secret tokens are all refused", async () => {
  const victim = await signUp(env, voters, { email: "victim@example.com" });
  const victimId = await verifyVoterToken(env, victim.token);
  const attacker = await signUp(env, voters, { email: "attacker@example.com" });
  const attackerSig = attacker.token.split(".")[2];
  const forged = [
    `v1.${victimId}.${attackerSig}`,                                  // someone else's signature on the victim's id
    `v1.${victimId}.${"A".repeat(43)}`,                               // made-up signature
    await signVoterToken({ VOTER_TOKEN_SECRET: "another-secret" }, victimId), // signed with the wrong secret
    `v1.${victimId}`, "victim@example.com", "", "v2.1.x",
  ];
  for (const token of forged) {
    assert.equal(await verifyVoterToken(env, token), null, token);
    const res = await call(likes.onRequest, env, { method: "POST", path: "/api/likes", token, body: { track: "brian" } });
    assert.equal(res.status, 401, token);
    assert.equal(res.body.error, "invalid_token");
  }
  // An email in the body is not an identity: no token, no like.
  const res = await call(likes.onRequest, env, { method: "POST", path: "/api/likes", body: { track: "brian", email: "victim@example.com" } });
  assert.equal(res.status, 401);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM like_events WHERE voter_id = ?1").bind(victimId).first()).n, 0);
  assert.equal(await verifyVoterToken(env, victim.token), victimId, "the real token still works");
});

test("a token for a voter whose row is gone is refused", async () => {
  const ghost = await signVoterToken(env, 999999);
  const res = await call(likes.onRequest, env, { method: "POST", path: "/api/likes", token: ghost, body: { track: "brian" } });
  assert.equal(res.status, 401);
  assert.equal((await call(me.onRequest, env, { path: "/api/me", token: ghost })).status, 401);
});

test("no signing secret is a named 503, never a silent success", async () => {
  const bare = { ...env, VOTER_TOKEN_SECRET: undefined };
  const res = await call(voters.onRequest, bare, { method: "POST", path: "/api/voters", body: { name: "A", email: "nosecret@example.com", city: "B" } });
  assert.equal(res.status, 503);
  assert.equal(res.body.error, "token_secret_missing");
  assert.equal(await env.DB.prepare("SELECT id FROM voters WHERE email = 'nosecret@example.com'").first(), null);
  assert.equal(SECRET.length > 0, true);
});

test("sign-ups are rate limited per IP and per email", async () => {
  const ip = "192.0.2.50";
  const perIp = await acceptedBeforeLimit((i) => post({ name: "Flood", email: `flood${i}@example.com`, city: "X" }, ip), LIMITS.gatePerIp.max);
  assert.ok(perIp >= LIMITS.gatePerIp.max && perIp <= 2 * LIMITS.gatePerIp.max, `limited after ${perIp}`);
  const perEmail = await acceptedBeforeLimit(() => post({ name: "Again", email: "again@example.com", city: "X" }), LIMITS.gatePerEmail.max);
  assert.ok(perEmail >= LIMITS.gatePerEmail.max && perEmail <= 2 * LIMITS.gatePerEmail.max, `the same email from many IPs is limited too (after ${perEmail})`);
});

test("only POST is accepted, and junk bodies are a 400", async () => {
  assert.equal((await call(voters.onRequest, env, { path: "/api/voters" })).status, 405);
  assert.equal((await post("not json")).status, 400);
  assert.equal((await post("[1,2]")).status, 400);
});
