// THE GUARD for email verification: while it is on, no answer from any route carries a voter
// token for someone who has been sent a code and has not entered it (`pending`). Proven
// negatively once (2 Oct 2026): putting a token in the gate's code_sent answer fails this file.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import * as catchAll from "../functions/api/[[path]].js";
import * as comments from "../functions/api/comments.js";
import * as likes from "../functions/api/likes.js";
import * as me from "../functions/api/me.js";
import * as state from "../functions/api/state.js";
import * as voters from "../functions/api/voters.js";
import * as verify from "../functions/api/voters/verify.js";
import { VERIFICATION } from "../functions/_lib/config.js";
import { verifyVoterToken } from "../functions/_lib/token.js";
import { ROOT, addTrack, call, freshIp, makeEnv } from "./helpers.mjs";
import { TOKEN_RE, VERIFY_ENV, stubMail, wrongCode } from "./verify-helpers.mjs";

let env, dispose;
before(async () => { ({ env, dispose } = await makeEnv(VERIFY_ENV)); await addTrack(env, "brian"); });
after(() => dispose());

// Anything token-shaped, or any key named like one, anywhere in an answer: body or headers.
function tokensIn(res) {
  const found = [];
  const haystack = `${res.text}\n${JSON.stringify([...res.headers])}`;
  const m = TOKEN_RE.exec(haystack);
  if (m) found.push(m[0]);
  const walk = (v) => {
    if (!v || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v)) { if (/token/i.test(k) && x) found.push(`${k}=${x}`); walk(x); }
  };
  walk(res.body);
  return found;
}

test("GUARD: with verification on, no path returns a token for a voter who has not entered their code", async (t) => {
  const mail = stubMail(t);
  const reason = async (email) => (await env.DB.prepare("SELECT verified, unverified_reason FROM voters WHERE email_key = ?1").bind(email).first());
  const post = (handler, p, body) => call(handler, env, { method: "POST", path: p, body, ip: freshIp() });
  const gate = (email, extra = {}) => post(voters.onRequest, "/api/voters", { name: "Pat Pending", email, city: "Atlanta", ...extra });
  const check = (email, code) => post(verify.onRequest, "/api/voters/verify", { email, code });
  const age = (email, s) => env.DB.prepare("UPDATE email_sends SET sent_at = sent_at - ?2 WHERE voter_id = (SELECT id FROM voters WHERE email_key = ?1)").bind(email, s).run();

  let checkedPending = 0;
  // Every answer given while `email` is pending must be token-free.
  const mustBeTokenFree = async (email, what, res) => {
    const r = await reason(email);
    assert.deepEqual([r?.verified, r?.unverified_reason], [0, "pending"], `${what}: the voter is still pending`);
    assert.deepEqual(tokensIn(res), [], `${what}: a token reached a voter who has not entered their code (${res.status} ${res.text})`);
    checkedPending++;
  };

  const email = "pending.guard@example.com";
  await mustBeTokenFree(email, "the gate, first ask", await gate(email));
  const code = mail.sent.at(-1).code;
  await mustBeTokenFree(email, "the gate again inside the cooldown", await gate(email));
  await mustBeTokenFree(email, "the gate again with other details", await gate("Pending.Guard+2@example.com", { name: "Other", marketing_opt_in: true }));
  await mustBeTokenFree(email, "a malformed code", await check(email, "12 34"));
  await mustBeTokenFree(email, "a missing code", await post(verify.onRequest, "/api/voters/verify", { email }));
  await mustBeTokenFree(email, "a wrong code", await check(email, wrongCode(code)));
  await mustBeTokenFree(email, "the code check with another email", await check("someone.else@example.com", code));
  await age(email, 61);
  await mustBeTokenFree(email, "a resend after the cooldown", await gate(email));
  await age(email, 61);
  await mustBeTokenFree(email, "a third send", await gate(email));
  await age(email, 61);
  const capped = await gate(email);
  assert.equal(capped.body.error, "code_limit");
  await mustBeTokenFree(email, "the hourly cap", capped);
  const live = mail.sent.at(-1).code;
  for (let i = 1; i <= VERIFICATION.maxTries; i++) await mustBeTokenFree(email, `wrong try ${i}`, await check(email, wrongCode(live)));
  await mustBeTokenFree(email, "the right code after the tries ran out", await check(email, live));
  await mustBeTokenFree(email, "a resend inside the cooldown with a dead code", await gate(email));

  const expiring = "expiring.guard@example.com";
  await mustBeTokenFree(expiring, "the gate, first ask", await gate(expiring));
  await env.DB.prepare("UPDATE email_codes SET expires_at = 1 WHERE voter_id = (SELECT id FROM voters WHERE email_key = ?1)").bind(expiring).run();
  await mustBeTokenFree(expiring, "an expired code", await check(expiring, mail.sent.at(-1).code));

  // The routes a pending voter can reach without a token give none away either.
  for (const [what, res] of [
    ["GET /api/state", await call(state.onRequest, env, { path: "/api/state" })],
    ["GET /api/me with no token", await call(me.onRequest, env, { path: "/api/me" })],
    ["GET /api/me with the email as the token", await call(me.onRequest, env, { path: "/api/me", token: email })],
    ["POST /api/likes with the email in the body", await post(likes.onRequest, "/api/likes", { track: "brian", email, token: email })],
    ["POST /api/comments with the email in the body", await post(comments.onRequest, "/api/comments", { track: "brian", text: "hi", email })],
    ["GET /api/comments", await call(comments.onRequest, env, { path: "/api/comments?track=brian" })],
    ["an unknown route", await call(catchAll.onRequest, env, { path: "/api/voters/token" })],
  ]) await mustBeTokenFree(email, what, res);

  assert.ok(checkedPending >= 25, `only ${checkedPending} answers were checked`);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM like_events").first()).n, 0, "and nothing was voted");

  // The scanner is not blind: the right code DOES return a token, and that voter is not pending.
  const ok = "entered.guard@example.com";
  await gate(ok);
  const good = await check(ok, mail.sent.at(-1).code);
  assert.equal(tokensIn(good).length, 2, "the token is seen both by shape and by key");
  assert.equal((await reason(ok)).verified, 1);

  // And the reverse, for every answer that carries a token: its voter is never `pending`.
  await env.DB.prepare("DELETE FROM email_sends").run();
  mail.resend = () => new Response("{}", { status: 500 });
  for (const who of ["let.in.one@example.com", expiring]) {
    const res = await gate(who);
    assert.equal(res.body.verification, "skipped");
    const id = await verifyVoterToken(env, res.body.token);
    const r = await env.DB.prepare("SELECT email, unverified_reason FROM voters WHERE id = ?1").bind(id).first();
    assert.deepEqual([r.email, r.unverified_reason], [who, "mail_error"], "let in without a code: marked with why, no longer pending");
    await env.DB.prepare("DELETE FROM email_sends").run();
  }
});

test("GUARD: a gate token is made in one place, reached only by a correct code, a named skip, or the switch being off", () => {
  const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
  const sources = [];
  const walk = (dir) => { for (const f of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) { const p = `${dir}/${f.name}`; if (f.isDirectory()) walk(p); else if (f.name.endsWith(".js")) sources.push(p); } };
  walk("functions");
  assert.ok(sources.length >= 14, `read ${sources.length} files`);
  // signVoterToken with a real voter id appears once (openSession); the other calls are the
  // "is there a secret" probe, signVoterToken(env, 1), whose result is thrown away.
  const signs = sources.flatMap((p) => [...read(p).matchAll(/signVoterToken\(([^)]*)\)/g)].map((m) => `${p}: ${m[1]}`)).filter((s) => !/token\.js: env, voterId$/.test(s));
  assert.deepEqual(signs.sort(), ["functions/api/voters.js: env, 1", "functions/api/voters.js: env, voter.id", "functions/api/voters/verify.js: env, 1"]);
  assert.ok(!/=\s*await signVoterToken\(env, 1\)|return\s+(await\s+)?signVoterToken\(env, 1\)/.test(read("functions/api/voters.js") + read("functions/api/voters/verify.js")), "the probe's token is never used");
  const sessions = sources.flatMap((p) => [...read(p).matchAll(/^.*\bopenSession\(.*$/gm)].map((m) => `${p}: ${m[0].trim()}`)).filter((s) => !/export async function openSession/.test(s));
  assert.deepEqual(sessions.sort(), [
    "functions/api/voters.js: if (!verifying) return json(await openSession(env, voter, returning));",
    'functions/api/voters.js: return json({ ...(await openSession(env, voter, returning)), verification: "skipped", reason });',
    'functions/api/voters/verify.js: return json({ ...(await openSession(env, voter, returning)), verification: "verified" });',
  ]);
  // The skip refuses a verified voter before it opens a session.
  const gate = read("functions/api/voters.js");
  const from = gate.indexOf("const withoutCode");
  const skip = gate.slice(from, gate.indexOf('verification: "skipped"', from));
  assert.ok(from > 0 && skip.length > 100);
  assert.match(skip, /if \(voter\.verified\) \{\s*throw new HttpError\(503, "code_unavailable"/);
});
