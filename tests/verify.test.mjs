// Email verification: the 6-digit code at the gate (POST /api/voters, POST /api/voters/verify).
// Resend and the DNS resolver are stubs (tests/verify-helpers.mjs).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { parse } from "smol-toml";
import { getPlatformProxy } from "wrangler";
import * as likes from "../functions/api/likes.js";
import * as me from "../functions/api/me.js";
import * as state from "../functions/api/state.js";
import * as voters from "../functions/api/voters.js";
import * as verify from "../functions/api/voters/verify.js";
import { LIMITS, VERIFICATION, sendBudget } from "../functions/_lib/config.js";
import { signVoterToken, verifyVoterToken } from "../functions/_lib/token.js";
import { codeEmail, codeHmac, newCode } from "../functions/_lib/verify.js";
import { ROOT, SECRET, addTrack, call, freshIp, makeEnv } from "./helpers.mjs";
import { RESEND_STUB, TEST_MAIL_KEY, TOKEN_RE, VERIFY_ENV, dns, stubMail, wrongCode } from "./verify-helpers.mjs";

let env, dispose;
before(async () => { ({ env, dispose } = await makeEnv(VERIFY_ENV)); await addTrack(env, "brian"); });
after(() => dispose());
// The daily budget is site-wide: every test starts with it unspent.
beforeEach(async () => { await env.DB.prepare("DELETE FROM email_sends").run(); });

const gate = (email, extra = {}, e = env, ip = freshIp()) => call(voters.onRequest, e, { method: "POST", path: "/api/voters", body: { name: "Jane Doe", email, city: "Atlanta", ...extra }, ip });
const check = (email, code, e = env, ip = freshIp()) => call(verify.onRequest, e, { method: "POST", path: "/api/voters/verify", body: { email, code }, ip });
const row = (email) => env.DB.prepare("SELECT id, name, email, city, marketing_opt_in, verified, verified_at, unverified_reason FROM voters WHERE email = ?1").bind(email).first();
const like = (token) => call(likes.onRequest, env, { method: "POST", path: "/api/likes", token, body: { track: "brian", liked: true } });
const nowS = () => Math.floor(Date.now() / 1000);
// Moves a voter's sends (and so their cooldown and hourly window) into the past.
const ageSends = async (email, seconds) => env.DB.prepare("UPDATE email_sends SET sent_at = sent_at - ?2 WHERE voter_id = (SELECT id FROM voters WHERE email_key = ?1)").bind(email, seconds).run();
// Exact-second boundaries need the clock held still: wait for the start of a second, then set the
// send's age absolutely, so the next call is judged in that same second (ageSends is relative and
// drifts by one whenever a second ticks over mid-test).
const startOfSecond = async () => { while (Date.now() % 1000 > 300) await new Promise((r) => setTimeout(r, 20)); };
const setSendAge = async (email, seconds) => { await startOfSecond(); return env.DB.prepare("UPDATE email_sends SET sent_at = ?2 WHERE voter_id = (SELECT id FROM voters WHERE email_key = ?1)").bind(email, nowS() - seconds).run(); };
const sendsCounted = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM email_sends WHERE counted = 1 AND sent_at > ?1").bind(nowS() - 86400).first()).n;
async function spendBudget(leave = 0) {
  await env.DB.prepare("INSERT OR IGNORE INTO voters (name, email, email_key, city, created_at) VALUES ('Filler', 'filler@example.com', 'filler@example.com', 'X', '2026-10-01T00:00:00.000Z')").run();
  const id = (await row("filler@example.com")).id;
  for (let i = await sendsCounted(); i < sendBudget(env) - leave; i++) await env.DB.prepare("INSERT INTO email_sends (voter_id, sent_at) VALUES (?1, ?2)").bind(id, nowS() - 3 * 3600).run();
}
// A voter who has entered a code: { token, code }.
async function verified(mail, email, extra = {}) {
  const sentBefore = mail.sent.length;
  const g = await gate(email, extra);
  assert.equal(g.body?.verification, "code_sent", `${email}: ${g.text}`);
  assert.equal(mail.sent.length, sentBefore + 1);
  const code = mail.sent.at(-1).code;
  const v = await check(email, code);
  assert.equal(v.status, 200, v.text);
  return { token: v.body.token, code };
}

test("the numbers are the owner's: 50 emails a day, 10 minutes, 5 tries, 60 s, 3 an hour", () => {
  assert.equal(VERIFICATION.dailySendBudget, 50);
  // Production and staging count in separate databases: their shares add up to the 50, never more.
  const production = sendBudget({ APP_ENV: "production" }), preview = sendBudget({ APP_ENV: "preview" });
  assert.deepEqual([production, preview], [45, 5]);
  assert.equal(production + preview, VERIFICATION.dailySendBudget);
  assert.equal(sendBudget({}), production, "anything that is not preview gets production's share, never more");
  assert.equal(sendBudget(env), production);
  assert.equal(VERIFICATION.codeTtl, 600);
  assert.equal(VERIFICATION.maxTries, 5);
  assert.equal(VERIFICATION.resendCooldown, 60);
  assert.equal(VERIFICATION.sendsPerEmailPerHour, 3);
  assert.equal(VERIFICATION.from, "Top Barz Voting <topbarz@joinwestpeek.com>");
  assert.equal(VERIFICATION.resendEndpoint, "https://api.resend.com/emails");
  assert.equal(VERIFICATION.dohEndpoint, "https://cloudflare-dns.com/dns-query");
  // The daily budget is written once: no other shipped file restates it next to "budget".
  const hits = [];
  const walk = (dir) => { for (const f of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, f.name); if (f.isDirectory()) walk(p); else if (/dailySendBudget\s*[:=]\s*[0-9]/.test(fs.readFileSync(p, "utf8"))) hits.push(path.relative(ROOT, p)); } };
  walk(path.join(ROOT, "functions")); walk(path.join(ROOT, "scripts"));
  assert.deepEqual(hits, ["functions/_lib/config.js"]);
});

test("the switch is a plain var, on in both environments, and the mail key is in no file", () => {
  const text = fs.readFileSync(path.join(ROOT, "wrangler.toml"), "utf8");
  const cfg = parse(text);
  assert.ok(["on", "off"].includes(cfg.vars.EMAIL_VERIFICATION), "production: on or off, nothing else");
  assert.equal(cfg.vars.EMAIL_VERIFICATION, cfg.env.preview.vars.EMAIL_VERIFICATION, "staging proves what production runs");
  assert.equal(cfg.vars.RESEND_API_KEY, undefined);
  assert.equal(cfg.env.preview.vars.RESEND_API_KEY, undefined);
  assert.ok(!/\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{8,}/.test(text), "no Resend key in wrangler.toml");
});

test("/api/state names whether codes are in use, and why not", async () => {
  const get = async (e) => { state._resetStateMemo(); return (await call(state.onRequest, e, { path: "/api/state" })).body.verification; };
  assert.deepEqual(await get(env), { available: true });
  assert.deepEqual(await get({ ...env, EMAIL_VERIFICATION: "off" }), { available: false, reason: "switched_off" });
  assert.deepEqual(await get({ ...env, EMAIL_VERIFICATION: undefined }), { available: false, reason: "switched_off" });
  assert.deepEqual(await get({ ...env, EMAIL_VERIFICATION: "ON " }), { available: false, reason: "switched_off" }, "only the exact word on");
  assert.deepEqual(await get({ ...env, RESEND_API_KEY: "" }), { available: false, reason: "no_key" });
  state._resetStateMemo();
  const res = await call(state.onRequest, env, { path: "/api/state" });
  assert.ok(!res.text.includes(TEST_MAIL_KEY), "the key never reaches a browser");
});

test("happy path: the gate emails a code and gives no token; the code gives the token and the like counts", async (t) => {
  const mail = stubMail(t);
  const g = await gate("  Happy.Path@Example.com ", { marketing_opt_in: true });
  assert.equal(g.status, 200);
  assert.deepEqual(g.body, { verification: "code_sent", sent: true, email: "happy.path@example.com", resend_in_seconds: 60, expires_in_seconds: 600 });
  assert.ok(!TOKEN_RE.test(g.text));
  const before = await row("happy.path@example.com");
  assert.deepEqual([before.verified, before.verified_at, before.unverified_reason, before.marketing_opt_in], [0, null, "pending", 1]);

  assert.equal(mail.attempts.length, 1);
  const sent = mail.sent[0];
  assert.equal(sent.method, "POST");
  assert.equal(sent.headers.get("authorization"), `Bearer ${TEST_MAIL_KEY}`);
  assert.equal(sent.body.from, "Top Barz Voting <topbarz@joinwestpeek.com>");
  assert.deepEqual(sent.body.to, ["happy.path@example.com"]);
  assert.match(sent.code, /^[0-9]{6}$/);
  assert.equal(sent.body.subject, `${sent.code} is your Top Barz voting code`);
  assert.deepEqual(mail.lookups, [{ name: "example.com", type: "MX" }], "one DNS lookup");

  // Only an HMAC of the code is stored.
  const stored = await env.DB.prepare("SELECT * FROM email_codes WHERE voter_id = ?1").bind(before.id).first();
  assert.deepEqual(Object.keys(stored).sort(), ["attempts", "code_hmac", "expires_at", "voter_id"]);
  assert.equal(stored.code_hmac, await codeHmac(env, before.id, sent.code));
  assert.match(stored.code_hmac, /^[0-9a-f]{64}$/);
  assert.notEqual(stored.code_hmac, await codeHmac({ VOTER_TOKEN_SECRET: "another-secret" }, before.id, sent.code), "keyed with VOTER_TOKEN_SECRET");
  assert.notEqual(stored.code_hmac, await codeHmac(env, before.id + 1, sent.code), "bound to its voter");
  assert.ok(Object.values(stored).every((v) => String(v) !== sent.code));
  assert.ok(Math.abs(stored.expires_at - (nowS() + 600)) <= 5);

  const v = await check("HAPPY.path@example.com", ` ${sent.code.slice(0, 3)} ${sent.code.slice(3)} `);
  assert.equal(v.status, 200, v.text);
  assert.deepEqual(Object.keys(v.body).sort(), ["liked", "returning", "token", "verification", "voter"]);
  assert.equal(v.body.verification, "verified");
  assert.equal(v.body.returning, false);
  assert.deepEqual(v.body.voter, { first_name: "Jane" });
  assert.equal(await verifyVoterToken(env, v.body.token), before.id);
  const done = await row("happy.path@example.com");
  assert.equal(done.verified, 1);
  assert.equal(done.unverified_reason, null);
  assert.ok(Math.abs(Date.parse(done.verified_at) - Date.now()) < 10_000);
  assert.equal(await env.DB.prepare("SELECT 1 FROM email_codes WHERE voter_id = ?1").bind(before.id).first(), null, "a used code is gone");

  const liked = await like(v.body.token);
  assert.deepEqual([liked.status, liked.body.liked, liked.body.likes], [200, true, 1]);
  assert.deepEqual((await call(me.onRequest, env, { path: "/api/me", token: v.body.token })).body, { voter: { first_name: "Jane" }, liked: ["brian"] });
  const again = await check("happy.path@example.com", sent.code);
  assert.deepEqual([again.status, again.body.error], [410, "code_expired"], "a code works once");
  assert.equal(mail.attempts.length, 1);
});

test("the email: subject, the code, 10 minutes, what to do, and the brand rules", () => {
  const m = codeEmail("004217");
  assert.equal(m.subject, "004217 is your Top Barz voting code");
  for (const part of [m.text, m.html]) {
    assert.ok(part.includes("004217"));
    assert.match(part, /works for 10 minutes/);
    assert.match(part, /Enter it on the voting page to count your vote/);
    assert.match(part, /If you did not ask for this code, ignore this email/);
    assert.match(part, /Top Barz/);
    assert.ok(!/TopBarz|Topbarz|TOPBARZ|Top-Barz/.test(part) && !/spit\s+your\s+bars/i.test(part));
  }
  assert.ok(m.html.length < 1200, "a small HTML part");
  assert.ok(!/<a\s|<img|<script/i.test(m.html), "no links, images or scripts");
});

test("codes are six digits from crypto randomness, leading zeros kept", (t) => {
  const seen = new Set();
  for (let i = 0; i < 400; i++) { const c = newCode(); assert.match(c, /^[0-9]{6}$/); seen.add(c); }
  assert.ok(seen.size >= 395, "no visible repetition");
  const calls = t.mock.method(crypto, "getRandomValues", (buf) => { buf[0] = calls.mock.callCount() === 0 ? 4_294_000_000 : 42; return buf; });
  assert.equal(newCode(), "000042", "a value past the last whole million is thrown away (no modulo bias)");
  assert.equal(calls.mock.callCount(), 2);
  const source = fs.readFileSync(path.join(ROOT, "functions/_lib/verify.js"), "utf8");
  assert.ok(!/Math\.random\(\)\s*\*/.test(source), "never Math.random for a code");
});

test("a wrong code is refused with the tries left; the fifth wrong try kills the code", async (t) => {
  const mail = stubMail(t);
  await gate("wrong@example.com");
  const code = mail.sent[0].code;
  for (const junk of ["12345", "1234567", "abcdef", "", 123456, null]) {
    const res = await check("wrong@example.com", junk);
    assert.deepEqual([res.status, res.body.error], [400, "invalid_code"], String(junk));
  }
  for (let left = 4; left >= 1; left--) {
    const res = await check("wrong@example.com", wrongCode(code));
    assert.deepEqual([res.status, res.body.error, res.body.tries_left], [400, "wrong_code", left]);
    assert.match(res.body.message, new RegExp(`${left} (try|tries) left`));
    assert.ok(!TOKEN_RE.test(res.text));
  }
  const fifth = await check("wrong@example.com", wrongCode(code));
  assert.deepEqual([fifth.status, fifth.body.error], [410, "code_exhausted"]);
  const right = await check("wrong@example.com", code);
  assert.deepEqual([right.status, right.body.error], [410, "code_exhausted"], "the right code is dead too");
  assert.ok(!TOKEN_RE.test(right.text));
  assert.deepEqual([(await row("wrong@example.com")).verified, (await row("wrong@example.com")).unverified_reason], [0, "pending"]);

  // The next step: a new code. Inside the cooldown that is a named wait, after it a fresh code.
  const tooSoon = await gate("wrong@example.com");
  assert.deepEqual([tooSoon.status, tooSoon.body.error], [429, "resend_cooldown"]);
  assert.ok(tooSoon.body.retry_after_seconds > 0 && tooSoon.body.retry_after_seconds <= 60);
  await ageSends("wrong@example.com", 61);
  assert.equal((await gate("wrong@example.com")).body.verification, "code_sent");
  assert.equal(mail.sent.length, 2);
  assert.equal((await check("wrong@example.com", mail.sent[1].code)).status, 200, "a fresh code has all its tries");
});

test("an expired code is refused, and an email that was never sent a code gets the same answer", async (t) => {
  const mail = stubMail(t);
  await gate("expired@example.com");
  const id = (await row("expired@example.com")).id;
  await env.DB.prepare("UPDATE email_codes SET expires_at = ?2 WHERE voter_id = ?1").bind(id, nowS() - 1).run();
  const res = await check("expired@example.com", mail.sent[0].code);
  assert.deepEqual([res.status, res.body.error], [410, "code_expired"]);
  assert.ok(!TOKEN_RE.test(res.text));
  assert.equal((await row("expired@example.com")).verified, 0);
  const unknown = await check("nobody.here@example.com", "123456");
  assert.deepEqual([unknown.status, unknown.body], [res.status, res.body], "never says whether an email is known");
  // A code one second from its end still works.
  await ageSends("expired@example.com", 61);
  await gate("expired@example.com");
  await env.DB.prepare("UPDATE email_codes SET expires_at = ?2 WHERE voter_id = ?1").bind(id, nowS() + 2).run();
  assert.equal((await check("expired@example.com", mail.sent[1].code)).status, 200);
});

test("resend cooldown: asking again inside 60 s sends nothing and shows the code step again", async (t) => {
  const mail = stubMail(t);
  await gate("cooldown@example.com");
  await ageSends("cooldown@example.com", 20);
  const again = await gate("cooldown@example.com");
  assert.equal(again.status, 200);
  assert.equal(again.body.verification, "code_sent");
  assert.equal(again.body.sent, false);
  assert.ok(again.body.resend_in_seconds >= 38 && again.body.resend_in_seconds <= 40, `resend in ${again.body.resend_in_seconds}`);
  assert.ok(again.body.expires_in_seconds > 590 && again.body.expires_in_seconds <= 600);
  assert.ok(!TOKEN_RE.test(again.text));
  assert.equal(mail.attempts.length, 1, "no second email inside the cooldown");
  await setSendAge("cooldown@example.com", 59);
  assert.equal((await gate("cooldown@example.com")).body.sent, false, "59 s is still inside");
  await setSendAge("cooldown@example.com", 60);
  const resend = await gate("cooldown@example.com");
  assert.deepEqual([resend.body.verification, resend.body.sent, resend.body.resend_in_seconds], ["code_sent", true, 60]);
  assert.equal(mail.sent.length, 2);
  if (mail.sent[0].code !== mail.sent[1].code) {
    assert.equal((await check("cooldown@example.com", mail.sent[0].code)).body.error, "wrong_code", "a resend replaces the earlier code");
  }
  assert.equal((await check("cooldown@example.com", mail.sent[1].code)).status, 200);
});

test("two requests racing for the same email send one code", async (t) => {
  const mail = stubMail(t);
  const both = await Promise.all([gate("race@example.com"), gate("race@example.com")]);
  assert.deepEqual(both.map((r) => r.status === 200 || r.body.error === "resend_cooldown"), [true, true]);
  assert.ok(both.every((r) => !TOKEN_RE.test(r.text)));
  assert.equal(mail.attempts.length, 1);
});

test("at most 3 codes per email per hour, however the address is written", async (t) => {
  const mail = stubMail(t);
  for (let i = 0; i < 3; i++) {
    assert.equal((await gate(i === 1 ? "hourly+tag@example.com" : "hourly@example.com")).body.sent, true, `send ${i + 1}`);
    await ageSends("hourly@example.com", 600);
  }
  const fourth = await gate("hourly@example.com");
  assert.deepEqual([fourth.status, fourth.body.error], [429, "code_limit"]);
  assert.ok(fourth.body.retry_after_seconds > 0 && fourth.body.retry_after_seconds <= 3600);
  assert.ok(!TOKEN_RE.test(fourth.text), "the cap is not a way in");
  assert.equal(mail.attempts.length, 3);
  assert.deepEqual(mail.sent.map((s) => s.to), ["hourly@example.com", "hourly+tag@example.com", "hourly@example.com"], "one mailbox, one cap (an unproven sign-up is mailed as last typed)");
  assert.equal((await row("hourly@example.com")).unverified_reason, "pending");
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM voters WHERE email_key = 'hourly@example.com'").first()).n, 1);
  await ageSends("hourly@example.com", 3600);
  assert.equal((await gate("hourly@example.com")).body.sent, true, "an hour on, codes flow again");
});

test("the 50-a-day budget: the last email of the share goes out, then a NEW email is let in at once as skipped", async (t) => {
  const mail = stubMail(t);
  const share = sendBudget(env);
  await spendBudget(1);
  assert.equal(await sendsCounted(), share - 1);
  assert.equal((await gate("budget.last@example.com")).body.verification, "code_sent");
  assert.equal(await sendsCounted(), share);

  const res = await gate("budget.over@example.com");
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body).sort(), ["liked", "reason", "returning", "token", "verification", "voter"]);
  assert.deepEqual([res.body.verification, res.body.reason, res.body.returning, res.body.liked], ["skipped", "mail_budget", false, []]);
  const r = await row("budget.over@example.com");
  assert.deepEqual([r.verified, r.unverified_reason], [0, "mail_budget"]);
  assert.equal(await verifyVoterToken(env, res.body.token), r.id);
  assert.equal((await like(res.body.token)).status, 200, "the vote is not lost");
  assert.equal(mail.attempts.length, 1, "nothing is sent past the budget");
  assert.equal(await sendsCounted(), share, "never more than its share of the 50 in 24 hours");

  // A voter still waiting on a code is let in the same way, and can still verify with it later.
  const waiting = await gate("budget.last@example.com");
  assert.deepEqual([waiting.status, waiting.body.verification, waiting.body.sent], [200, "code_sent", false], "inside the cooldown the live code stands");
  await ageSends("budget.last@example.com", 61);
  const letIn = await gate("budget.last@example.com");
  assert.deepEqual([letIn.body.verification, letIn.body.reason], ["skipped", "mail_budget"]);
  assert.equal((await check("budget.last@example.com", mail.sent[0].code)).body.verification, "verified");
  assert.equal((await row("budget.last@example.com")).verified, 1);

  // Rolling: sends older than 24 hours free the budget.
  await env.DB.prepare("UPDATE email_sends SET sent_at = sent_at - 86400").run();
  assert.equal((await gate("budget.nextday@example.com")).body.verification, "code_sent");
  assert.equal(mail.attempts.length, 2);

  // Staging has its own, small share: 5 emails, then skipped.
  await env.DB.prepare("DELETE FROM email_sends").run();
  const staging = { ...env, APP_ENV: "preview" };
  const answers = [];
  for (let i = 0; i < 7; i++) answers.push((await gate(`staging.share${i}@example.com`, {}, staging)).body.verification);
  assert.deepEqual(answers, ["code_sent", "code_sent", "code_sent", "code_sent", "code_sent", "skipped", "skipped"]);
  assert.equal(mail.attempts.length, 2 + VERIFICATION.previewSendShare);
});

test("mail service down (429, 5xx, network error): a NEW email is let in at once as skipped", async (t) => {
  const mail = stubMail(t);
  const cases = [
    ["m429@example.com", () => new Response('{"name":"rate_limit_exceeded"}', { status: 429 }), 0],
    ["m422@example.com", () => new Response("{}", { status: 422 }), 0],
    ["m500@example.com", () => new Response("oops", { status: 500 }), 1],
    ["m503@example.com", () => new Response("", { status: 503 }), 1],
    ["mnet@example.com", () => { throw new TypeError("fetch failed"); }, 1],
  ];
  for (const [email, resend, counted] of cases) {
    await env.DB.prepare("DELETE FROM email_sends").run();
    mail.resend = resend;
    const res = await gate(email);
    assert.equal(res.status, 200, `${email}: ${res.text}`);
    assert.deepEqual([res.body.verification, res.body.reason], ["skipped", "mail_error"], email);
    const r = await row(email);
    assert.deepEqual([r.verified, r.unverified_reason], [0, "mail_error"], email);
    assert.equal(await verifyVoterToken(env, res.body.token), r.id);
    assert.equal(await env.DB.prepare("SELECT 1 FROM email_codes WHERE voter_id = ?1").bind(r.id).first(), null, "no code is kept for an email that never went out");
    // A plain refusal sent nothing, so it does not use the budget; anything unclear stays counted.
    assert.equal(await sendsCounted(), counted, `${email}: counted against the budget`);
  }
  assert.equal(mail.attempts.length, cases.length);
  assert.equal(mail.sent.length, 0);
});

test("an ALREADY verified email never gets a token without a code: mail down is code_unavailable", async (t) => {
  const mail = stubMail(t);
  const victim = await verified(mail, "victim.verified@example.com", { name: "Vic Tim" });
  await like(victim.token);
  const id = (await row("victim.verified@example.com")).id;
  const attempt = () => gate("Victim.Verified+x@example.com", { name: "Mallory", city: "Nowhere", marketing_opt_in: true });
  const refused = (res, why) => {
    assert.deepEqual([res.status, res.body.error], [503, "code_unavailable"], why);
    assert.match(res.body.message, /Try again in a little while/);
    assert.deepEqual(Object.keys(res.body).sort(), ["error", "message"], why);
    assert.ok(!TOKEN_RE.test(res.text) && !TOKEN_RE.test(JSON.stringify([...res.headers])), `${why}: no token`);
    assert.ok(!res.text.includes("Vic") && !res.text.includes("brian"), `${why}: nothing about the voter`);
  };

  await env.DB.prepare("DELETE FROM email_sends").run();
  await spendBudget();
  refused(await attempt(), "budget spent");
  for (const [why, resend] of [["429", () => new Response("{}", { status: 429 })], ["500", () => new Response("{}", { status: 500 })], ["network", () => { throw new TypeError("fetch failed"); }]]) {
    await env.DB.prepare("DELETE FROM email_sends").run();
    mail.resend = resend;
    refused(await attempt(), why);
  }
  const still = await row("victim.verified@example.com");
  assert.deepEqual([still.verified, still.unverified_reason, still.name, still.city, still.marketing_opt_in], [1, null, "Vic Tim", "Atlanta", 1], "still verified; only the opt-in can turn on");
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM like_events WHERE voter_id = ?1").bind(id).first()).n, 1);

  // Mail back up: the code goes to the address on file and the answer says nothing about the voter.
  await env.DB.prepare("DELETE FROM email_sends").run();
  mail.resend = () => new Response("{}", { status: 200 });
  const ok = await attempt();
  assert.deepEqual(ok.body, { verification: "code_sent", sent: true, email: "victim.verified+x@example.com", resend_in_seconds: 60, expires_in_seconds: 600 });
  assert.equal(mail.sent.at(-1).to, "victim.verified@example.com");
  const back = await check("victim.verified@example.com", mail.sent.at(-1).code);
  assert.deepEqual([back.status, back.body.returning, back.body.liked, back.body.voter.first_name], [200, true, ["brian"], "Vic"]);
});

test("a domain that cannot receive mail is refused: nothing saved, nothing sent", async (t) => {
  const mail = stubMail(t);
  const refusedFor = async (email, lookup, what) => {
    mail.lookup = lookup;
    const res = await gate(email);
    assert.deepEqual([res.status, res.body.error], [400, "undeliverable_email"], what);
    assert.match(res.body.fields.email, /cannot receive mail/);
    assert.equal(res.body.message, res.body.fields.email);
    assert.equal(await row(email), null, `${what}: no voter saved`);
  };
  await refusedFor("typo@gmial-example.com", () => dns.nxdomain(), "the domain does not exist");
  await refusedFor("x@nullmx-example.com", () => dns.nullMx(), "a null MX");
  await refusedFor("x@nothing-example.com", () => dns.nodata(), "neither MX nor A");
  assert.deepEqual(mail.lookups.slice(-2), [{ name: "nothing-example.com", type: "MX" }, { name: "nothing-example.com", type: "A" }], "A is asked only when there is no MX");
  assert.equal(mail.attempts.length, 0, "no email to a dead domain");
  assert.equal(await sendsCounted(), 0);

  // The answer is cached per domain: a second voter there costs no lookup.
  const asked = mail.lookups.length;
  mail.lookup = () => { throw new Error("should not be asked"); };
  assert.equal((await gate("other@gmial-example.com")).body.error, "undeliverable_email");
  assert.equal(mail.lookups.length, asked);
  // …and a refusal is rechecked after an hour (the domain may have been fixed).
  await env.DB.prepare("UPDATE mail_domains SET checked_at = checked_at - ?1 WHERE domain = 'gmial-example.com'").bind(VERIFICATION.domainBadTtl + 1).run();
  mail.lookup = () => dns.mx();
  assert.equal((await gate("other@gmial-example.com")).body.verification, "code_sent");

  // No MX but an A record: mail falls back to the host itself.
  mail.lookup = (name, type) => (type === "MX" ? dns.nodata() : dns.a());
  assert.equal((await gate("x@a-only-example.com")).body.verification, "code_sent");
  const before = mail.lookups.length;
  assert.equal((await gate("y@a-only-example.com")).body.verification, "code_sent");
  assert.equal(mail.lookups.length, before, "a good domain is cached too");
});

test("a DNS lookup that fails never blocks a voter: unknown, proceed", async (t) => {
  const mail = stubMail(t);
  const failures = [
    ["servfail", () => dns.servfail()],
    ["http 500", () => new Response("nope", { status: 500 })],
    ["network", () => { throw new TypeError("fetch failed"); }],
    ["garbage", () => new Response("<html>", { status: 200 })],
  ];
  for (const [what, lookup] of failures) {
    const domain = `dnsdown-${what.replace(/\W/g, "")}-example.com`;
    mail.lookup = lookup;
    const res = await gate(`x@${domain}`);
    assert.deepEqual([res.status, res.body.verification], [200, "code_sent"], what);
    assert.equal(await env.DB.prepare("SELECT 1 FROM mail_domains WHERE domain = ?1").bind(domain).first(), null, `${what}: a failed lookup is not cached`);
  }
  assert.equal(mail.sent.length, failures.length);
});

test("switch off (or no mail key): the gate behaves exactly as before, and nothing calls out", async (t) => {
  const mail = stubMail(t);
  const offs = [
    ["off", { ...env, EMAIL_VERIFICATION: "off" }],
    ["unset", { ...env, EMAIL_VERIFICATION: undefined }],
    ["nokey", { ...env, RESEND_API_KEY: undefined }],
  ];
  for (const [what, off] of offs) {
    const email = `legacy.${what}@no-such-domain-example.com`;
    const res = await gate(email, {}, off);
    assert.equal(res.status, 200, what);
    assert.deepEqual(Object.keys(res.body).sort(), ["liked", "returning", "token", "voter"], `${what}: the answer it always gave`);
    assert.deepEqual([res.body.voter, res.body.liked, res.body.returning], [{ first_name: "Jane" }, [], false]);
    const r = await row(email);
    assert.equal(await verifyVoterToken(env, res.body.token), r.id);
    assert.deepEqual([r.verified, r.unverified_reason], [0, "verification_off"], what);
    assert.equal((await gate(email, {}, off)).body.returning, true);
    const v = await check(email, "123456", off);
    assert.deepEqual([v.status, v.body.error], [409, "verification_off"], what);
  }
  assert.deepEqual([mail.attempts.length, mail.lookups.length], [0, 0], "no email and no DNS lookup");
  assert.equal(await sendsCounted(), 0);

  // A voter left waiting on a code when the switch goes off is simply let in, and is no longer `pending`.
  await gate("midway@example.com");
  assert.equal((await row("midway@example.com")).unverified_reason, "pending");
  const res = await gate("midway@example.com", {}, offs[0][1]);
  assert.ok(TOKEN_RE.test(res.body.token));
  assert.equal((await row("midway@example.com")).unverified_reason, "verification_off");
});

test("voters from before the change keep their tokens and are marked before_verification", async (t) => {
  // A database as production has it today (0001 only), with a voter and a like, then this migration.
  const proxy = await getPlatformProxy({ configPath: path.join(ROOT, "wrangler.toml"), persist: false });
  t.after(() => proxy.dispose());
  const old = { ...env, DB: proxy.env.DB, MEDIA: proxy.env.MEDIA };
  const apply = async (file) => {
    const sql = fs.readFileSync(path.join(ROOT, "migrations", file), "utf8").replace(/--.*$/gm, "");
    for (const stmt of sql.split(";").map((s) => s.trim()).filter(Boolean)) await old.DB.prepare(stmt).run();
  };
  const files = fs.readdirSync(path.join(ROOT, "migrations")).filter((f) => f.endsWith(".sql")).sort();
  assert.deepEqual(files.slice(0, 2), ["0001_init.sql", "0002_email_verification.sql"]);
  await apply(files[0]);
  await addTrack(old, "brian");
  await old.DB.prepare("INSERT INTO voters (name, email, email_key, city, marketing_opt_in, created_at, ip_hash) VALUES ('Early Bird', 'early@example.com', 'early@example.com', 'Oakland', 1, '2026-10-02T10:00:00.000Z', 'abc')").run();
  const token = await signVoterToken(old, 1);
  await call(likes.onRequest, { ...old, EMAIL_VERIFICATION: "off" }, { method: "POST", path: "/api/likes", token, body: { track: "brian", liked: true } });
  for (const f of files.slice(1)) await apply(f);

  const early = await old.DB.prepare("SELECT verified, verified_at, unverified_reason, name, city, marketing_opt_in FROM voters WHERE email = 'early@example.com'").first();
  assert.deepEqual(early, { verified: 0, verified_at: null, unverified_reason: "before_verification", name: "Early Bird", city: "Oakland", marketing_opt_in: 1 });
  // With verification on, the old token still works everywhere.
  assert.deepEqual((await call(me.onRequest, old, { path: "/api/me", token })).body, { voter: { first_name: "Early" }, liked: ["brian"] });
  const un = await call(likes.onRequest, old, { method: "POST", path: "/api/likes", token, body: { track: "brian", liked: false } });
  assert.deepEqual([un.status, un.body.liked, un.body.likes], [200, false, 0]);
  // Back at the gate they get a code like anyone else, and entering it verifies the same voter.
  const mail = stubMail(t);
  const g = await call(voters.onRequest, old, { method: "POST", path: "/api/voters", body: { name: "Someone Else", email: "early@example.com", city: "X" }, ip: freshIp() });
  assert.equal(g.body.verification, "code_sent");
  assert.equal((await old.DB.prepare("SELECT unverified_reason FROM voters WHERE id = 1").first()).unverified_reason, "before_verification", "still marked until the code is entered");
  const v = await call(verify.onRequest, old, { method: "POST", path: "/api/voters/verify", body: { email: "early@example.com", code: mail.sent[0].code }, ip: freshIp() });
  assert.deepEqual([v.status, await verifyVoterToken(old, v.body.token), v.body.returning, v.body.voter.first_name], [200, 1, true, "Early"]);
  assert.equal(SECRET.length > 0, true);
});

test("an unproven sign-up can be corrected; a voter who has been let in keeps what is on file", async (t) => {
  const mail = stubMail(t);
  await gate("claimed@example.com", { name: "Not Me", city: "Wrong", marketing_opt_in: true });
  await ageSends("claimed@example.com", 61);
  await gate("claimed+real@example.com", { name: "Real Owner", city: "Oakland" });
  const pending = await env.DB.prepare("SELECT name, email, city, marketing_opt_in, unverified_reason FROM voters WHERE email_key = 'claimed@example.com'").first();
  assert.deepEqual(pending, { name: "Real Owner", email: "claimed+real@example.com", city: "Oakland", marketing_opt_in: 0, unverified_reason: "pending" });
  assert.equal(mail.sent[1].to, "claimed+real@example.com");
  assert.equal((await check("claimed@example.com", mail.sent[1].code)).body.voter.first_name, "Real");
  await gate("claimed@example.com", { name: "Mallory", city: "Elsewhere" });
  assert.deepEqual([(await row("claimed+real@example.com")).name, (await row("claimed+real@example.com")).city], ["Real Owner", "Oakland"]);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM voters WHERE email_key = 'claimed@example.com'").first()).n, 1);
});

test("code tries are rate limited per IP, and the gate keeps its per-IP limit with codes on", async (t) => {
  stubMail(t);
  const ip = "192.0.2.77";
  let accepted = 0;
  for (let i = 0; i < 2 * LIMITS.verifyPerIp.max + 2; i++) {
    const res = await check(`spray${i}@example.com`, "123456", env, ip);
    if (res.status === 429) { assert.equal(res.body.error, "rate_limited"); break; }
    accepted++;
  }
  assert.ok(accepted >= LIMITS.verifyPerIp.max && accepted <= 2 * LIMITS.verifyPerIp.max, `limited after ${accepted}`);

  await spendBudget(); // so the flood below costs no sends
  const gateIp = "192.0.2.78";
  let through = 0;
  for (let i = 0; i < 2 * LIMITS.gatePerIp.max + 2; i++) {
    const res = await gate(`gateflood${i}@example.com`, {}, env, gateIp);
    if (res.status === 429) { assert.equal(res.body.error, "rate_limited"); break; }
    through++;
  }
  assert.ok(through >= LIMITS.gatePerIp.max && through <= 2 * LIMITS.gatePerIp.max, `limited after ${through}`);
});

test("no signing secret: the gate and the code check are a named 503 and nothing is sent", async (t) => {
  const mail = stubMail(t);
  const bare = { ...env, VOTER_TOKEN_SECRET: undefined };
  const g = await gate("nosecret.verify@example.com", {}, bare);
  assert.deepEqual([g.status, g.body.error], [503, "token_secret_missing"]);
  const v = await check("nosecret.verify@example.com", "123456", bare);
  assert.deepEqual([v.status, v.body.error], [503, "token_secret_missing"]);
  assert.equal(await row("nosecret.verify@example.com"), null);
  assert.equal(mail.attempts.length, 0);
  assert.equal((await call(verify.onRequest, env, { path: "/api/voters/verify" })).status, 405);
});

test("the mail endpoint is Resend's unless overridden, and the key is sent only there", async (t) => {
  const seen = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    seen.push({ url: url.origin + url.pathname, auth: new Headers(init.headers).get("authorization") });
    if (url.host === "cloudflare-dns.com") return dns.mx();
    return new Response("{}", { status: 200 });
  };
  t.after(() => { globalThis.fetch = real; });
  const res = await gate("default.endpoint@example.org", {}, { ...env, RESEND_ENDPOINT: undefined });
  assert.equal(res.body.verification, "code_sent");
  assert.deepEqual(seen, [
    { url: "https://cloudflare-dns.com/dns-query", auth: null },
    { url: "https://api.resend.com/emails", auth: `Bearer ${TEST_MAIL_KEY}` },
  ]);
  assert.notEqual(RESEND_STUB, VERIFICATION.resendEndpoint);
});
