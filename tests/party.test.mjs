// The holiday party (Scooter, 17 Nov 2026): the QR sign-up, booth sessions, the team's line and
// sign-in, the contest box on /track and the song going into the vote by itself, the gallery GIFs
// and the switch. Against a real local D1 and R2 (helpers.mjs).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import * as booth from "../functions/api/booth/[[path]].js";
import * as party from "../functions/api/party/[[path]].js";
import * as state from "../functions/api/state.js";
import { contestVerdict, freshSlug, voteLabel } from "../functions/_lib/contest.js";
import { cleanInstagram, groupLabel, isSessionCode, lineOrder, parseSignUp, randomSessionCode, sessionCodeFrom } from "../functions/_lib/party.js";
import { signTeamToken, verifyTeamToken } from "../functions/_lib/team.js";
import { signVoterToken } from "../functions/_lib/token.js";
import { _resetStateMemo } from "../functions/api/state.js";
import { ROOT, call, freshIp, makeEnv } from "./helpers.mjs";

let env, dispose;
const mailbox = [];
const realFetch = globalThis.fetch;
before(async () => {
  ({ env, dispose } = await makeEnv({ HOLIDAY_EVENT: "on", EMAIL_VERIFICATION: "on", RESEND_API_KEY: "test-only", RESEND_ENDPOINT: "https://mail.test/emails" }));
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("https://mail.test/")) { mailbox.push(JSON.parse(init.body)); return new Response('{"id":"x"}', { status: 200 }); }
    return realFetch(url, init);
  };
});
after(async () => { globalThis.fetch = realFetch; await dispose(); });

const P = (p) => ({ path: p.split("/").filter(Boolean) });
const post = (route, body, { ip = freshIp(), token, e = env } = {}) => call(party.onRequest, e, { method: "POST", path: `/api/party/${route}`, body, ip, token, params: P(route) });
const get = (route, { token, e = env } = {}) => call(party.onRequest, e, { path: `/api/party/${route}`, token, params: P(route) });
const guest = (name, email, extra = {}) => post("join", { name, phone: "(555) 010-2030", email, city: "Brooklyn", instagram: "", website: "", ...extra });
const B = (code, what, body, ip = freshIp(), e = env) => call(booth.onRequest, e, { method: "POST", path: `/api/booth/tracks/${code}/${what}`, ip, body, params: { path: ["tracks", code, what] } });
async function upload(name = "Holiday Jingle.mp3", headers = {}, e = env) {
  const bytes = new Uint8Array(1024).fill(7);
  const h = new Headers({ "cf-connecting-ip": freshIp(), "x-file-name": name, "content-type": "audio/mpeg", "content-length": String(bytes.byteLength), ...headers });
  const res = await booth.onRequest({ request: new Request("https://voting.test/api/booth/tracks", { method: "POST", headers: h, body: bytes }), env: e, params: { path: ["tracks"] }, waitUntil: () => {} });
  return { status: res.status, body: await res.json() };
}
async function teamToken(email = "lead@example.com") {
  const row = await env.DB.prepare("INSERT INTO team_members (email, added_at) VALUES (?1, ?2) ON CONFLICT (email) DO UPDATE SET removed_at = NULL RETURNING id").bind(email, Date.now()).first();
  return signTeamToken(env, row.id, Math.floor(Date.now() / 1000));
}
const stateNow = async () => { _resetStateMemo(); return (await call(state.onRequest, env, { path: "/api/state" })).body; };
const sessionId = async (code) => (await env.DB.prepare("SELECT id FROM party_sessions WHERE code = ?1").bind(code).first()).id;
const markBooth = async (code, token) => post(`team/sessions/${await sessionId(code)}/status`, { status: "booth", from: "waiting" }, { token });

test("rules: session codes are 4 letters with no I or O; sign-ups need name, phone, email and city; Instagram is optional", () => {
  for (let i = 0; i < 300; i++) assert.ok(isSessionCode(randomSessionCode()));
  assert.ok(!/[IO0-9]/.test([...Array(300)].map(() => randomSessionCode()).join("")), "no look-alike characters");
  assert.equal(sessionCodeFrom(" jx-qp "), "JXQP");
  assert.ok(!isSessionCode("JXQO") && !isSessionCode("1234"));
  const ok = parseSignUp({ name: " Jay  Smith ", phone: "+1 555 010 2030", email: "Jay@Example.com", city: "Brooklyn", instagram: "@jay.bars" });
  assert.deepEqual(ok.value, { name: "Jay Smith", phone: "+15550102030", email: "jay@example.com", city: "Brooklyn", instagram: "@jay.bars", session_code: null });
  for (const [field, body] of [["name", { name: "" }], ["phone", { phone: "call me" }], ["email", { email: "nope" }], ["city", { city: " " }], ["instagram", { instagram: "not a handle!" }], ["session_code", { session_code: "AB" }], ["website", { website: "bot" }]]) {
    assert.equal(parseSignUp({ name: "A", phone: "5550102030", email: "a@b.co", city: "X", ...body }).field, field, field);
  }
  assert.equal(cleanInstagram("https://instagram.com/jay_b/"), "@jay_b");
  assert.equal(groupLabel(["Jay"]), "Jay");
  assert.equal(groupLabel(["Jay", "Mo"]), "Jay & Mo");
  assert.equal(groupLabel(["Jay", "Mo", "Kim"]), "Jay, Mo & Kim");
});

test("the switch: off (production until go-live), every party route answers 404 party_off and state is unchanged", async () => {
  const offEnv = { ...env, HOLIDAY_EVENT: "off" };
  assert.deepEqual((await get("", { e: offEnv })).body, { on: false });
  assert.deepEqual((await get("")).body, { on: true });
  for (const r of ["join", "me", "move", "team/code", "team/verify"]) assert.equal((await post(r, {}, { e: offEnv })).body.error, "party_off", r);
  assert.equal((await get("team/line", { e: offEnv })).body.error, "party_off");
  assert.deepEqual((await call(booth.onRequest, offEnv, { path: "/api/booth/sessions", params: { path: ["sessions"] } })).body, { on: false, sessions: [] });
  _resetStateMemo();
  const s = (await call(state.onRequest, offEnv, { path: "/api/state" })).body;
  assert.ok(!("holiday" in s) && !("gifs" in s), "production's /api/state carries nothing new");
  const toml = fs.readFileSync(path.join(ROOT, "wrangler.toml"), "utf8");
  const [prod, preview] = toml.split("[env.preview.vars]");
  assert.match(prod, /\nHOLIDAY_EVENT = "off"\n/, "production is off");
  assert.match(preview, /\nHOLIDAY_EVENT = "on"\n/, "preview is on");
});

test("sign-up and sessions: the first person gets a code, friends join it, the line shows one group in sign-up order; a wrong code says so", async () => {
  const a = await guest("Jay Smith", "jay@example.com");
  assert.equal(a.status, 201);
  assert.ok(isSessionCode(a.body.session.code));
  assert.deepEqual(a.body.session.names, ["Jay"]);
  assert.ok(Number.isInteger(a.body.session.place) && a.body.session.place >= 1);
  const b = await guest("Mo Lee", "mo@example.com", { session_code: a.body.session.code.toLowerCase() });
  const c = await guest("Kim Park", "kim@example.com", { session_code: a.body.session.code });
  assert.equal(c.body.session.code, a.body.session.code);
  assert.deepEqual(c.body.session.names, ["Jay", "Mo", "Kim"]);
  assert.equal(c.body.session.size, 3);
  assert.equal((await guest("Zed", "zed@example.com", { session_code: "ZZZZ" })).body.error, "no_session");
  assert.equal((await guest("Jay Again", "JAY@example.com")).body.error, "already_signed_up", "one sign-up per email");
  // Privacy: nothing a guest is answered carries a phone number, an email or a last name.
  for (const res of [a, b, c]) assert.ok(!/555|@|Smith|Lee|Park|Brooklyn/.test(JSON.stringify({ ...res.body, guest_key: "" })), JSON.stringify(res.body));
  // The guest's own refresh, and a move to their own place.
  const me = await post("me", { guest_key: b.body.guest_key });
  assert.equal(me.body.session.code, a.body.session.code);
  assert.equal((await post("me", { guest_key: "0".repeat(24) })).body.error, "no_guest");
  const moved = await post("move", { guest_key: b.body.guest_key, session_code: null });
  assert.notEqual(moved.body.session.code, a.body.session.code);
  assert.deepEqual(moved.body.session.names, ["Mo"]);
  const back = await post("move", { guest_key: b.body.guest_key, session_code: a.body.session.code });
  assert.deepEqual(back.body.session.names, ["Jay", "Mo", "Kim"], "back in the group, in the order they first signed up");
});

test("the line: the group in the booth first, then waiting in join order with places, then out; empty sessions are left out", () => {
  const s = (id, status, created_at, n = 1, status_at = 0) => ({ id, status, created_at, status_at, guests: Array.from({ length: n }, () => ({})) });
  const order = lineOrder([s(1, "out", 1, 1, 50), s(2, "waiting", 5, 2), s(3, "booth", 9, 3, 60), s(4, "waiting", 3, 1), s(5, "waiting", 2, 0)]);
  assert.deepEqual(order.map((x) => [x.id, x.place]), [[3, 0], [4, 1], [2, 2], [1, null]]);
});

test("team sign-in: an emailed code for an email on the list only; the token is the team's own; a removed member is refused", async () => {
  await teamToken("lead@example.com");
  assert.equal((await post("team/code", { email: "stranger@example.com" })).body.error, "not_team");
  const sent = await post("team/code", { email: "Lead@Example.com" });
  assert.equal(sent.status, 200, sent.text);
  assert.equal(sent.body.sent, true);
  const mail = mailbox.at(-1);
  assert.deepEqual(mail.to, ["lead@example.com"]);
  const code = /(\d{6})/.exec(mail.subject)[1];
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM team_code_sends WHERE counted = 1").first()).n, 1, "counted in the shared mail budget");
  const wrong = await post("team/verify", { email: "lead@example.com", code: code === "000000" ? "111111" : "000000" });
  assert.equal(wrong.body.error, "wrong_code");
  const ok = await post("team/verify", { email: "lead@example.com", code });
  assert.equal(ok.status, 200, ok.text);
  assert.match(ok.body.token, /^t1\./);
  assert.equal((await post("team/verify", { email: "lead@example.com", code })).body.error, "code_expired", "a code works once");
  assert.equal((await get("team/line", { token: ok.body.token })).status, 200);
  assert.equal((await get("team/line")).body.error, "team_sign_in", "no token, no line");
  assert.equal((await get("team/line", { token: await signVoterToken(env, 1) })).body.error, "team_sign_in", "a voter token is not a team token");
  const nowS = Math.floor(Date.now() / 1000);
  assert.equal(await verifyTeamToken(env, await signTeamToken(env, 9, nowS - 31 * 86400), nowS), null, "a token older than 30 days is dead");
  // Members: add, list, remove; never yourself.
  const added = await post("team/members", { email: "helper@example.com" }, { token: ok.body.token });
  const helper = added.body.members.find((m) => m.email === "helper@example.com");
  assert.ok(helper && !helper.you);
  const me = added.body.members.find((m) => m.you);
  assert.equal((await post(`team/members/${me.id}/remove`, {}, { token: ok.body.token })).body.error, "not_yourself");
  const helperToken = await signTeamToken(env, helper.id, nowS);
  await post(`team/members/${helper.id}/remove`, {}, { token: ok.body.token });
  assert.equal((await get("team/line", { token: helperToken })).body.error, "team_sign_in", "taken off the list: refused at once");
});

test("the team's line: details only behind the team token; green and red with a check that nobody else changed it; undo; texted is kept", async () => {
  const token = await teamToken();
  const a = await guest("Ana Ruiz", "ana@example.com");
  const lineRes = await get("team/line", { token });
  const row = lineRes.body.sessions.find((s) => s.code === a.body.session.code);
  assert.deepEqual(row.guests.map((g) => [g.name, g.phone, g.email, g.city]), [["Ana Ruiz", "5550102030", "ana@example.com", "Brooklyn"]], "the team sees what was filled in");
  const toBooth = await post(`team/sessions/${row.id}/status`, { status: "booth", from: "waiting" }, { token });
  assert.equal(toBooth.body.session.status, "booth");
  const stale = await post(`team/sessions/${row.id}/status`, { status: "out", from: "waiting" }, { token });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.status, "booth", "a second phone's stale tap is refused, with what it is now");
  const undo = await post(`team/sessions/${row.id}/status`, { status: "waiting", from: "booth" }, { token });
  assert.equal(undo.body.session.status, "waiting", "undo is the change back");
  const events = (await env.DB.prepare("SELECT from_status, to_status FROM party_status_events WHERE session_id = ?1 ORDER BY id").bind(row.id).all()).results;
  assert.deepEqual(events.map((e) => `${e.from_status}>${e.to_status}`), ["waiting>booth", "booth>waiting"], "every change is a row");
  const t = await post(`team/sessions/${row.id}/texted`, {}, { token });
  assert.ok(t.body.texted_at);
  assert.equal((await get("team/line", { token })).body.sessions.find((s) => s.id === row.id).texted_at, t.body.texted_at, "still there on the next read (any device)");
});

test("contest verdict: one box never speaks for the group; Scooter Taylor and test files in production are refused", () => {
  const track = { file_name: "Jingle.mp3" };
  const p = (name, inn) => ({ name, contest_opt_in: inn ? 1 : 0 });
  assert.equal(contestVerdict({ track, people: [] }).reason, "nobody_attached");
  assert.equal(contestVerdict({ track, people: [p("Jay A", 1), p("Mo B", 0), p("Kim C", 0)] }).reason, "not_everyone_in");
  assert.deepEqual(contestVerdict({ track, people: [p("Jay A", 1), p("Mo B", 1), p("Kim C", 0)] }).waiting_on, ["Kim"]);
  assert.equal(contestVerdict({ track, people: [p("Jay A", 1), p(null, 1)] }).reason, "not_signed_up", "everyone on it signed up");
  assert.ok(contestVerdict({ track, people: [p("Jay A", 1), p("Mo B", 1)] }).ok);
  assert.equal(contestVerdict({ track: { file_name: "Scooter Taylor.mp3" }, people: [p("Jay A", 1)] }).reason, "scooter_taylor");
  assert.equal(contestVerdict({ track, people: [p("Scooter Taylor", 1)] }).reason, "scooter_taylor", "nor anyone on it");
  assert.equal(contestVerdict({ track: { file_name: "Jingle.mp3", title: "scootertaylor" }, people: [p("Jay A", 1)] }).reason, "scooter_taylor", "nor its title");
  assert.equal(contestVerdict({ track: { file_name: "Test - Jingle.mp3" }, people: [p("Jay A", 1)], production: true }).reason, "test_file_in_production");
  assert.ok(contestVerdict({ track: { file_name: "Test - Jingle.mp3" }, people: [p("Jay A", 1)], production: false }).ok, "preview takes test files");
  assert.equal(voteLabel({ title: "" }, [p("Jay A"), p("Mo B"), p("Kim C")]), "Jay, Mo & Kim");
  assert.equal(voteLabel({ title: " Sleigh  Ride " }, [p("Jay A")]), "Sleigh Ride");
  assert.equal(freshSlug("Jay & Mo", new Set(["jay-mo"])), "jay-mo-2");
});

test("the group song: tagged at upload; two of three ticked is NOT in the vote, the third enters it for everyone; one unticks and it leaves", async () => {
  const token = await teamToken();
  const jay = await guest("Jay Holly", "jay.h@example.com");
  const code = jay.body.session.code;
  const mo = await guest("Mo Ivy", "mo.i@example.com", { session_code: code });
  const kim = await guest("Kim Fir", "kim.f@example.com", { session_code: code });
  const key = { "jay.h@example.com": jay.body.guest_key, "mo.i@example.com": mo.body.guest_key, "kim.f@example.com": kim.body.guest_key };
  assert.equal((await markBooth(code, token)).status, 200);
  const groups = (await call(booth.onRequest, env, { path: "/api/booth/sessions", params: { path: ["sessions"] } })).body.sessions;
  const g = groups.find((x) => x.names === "Jay, Mo & Kim");
  assert.ok(g && g.size === 3, JSON.stringify(groups));
  assert.ok(!/@|Holly|Ivy|Fir/.test(JSON.stringify(groups)), "first names only on the open booth page");
  const up = await upload("Jingle Bars.mp3", { "x-party-session": String(g.id) });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal(up.body.tagged, true);
  const songCode = up.body.code;
  const view = await B(songCode, "contest-status", { email: "mo.i@example.com" });
  assert.equal(view.status, 200, view.text);
  assert.deepEqual(view.body.contest.people.map((p) => [p.first_name, p.in]), [["Jay", false], ["Mo", false], ["Kim", false]], "all three are on the song before anyone opens /track");
  assert.equal(view.body.contest.rules_url, "/holiday-rules");
  assert.ok(!/@/.test(JSON.stringify(view.body.contest.people)), "no email for anyone");
  // The box starts unticked; ticking needs the rules agreement.
  assert.equal((await B(songCode, "contest", { email: "jay.h@example.com", enter: true })).body.error, "agree_required");
  // One phone cannot tick a friend's box: Jay's key with Mo's email, or no key at all, is refused.
  for (const tick of [{ email: "mo.i@example.com", guest_key: key["jay.h@example.com"] }, { email: "mo.i@example.com" }, { email: "kim.f@example.com", guest_key: "0".repeat(24) }]) {
    const r = await B(songCode, "contest", { ...tick, enter: true, agree: true });
    assert.equal(r.status, 403, JSON.stringify(tick));
    assert.equal(r.body.error, "not_your_sign_up");
  }
  assert.deepEqual((await B(songCode, "contest-status", { email: "mo.i@example.com" })).body.contest.people.map((p) => p.in), [false, false, false], "a refused tick changes nobody's box");
  await B(songCode, "contest", { email: "jay.h@example.com", enter: true, agree: true, guest_key: key["jay.h@example.com"] });
  const two = await B(songCode, "contest", { email: "mo.i@example.com", enter: true, agree: true, guest_key: key["mo.i@example.com"] });
  assert.equal(two.body.contest.entered, false);
  assert.deepEqual(two.body.contest.waiting_on, ["Kim"]);
  const label = () => env.DB.prepare("SELECT t.label, t.active FROM tracks t JOIN booth_tracks b ON b.vote_track_id = t.id WHERE b.code = ?1").bind(songCode).first();
  assert.equal(await label(), null, "two of three: not in the vote");
  assert.ok(!(await stateNow()).tracks.some((t) => t.label === "Jay, Mo & Kim"));
  // Even with two of the three ticked, Jay's phone cannot tick for Kim.
  assert.equal((await B(songCode, "contest", { email: "kim.f@example.com", enter: true, agree: true, guest_key: key["jay.h@example.com"] })).body.error, "not_your_sign_up");
  assert.equal(await label(), null, "still out");
  const three = await B(songCode, "contest", { email: "kim.f@example.com", enter: true, agree: true, guest_key: key["kim.f@example.com"] });
  assert.equal(three.body.contest.entered, true);
  assert.deepEqual(await label(), { label: "Jay, Mo & Kim", active: 1 });
  assert.ok((await stateNow()).tracks.some((t) => t.label === "Jay, Mo & Kim"), "it shows in the vote, with no script run");
  const recorded = (await env.DB.prepare("SELECT contest_at, rules_version FROM booth_people p JOIN booth_tracks b ON b.id = p.track_id WHERE b.code = ?1").bind(songCode).all()).results;
  assert.ok(recorded.every((r) => r.contest_at > 0 && r.rules_version === "holiday-2026-draft-1"), "each tick records when, and which rules");
  // A title anyone on it sets is its name in the vote.
  const titled = await B(songCode, "title", { email: "kim.f@example.com", title: "Sleigh Bars" });
  assert.equal(titled.body.title, "Sleigh Bars");
  assert.equal((await label()).label, "Sleigh Bars");
  // One steps out: it leaves the vote for everyone, likes kept.
  // Nobody steps a friend out: an untick without Mo's own sign-up key, or with Jay's, is refused and the song stays in.
  assert.equal((await B(songCode, "contest", { email: "mo.i@example.com", enter: false })).body.error, "not_your_sign_up");
  assert.equal((await B(songCode, "contest", { email: "mo.i@example.com", enter: false, guest_key: key["jay.h@example.com"] })).body.error, "not_your_sign_up");
  assert.equal((await label()).active, 1, "a refused untick leaves the song in the vote");
  const outRes = await B(songCode, "contest", { email: "mo.i@example.com", enter: false, guest_key: key["mo.i@example.com"] });
  assert.equal(outRes.body.contest.entered, false);
  assert.equal((await label()).active, 0);
  assert.ok(!(await stateNow()).tracks.some((t) => t.label === "Sleigh Bars"));
  // Back in: the same track, the same slug.
  const slug = (await env.DB.prepare("SELECT t.slug FROM tracks t JOIN booth_tracks b ON b.vote_track_id = t.id WHERE b.code = ?1").bind(songCode).first()).slug;
  await B(songCode, "contest", { email: "mo.i@example.com", enter: true, agree: true, guest_key: key["mo.i@example.com"] });
  assert.equal((await env.DB.prepare("SELECT t.slug, t.active FROM tracks t JOIN booth_tracks b ON b.vote_track_id = t.id WHERE b.code = ?1").bind(songCode).first()).slug, slug);
  // Someone not on the song cannot tick or read it.
  assert.equal((await B(songCode, "contest", { email: "stranger@example.com", enter: true, agree: true })).body.error, "not_attached");
  assert.equal((await B(songCode, "contest-status", { email: "stranger@example.com" })).body.error, "not_attached");
});

test("the solo walk-up: enters the code, must sign up before the box counts; a stale group pick is refused; Scooter's file never goes in", async () => {
  const up = await upload("Solo Jingle.mp3");
  const code = up.body.code;
  const entered = await B(code, "enter", { email: "walkup@example.com" });
  assert.equal(entered.status, 200);
  assert.equal(entered.body.contest.on, true);
  assert.equal(entered.body.contest.you.in, false, "the box starts unticked");
  assert.equal(entered.body.contest.you.signed_up, false);
  assert.equal((await B(code, "contest", { email: "walkup@example.com", enter: true, agree: true })).body.error, "not_signed_up");
  const walk = (await guest("Walk Up", "walkup@example.com")).body.guest_key;
  assert.equal((await B(code, "contest", { email: "walkup@example.com", enter: true, agree: true })).body.error, "not_your_sign_up", "signed up, but the tick must come from the phone that signed up");
  const ok = await B(code, "contest", { email: "walkup@example.com", enter: true, agree: true, guest_key: walk });
  assert.equal(ok.body.contest.entered, true, "a solo artist enters with one tick");
  assert.equal((await upload("Other.mp3", { "x-party-session": "999999" })).body.error, "session_not_in_booth");
  const scooter = await upload("Scooter Taylor - Jingle.mp3");
  await B(scooter.body.code, "enter", { email: "walkup@example.com" });
  const refused = await B(scooter.body.code, "contest", { email: "walkup@example.com", enter: true, agree: true, guest_key: walk });
  assert.equal(refused.body.contest.entered, false);
  assert.equal(refused.body.contest.blocked, "scooter_taylor");
  assert.ok(!(await stateNow()).tracks.some((t) => /scooter/i.test(t.label)));
  // A test file in production: never.
  const prodEnv = { ...env, APP_ENV: "production" };
  const test1 = await upload("Test - Jingle.mp3", {}, prodEnv);
  await B(test1.body.code, "enter", { email: "walkup@example.com" }, freshIp(), prodEnv);
  const t = await B(test1.body.code, "contest", { email: "walkup@example.com", enter: true, agree: true, guest_key: walk }, freshIp(), prodEnv);
  assert.equal(t.body.contest.entered, false);
  assert.equal(t.body.contest.blocked, "test_file_in_production");
});

test("a late joiner takes the song out: a solo song in the vote leaves it when a second email enters the code, and comes back when they tick", async () => {
  const up = await upload("Late Joiner Jingle.mp3");
  const code = up.body.code;
  await B(code, "enter", { email: "first@example.com" });
  const k1 = (await guest("Fay First", "first@example.com")).body.guest_key;
  assert.equal((await B(code, "contest", { email: "first@example.com", enter: true, agree: true, guest_key: k1 })).body.contest.entered, true);
  const inVote = async () => (await stateNow()).tracks.some((t) => /Fay/.test(t.label));
  assert.equal(await inVote(), true, "the solo song is in the vote");
  const late = await B(code, "enter", { email: "late@example.com" });
  assert.equal(late.status, 200);
  assert.equal(late.body.contest.entered, false, "the newcomer is not spoken for by the first tick");
  assert.equal(await inVote(), false, "the song left the vote the moment someone new joined it");
  const k2 = (await guest("Lee Late", "late@example.com")).body.guest_key;
  const firstView = await B(code, "contest-status", { email: "first@example.com" });
  assert.equal(firstView.body.contest.entered, false);
  assert.deepEqual(firstView.body.contest.waiting_on, ["Lee"], "everyone sees who it waits on");
  assert.equal((await B(code, "enter", { email: "late@example.com" })).body.contest.entered, false, "entering the code again changes nothing");
  assert.equal((await B(code, "contest", { email: "late@example.com", enter: true, agree: true, guest_key: k2 })).body.contest.entered, true);
  assert.equal(await inVote(), true, "both ticked: back in");
  assert.equal((await B(code, "enter", { email: "first@example.com" })).body.contest.entered, true, "someone already on it re-entering the code keeps it in");
});

test("a stranger on a song is not a lock: the team sees a song stuck waiting (never entered too), removes someone who has not ticked, and it enters; a tick is never removed", async () => {
  const token = await teamToken();
  const up = await upload("Stranger Jingle.mp3");
  const code = up.body.code;
  await B(code, "enter", { email: "owner.s@example.com" });
  const k = (await guest("Sam Owner", "owner.s@example.com")).body.guest_key;
  assert.equal((await B(code, "contest", { email: "owner.s@example.com", enter: true, agree: true, guest_key: k })).body.contest.entered, true);
  // A plus-one types the code to hear it and never signs up: the song leaves the vote.
  await B(code, "enter", { email: "plusone@example.com" });
  assert.equal((await B(code, "contest-status", { email: "owner.s@example.com" })).body.contest.entered, false);
  const listed = (await get("team/songs", { token })).body.songs.find((s) => s.code === code);
  assert.ok(listed, "the stuck song is in front of the team");
  assert.equal(listed.entered, false);
  const stranger = listed.members.find((m) => !m.signed_up);
  const owner = listed.members.find((m) => m.first_name === "Sam");
  assert.ok(stranger && stranger.first_name === null && !JSON.stringify(listed).includes("plusone@"), "shown as not signed up, never by email");
  assert.equal((await post(`team/songs/${code}/people/${stranger.id}/remove`, {})).body.error, "team_sign_in", "only the team removes");
  const ticked = await post(`team/songs/${code}/people/${owner.id}/remove`, {}, { token });
  assert.equal(ticked.status, 409, ticked.text);
  assert.equal(ticked.body.error, "ticked", "a person who ticked is never removed by the team");
  const closedEnv = { ...env, VOTING_ENDS_AT: "2020-06-01T00:00:00Z" };
  assert.equal((await post(`team/songs/${code}/people/${stranger.id}/remove`, {}, { token, e: closedEnv })).body.error, "voting_closed");
  const removed = await post(`team/songs/${code}/people/${stranger.id}/remove`, {}, { token });
  assert.equal(removed.status, 200, removed.text);
  assert.equal(removed.body.song.entered, true, "judged again on the people left: back in the vote");
  assert.equal(removed.body.song.people, 1);
  assert.ok((await stateNow()).tracks.some((t) => /Sam/.test(t.label)), "in the vote again");
  assert.equal((await B(code, "contest-status", { email: "owner.s@example.com" })).body.contest.entered, true, "everyone on it sees Entered");
  assert.equal((await post(`team/songs/${code}/people/${stranger.id}/remove`, {}, { token })).status, 404, "removing twice says they are gone");
  // A song that never entered is listed too: a session-less song with a signed-up person on it.
  const up2 = await upload("Never Entered.mp3");
  await B(up2.body.code, "enter", { email: "owner.s@example.com" });
  await B(up2.body.code, "enter", { email: "typo@example.com" });
  const stuck = (await get("team/songs", { token })).body.songs.find((s) => s.code === up2.body.code);
  assert.ok(stuck && stuck.entered === false && stuck.members.length === 2, "a song that has never been in the vote is listed with its people");
});

test("after voting ends nothing moves: the box and the title answer 403 voting_closed", async () => {
  const closedEnv = { ...env, VOTING_ENDS_AT: "2020-06-01T00:00:00Z" };
  const up = await upload("Late.mp3");
  await B(up.body.code, "enter", { email: "late@example.com" });
  const lateKey = (await guest("Late Comer", "late@example.com")).body.guest_key;
  assert.equal((await B(up.body.code, "contest", { email: "late@example.com", enter: true, agree: true, guest_key: lateKey }, freshIp(), closedEnv)).body.error, "voting_closed");
  assert.equal((await B(up.body.code, "title", { email: "late@example.com", title: "x" }, freshIp(), closedEnv)).body.error, "voting_closed");
});

test("the team's safety valve: Take out of the vote from /team holds even if everyone ticks again; Put back re-enters; likes kept; team only", async () => {
  const token = await teamToken();
  const up = await upload("Valve Jingle.mp3");
  const code = up.body.code;
  await B(code, "enter", { email: "valve@example.com" });
  const k = (await guest("Val Ve", "valve@example.com")).body.guest_key;
  assert.equal((await B(code, "contest", { email: "valve@example.com", enter: true, agree: true, guest_key: k })).body.contest.entered, true);
  const voteId = (await env.DB.prepare("SELECT vote_track_id FROM booth_tracks WHERE code = ?1").bind(code).first()).vote_track_id;
  const iso = new Date().toISOString();
  const voter = await env.DB.prepare("INSERT INTO voters (name, email, email_key, city, created_at) VALUES ('Liker', 'liker.valve@example.com', 'liker.valve@example.com', 'Bronx', ?1) RETURNING id").bind(iso).first();
  await env.DB.prepare("INSERT INTO like_events (track_id, voter_id, action, created_at) VALUES (?1, ?2, 'like', ?3)").bind(voteId, voter.id, iso).run();
  const likesBefore = 1;
  const listed = (await get("team/songs", { token })).body.songs.find((s) => s.code === code);
  const { members, ...rest } = listed;
  assert.deepEqual(rest, { code, label: "Val", entered: true, pulled: false, pulled_at: null, people: 1, ticked: 1 }, "the team sees the song, in, with counts");
  assert.equal(members.length, 1);
  assert.deepEqual(Object.keys(members[0]).sort(), ["attached_at", "first_name", "id", "in", "signed_up"], "first names and boxes, never an email");
  assert.equal(members[0].first_name, "Val");
  assert.equal((await post(`team/songs/${code}/pull`, { pulled: true })).body.error, "team_sign_in", "only the team pulls a song");
  assert.equal((await post(`team/songs/${code}/pull`, {}, { token })).body.error, "bad_pull");
  assert.equal((await post("team/songs/9999/pull", { pulled: true }, { token })).status, 404);
  const pulled = await post(`team/songs/${code}/pull`, { pulled: true }, { token });
  assert.equal(pulled.status, 200, pulled.text);
  assert.equal(pulled.body.song.entered, false);
  assert.equal(pulled.body.song.pulled, true);
  assert.ok(!(await stateNow()).tracks.some((t) => t.label === "Val"), "out of the vote at once");
  // Everyone ticking again does not put it back: only the team does.
  await B(code, "contest", { email: "valve@example.com", enter: false, guest_key: k });
  const again = await B(code, "contest", { email: "valve@example.com", enter: true, agree: true, guest_key: k });
  assert.equal(again.body.contest.entered, false);
  assert.equal(again.body.contest.blocked, "pulled_by_team", "the person on the song sees that the team took it out");
  assert.equal((await env.DB.prepare("SELECT active FROM tracks WHERE id = ?1").bind(voteId).first()).active, 0);
  const back = await post(`team/songs/${code}/pull`, { pulled: false }, { token });
  assert.equal(back.body.song.entered, true, "put back: in again, since everyone still has the box ticked");
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM like_events WHERE track_id = ?1").bind(voteId).first()).n, likesBefore, "likes kept");
  const closedEnv = { ...env, VOTING_ENDS_AT: "2020-06-01T00:00:00Z" };
  assert.equal((await post(`team/songs/${code}/pull`, { pulled: true }, { token, e: closedEnv })).body.error, "voting_closed");
});

test("gallery GIFs: the team adds and removes; /api/state carries them while the party is on", async () => {
  const token = await teamToken();
  assert.equal((await post("team/gifs", { id: "abc123", url: "https://evil.example/x.gif" }, { token })).body.error, "bad_gif");
  for (const id of ["gifone", "giftwo", "gifthree"]) await post("team/gifs", { id, url: `https://media.giphy.com/media/${id}/giphy.gif`, width: 480, height: 270, title: "Snow" }, { token });
  assert.deepEqual((await stateNow()).gifs.map((g) => g.id), ["gifone", "giftwo", "gifthree"]);
  await post("team/gifs/giftwo/remove", {}, { token });
  assert.deepEqual((await get("team/gifs", { token })).body.gifs.map((g) => g.id), ["gifone", "gifthree"]);
  assert.deepEqual((await stateNow()).gifs.map((g) => g.id), ["gifone", "gifthree"]);
  assert.equal((await post("team/gifs", { id: "gifx", url: "https://media.giphy.com/x.gif" })).body.error, "team_sign_in", "only the team adds GIFs");
});

test("privacy: no route but the team's answers a phone or an email of a guest; the tables are read only where they should be", () => {
  const src = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
  const partyRoute = src("functions/api/party/[[path]].js");
  // The one SELECT that reads phone and email is the team's line, behind requireMember.
  assert.equal([...partyRoute.matchAll(/LINE_GUESTS_SQL/g)].length, 2, "imported once, read once");
  assert.match(partyRoute, /async function line\(context\)/);
  assert.match(partyRoute, /const m = await member\(context\);\n    if \(parts\.length === 2 && parts\[1\] === "line"\) return line\(context\);/, "the line is read only after the team check");
  for (const file of ["functions/_lib/state.js", "functions/api/state.js", "functions/_lib/tally.js", "scripts/export.mjs", "functions/api/beats.js"]) assert.ok(!/party_guests|team_members/.test(src(file)), `${file} never reads the guests or the team`);
  assert.ok(!/party_guests|phone/.test(src("functions/api/booth/[[path]].js")), "the booth route reads names through contest.js only, never a phone");
});
