// The holiday party (Scooter, 17 Nov 2026, and his consolidated revision list of 18 Nov 2026): the
// QR sign-up (one person each), the team's line with its four lanes and sign-in, the ambassador's
// taps making the recording (take) a song lands on, the song's controls held by everyone on it on /track and going
// into the vote by itself, the team's re-point, the gallery GIFs, verified-only counts, the end (27 Nov 2026, 11:59 PM ET)
// and the switch. Against a real local D1 and R2.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import * as booth from "../functions/api/booth/[[path]].js";
import * as party from "../functions/api/party/[[path]].js";
import * as state from "../functions/api/state.js";
import { VERIFICATION, sendBudget, voterSendBudget } from "../functions/_lib/config.js";
import { contestVerdict, freshSlug, voteLabel } from "../functions/_lib/contest.js";
import { cleanInstagram, groupLabel, guestFlags, isSessionCode, laneOf, lineOrder, parseSignUp, randomSessionCode } from "../functions/_lib/party.js";
import { signTeamToken, verifyTeamToken } from "../functions/_lib/team.js";
import { signVoterToken } from "../functions/_lib/token.js";
import { _resetStateMemo } from "../functions/api/state.js";
import { ROOT, call, freshIp, makeEnv, withRealEnd } from "./helpers.mjs";

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
const slot = (name, email) => ({ name, phone: "(555) 010-2030", email, city: "Brooklyn", instagram: "" });
const guest = (name, email, extra = {}) => post("join", { ...slot(name, email), website: "", ...extra });
// Everyone signs up on their own: [[name, email], …] → each one's sign-up.
const signUps = async (people) => { for (const [n, e] of people) assert.equal((await guest(n, e)).status, 201, `${n} signs up`); };
const B = (code, what, body, ip = freshIp(), e = env) => call(booth.onRequest, e, { method: "POST", path: `/api/booth/tracks/${code}/${what}`, ip, body, params: { path: ["tracks", code, what] } });
// The booth page's upload: it says which take the upload station showed and the engineer confirmed
// (its key, read here as the page reads it), unless the test gives its own.
async function upload(name = "Holiday Jingle.mp3", headers = {}, e = env) {
  const bytes = new Uint8Array(1024).fill(7);
  const shown = e.HOLIDAY_EVENT === "on" && !("x-party-take" in headers) ? { "x-party-take": String((await station()).next?.key ?? "none") } : {};
  const h = new Headers({ "cf-connecting-ip": freshIp(), "x-file-name": name, "content-type": "audio/mpeg", "content-length": String(bytes.byteLength), ...shown, ...headers });
  const res = await booth.onRequest({ request: new Request("https://voting.test/api/booth/tracks", { method: "POST", headers: h, body: bytes }), env: e, params: { path: ["tracks"] }, waitUntil: () => {} });
  return { status: res.status, body: await res.json() };
}
async function teamToken(email = "lead@example.com") {
  const row = await env.DB.prepare("INSERT INTO team_members (email, added_at) VALUES (?1, ?2) ON CONFLICT (email) DO UPDATE SET removed_at = NULL RETURNING id").bind(email, Date.now()).first();
  return signTeamToken(env, row.id, Math.floor(Date.now() / 1000));
}
const stateNow = async () => { _resetStateMemo(); return (await call(state.onRequest, env, { path: "/api/state" })).body; };
const sessionOf = async (email) => (await env.DB.prepare("SELECT session_id FROM party_guests WHERE email = ?1").bind(email).first()).session_id;
const move = async (email, from, status, token) => post(`team/sessions/${await sessionOf(email)}/status`, { status, from }, { token });
// Each test starts with nobody in the booth or at the upload station (earlier tests leave people there).
async function clearStation() {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("UPDATE party_sessions SET status = 'out', done_at = ?1 WHERE done_at IS NULL AND status IN ('booth', 'out')").bind(now),
    env.DB.prepare("UPDATE party_takes SET closed_at = COALESCE(closed_at, ?1), track_id = COALESCE(track_id, -1) WHERE track_id IS NULL").bind(now),
  ]);
}
// The ambassador taps everyone in, then everyone out: one recording (take), at the upload station.
async function recording(emails, token) {
  for (const e of emails) assert.equal((await move(e, "waiting", "booth", token)).status, 200, `${e} in`);
  for (const e of emails) assert.equal((await move(e, "booth", "upload", token)).status, 200, `${e} out`);
}
const station = async () => (await call(booth.onRequest, env, { path: "/api/booth/sessions", params: { path: ["sessions"] } })).body;
const songPeople = async (code) => (await env.DB.prepare("SELECT p.email, p.guest_id FROM booth_people p JOIN booth_tracks b ON b.id = p.track_id WHERE b.code = ?1 ORDER BY p.attached_at, p.id").bind(code).all()).results;
const guestId = async (email) => (await env.DB.prepare("SELECT id FROM party_guests WHERE email = ?1").bind(email).first()).id;
const inVote = async (label) => (await stateNow()).tracks.some((t) => t.label === label);

test("rules: a sign-up is one person, with name, phone, email and city; Instagram is optional; a test or an old sign-up is flagged", () => {
  for (let i = 0; i < 300; i++) assert.ok(isSessionCode(randomSessionCode()));
  assert.ok(!/[IO0-9]/.test([...Array(300)].map(() => randomSessionCode()).join("")), "the place's own id has no look-alike characters");
  const ok = parseSignUp({ name: " Jay  Smith ", phone: "+1 555 010 2030", email: "Jay@Example.com", city: "Brooklyn", instagram: "@jay.bars" });
  assert.deepEqual(ok.value, { guests: [{ name: "Jay Smith", phone: "+15550102030", email: "jay@example.com", city: "Brooklyn", instagram: "@jay.bars" }] });
  const base = { name: "A", phone: "5550102030", email: "a@b.co", city: "X" };
  for (const [field, body] of [["name", { name: "" }], ["phone", { phone: "call me" }], ["email", { email: "nope" }], ["city", { city: " " }], ["instagram", { instagram: "not a handle!" }], ["website", { website: "bot" }]]) {
    assert.equal(parseSignUp({ ...base, ...body }).field, field, field);
  }
  // No group setup on the guest side (Scooter, 18 Nov 2026): a list of several people is refused.
  assert.equal(parseSignUp({ guests: [base, { ...base, email: "b@b.co" }] }).error, "one_person");
  assert.deepEqual(parseSignUp({ guests: [base] }).value.guests.map((g) => g.email), ["a@b.co"], "a list of one is that one person");
  assert.equal(cleanInstagram("https://instagram.com/jay_b/"), "@jay_b");
  assert.equal(groupLabel(["Jay"]), "Jay");
  assert.equal(groupLabel(["Jay", "Mo"]), "Jay & Mo");
  assert.equal(groupLabel(["Jay", "Mo", "Kim"]), "Jay, Mo & Kim");
  const now = Date.parse("2026-12-13T22:00:00Z");
  assert.deepEqual(guestFlags({ name: "Test Ava", email: "ava@gmail.com", joined_at: now }, now), ["test"], "a Test … name");
  assert.deepEqual(guestFlags({ name: "Ava Real", email: "ava@example.com", joined_at: now }, now), ["test"], "a test address");
  assert.deepEqual(guestFlags({ name: "Ava Real", email: "test.ava@gmail.com", joined_at: now }, now), ["test"]);
  assert.deepEqual(guestFlags({ name: "Ava Real", email: "ava@gmail.com", joined_at: now - 13 * 3600e3 }, now), ["stale"], "made more than 12 hours ago");
  assert.deepEqual(guestFlags({ name: "Ava Real", email: "ava@gmail.com", joined_at: now - 3600e3 }, now), [], "a real, fresh sign-up has no flag");
  assert.deepEqual(guestFlags({ name: "Testa Rossa", email: "testa@gmail.com", joined_at: now }, now).length, 1, "a name that only starts with the letters is a real name… unless its address is test-like");
});

test("the switch: off (production until go-live), every party route answers 404 party_off and state is unchanged", async () => {
  const offEnv = { ...env, HOLIDAY_EVENT: "off" };
  assert.deepEqual((await get("", { e: offEnv })).body, { on: false });
  assert.deepEqual((await get("")).body, { on: true });
  for (const r of ["join", "me", "rejoin", "move", "team/code", "team/verify"]) assert.equal((await post(r, {}, { e: offEnv })).body.error, "party_off", r);
  assert.equal((await get("team/line", { e: offEnv })).body.error, "party_off");
  assert.deepEqual((await call(booth.onRequest, offEnv, { path: "/api/booth/sessions", params: { path: ["sessions"] } })).body, { on: false, next: null, queued: 0, in_booth: [] });
  _resetStateMemo();
  const s = (await call(state.onRequest, offEnv, { path: "/api/state" })).body;
  assert.ok(!("holiday" in s) && !("gifs" in s), "production's /api/state carries nothing new");
  const { buildState } = await import("../functions/_lib/state.js");
  assert.equal((await buildState(withRealEnd(offEnv))).voting_ends_at, "2026-10-12T06:59:00.000Z", "production's end is the constant, as before");
  const toml = fs.readFileSync(path.join(ROOT, "wrangler.toml"), "utf8");
  const [prod, preview] = toml.split("[env.preview.vars]");
  assert.match(prod, /\nHOLIDAY_EVENT = "off"\n/, "production is off");
  assert.match(preview, /\nHOLIDAY_EVENT = "on"\n/, "preview is on");
});

test("sign-up, one person each: one active place per email, refused with where they are; back in line in one tap once done, on the same record", async () => {
  const token = await teamToken();
  await clearStation();
  const a = await guest("Jay Smith", "jay@example.com");
  assert.equal(a.status, 201, a.text);
  assert.deepEqual([a.body.session.names, a.body.session.size, a.body.session.status], [["Jay"], 1, "waiting"]);
  assert.ok(Number.isInteger(a.body.session.place) && a.body.session.place >= 1);
  const sid = await sessionOf("jay@example.com");
  const row = (await get("team/line", { token })).body.sessions.find((s) => s.id === sid);
  assert.deepEqual(row.guests.map((g) => [g.name, g.email, g.phone]), [["Jay Smith", "jay@example.com", "5550102030"]], "the team sees what was filled in");
  assert.deepEqual(row.guests[0].flags, ["test"], "an example.com address is flagged for the team");
  // Privacy: the sign-up phone is answered a first name and the place, never a phone, an email or a last name.
  assert.ok(!/555|@|Smith|Brooklyn/.test(JSON.stringify({ ...a.body, guest_key: "" })), JSON.stringify(a.body));
  assert.equal((await post("me", { guest_key: "0".repeat(24) })).body.error, "no_guest");
  // A group on one phone is no more.
  const many = await post("join", { guests: [slot("Zed One", "zed1@example.com"), slot("Zed Two", "zed2@example.com")], website: "" });
  assert.deepEqual([many.status, many.body.error], [400, "one_person"]);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM party_guests WHERE email LIKE 'zed%'").first()).n, 0);
  // One active place per person, said in words, never a silent block.
  const again = await guest("Jay Smith", "JAY@example.com");
  assert.deepEqual([again.status, again.body.error], [409, "already_in_line"]);
  assert.match(again.body.message, /This email already has a place in line\. One place at a time: as soon as your song is uploaded you can get back in line here\./);
  await move("jay@example.com", "waiting", "booth", token);
  assert.match((await guest("Jay Smith", "jay@example.com")).body.message, /^You're in the booth right now with this email\./);
  await move("jay@example.com", "booth", "upload", token);
  assert.match((await guest("Jay Smith", "jay@example.com")).body.message, /^You're just out of the booth with this email: the engineer is saving your song\./);
  const early = await post("rejoin", { guest_key: a.body.guest_key });
  assert.deepEqual([early.status, early.body.error], [409, "already_in_line"], "Get back in line waits for the song");
  assert.match(early.body.message, /You can get back in line once it is uploaded/);
  // The song is uploaded: one tap, back in line, the same record and details.
  assert.equal((await upload("Jay Solo.mp3")).body.tagged, true);
  assert.equal((await post("me", { guest_key: a.body.guest_key })).body.session.status, "done");
  const back = await post("rejoin", { guest_key: a.body.guest_key });
  assert.equal(back.status, 201, back.text);
  assert.deepEqual([back.body.session.status, back.body.you.first_name], ["waiting", "Jay"]);
  assert.notEqual(await sessionOf("jay@example.com"), sid, "a new place");
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM party_guests WHERE email = 'jay@example.com'").first()).n, 1, "still one record per person");
  assert.equal((await post("me", { guest_key: a.body.guest_key })).body.error, "no_guest", "the old key is replaced by the new one");
  assert.equal((await post("me", { guest_key: back.body.guest_key })).body.session.status, "waiting");
  const visits = (await env.DB.prepare("SELECT v.session_id FROM party_visits v JOIN party_guests g ON g.id = v.guest_id WHERE g.email = 'jay@example.com' ORDER BY v.id").all()).results;
  assert.deepEqual(visits.map((v) => v.session_id === sid), [true, false], "both visits kept");
  // Signing up again by hand once done works too (a new phone): the same record.
  await move("jay@example.com", "waiting", "booth", token);
  await move("jay@example.com", "booth", "upload", token);
  await move("jay@example.com", "upload", "done", token);
  assert.equal((await guest("Jay Smith", "jay@example.com")).status, 201);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM party_guests WHERE email = 'jay@example.com'").first()).n, 1);
});

test("the line: the group in the booth first, then waiting in join order with places, then the upload station (longest out first), then done; empty sessions are left out", () => {
  const s = (id, status, created_at, n = 1, status_at = 0, done_at = null) => ({ id, status, created_at, status_at, done_at, guests: Array.from({ length: n }, () => ({})) });
  const order = lineOrder([s(1, "out", 1, 1, 50, 70), s(2, "waiting", 5, 2), s(3, "booth", 9, 3, 60), s(4, "waiting", 3, 1), s(5, "waiting", 2, 0), s(6, "out", 4, 2, 40), s(7, "out", 6, 1, 30)]);
  assert.deepEqual(order.map((x) => [x.id, x.lane, x.place]), [[3, "booth", 0], [4, "waiting", 1], [2, "waiting", 2], [7, "upload", null], [6, "upload", null], [1, "done", null]]);
  assert.equal(laneOf({ status: "out", done_at: null }), "upload");
  assert.equal(laneOf({ status: "out", done_at: 5 }), "done");
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

test("team sign-in: a resend never kills the first email's code, and a send refused for the 60 s wait says no email went", async () => {
  const id = (await env.DB.prepare("INSERT INTO team_members (email, added_at) VALUES ('slow@example.com', ?1) ON CONFLICT (email) DO UPDATE SET removed_at = NULL RETURNING id").bind(Date.now()).first()).id;
  await env.DB.prepare("DELETE FROM team_code_sends WHERE member_id = ?1").bind(id).run();
  const before = mailbox.length;
  assert.equal((await post("team/code", { email: "slow@example.com" })).body.sent, true);
  const soon = await post("team/code", { email: "slow@example.com" });
  assert.equal(soon.status, 200);
  assert.equal(soon.body.sent, false, "inside the 60 s wait: no new email, and the answer says so");
  assert.equal(mailbox.length, before + 1, "nothing sent inside the wait");
  await env.DB.prepare("UPDATE team_code_sends SET sent_at = sent_at - 61 WHERE member_id = ?1").bind(id).run();
  assert.equal((await post("team/code", { email: "slow@example.com" })).body.sent, true);
  assert.equal(mailbox.length, before + 2);
  const codeOf = (m) => /(\d{6})/.exec(m.subject)[1];
  const [first, second] = [codeOf(mailbox.at(-2)), codeOf(mailbox.at(-1))];
  if (first !== second) {
    const ok = await post("team/verify", { email: "slow@example.com", code: first });
    assert.equal(ok.status, 200, `the FIRST email's code still signs in after a resend: ${ok.text}`);
    assert.match(ok.body.token, /^t1\./);
    assert.equal((await post("team/verify", { email: "slow@example.com", code: second })).body.error, "code_expired", "signing in uses both codes up");
  }
  // An earlier code past its own 10 minutes is refused.
  await env.DB.prepare("UPDATE team_code_sends SET sent_at = sent_at - 3600 WHERE member_id = ?1").bind(id).run();
  await post("team/code", { email: "slow@example.com" });
  await env.DB.prepare("UPDATE team_code_sends SET sent_at = sent_at - 61 WHERE member_id = ?1").bind(id).run();
  await post("team/code", { email: "slow@example.com" });
  const [old, fresh] = [codeOf(mailbox.at(-2)), codeOf(mailbox.at(-1))];
  await env.DB.prepare("UPDATE team_codes SET prev_expires_at = ?2 WHERE member_id = ?1").bind(id, Math.floor(Date.now() / 1000) - 1).run();
  if (old !== fresh) assert.equal((await post("team/verify", { email: "slow@example.com", code: old })).body.error, "wrong_code");
  assert.equal((await post("team/verify", { email: "slow@example.com", code: fresh })).status, 200);
  await env.DB.prepare("DELETE FROM team_code_sends").run();
});

test("team sign-in: when the day's code emails are used up, the screen names the wait (never 'a little while') and nothing is sent", async () => {
  await env.DB.prepare("DELETE FROM team_code_sends").run();
  await env.DB.prepare("DELETE FROM email_sends").run();
  const id = (await env.DB.prepare("INSERT INTO team_members (email, added_at) VALUES ('budget@example.com', ?1) ON CONFLICT (email) DO UPDATE SET removed_at = NULL RETURNING id").bind(Date.now()).first()).id;
  const nowS = Math.floor(Date.now() / 1000);
  const share = sendBudget(env);
  assert.ok(sendBudget({ APP_ENV: "preview" }) >= 15, "the preview's share covers a partner signing in on several devices");
  // Spent across the day by other members, the oldest 20 hours ago: it rolls off in about 4 hours.
  for (let i = 0; i < share; i++) await env.DB.prepare("INSERT INTO team_code_sends (member_id, sent_at) VALUES (?1, ?2)").bind(id, nowS - 20 * 3600 + i * 60).run();
  const before = mailbox.length;
  const res = await post("team/code", { email: "budget@example.com" });
  assert.equal(res.status, 429, res.text);
  assert.equal(res.body.error, "code_budget");
  assert.ok(res.body.retry_after_seconds > 3.5 * 3600 && res.body.retry_after_seconds <= 4 * 3600, String(res.body.retry_after_seconds));
  assert.match(res.body.message, /about 4 hours/);
  assert.equal(mailbox.length, before, "nothing sent over the budget");
  await env.DB.prepare("DELETE FROM team_code_sends").run();
});

test("team sign-in: voters' codes can never spend the team's reserve; the team's own sends stop at the share", async () => {
  await env.DB.prepare("DELETE FROM team_code_sends").run();
  await env.DB.prepare("DELETE FROM email_sends").run();
  const id = (await env.DB.prepare("INSERT INTO team_members (email, added_at) VALUES ('reserve@example.com', ?1) ON CONFLICT (email) DO UPDATE SET removed_at = NULL RETURNING id").bind(Date.now()).first()).id;
  const nowS = Math.floor(Date.now() / 1000);
  const share = sendBudget(env);
  assert.ok(VERIFICATION.teamReserve >= 3 && voterSendBudget(env) === share - VERIFICATION.teamReserve);
  // The voters' codes have used everything they may: the vote being tested all day.
  await env.DB.prepare("INSERT OR IGNORE INTO voters (name, email, email_key, city, created_at) VALUES ('Filler', 'filler.team@example.com', 'filler.team@example.com', 'X', '2026-10-01T00:00:00.000Z')").run();
  const voter = (await env.DB.prepare("SELECT id FROM voters WHERE email_key = 'filler.team@example.com'").first()).id;
  for (let i = 0; i < voterSendBudget(env); i++) await env.DB.prepare("INSERT INTO email_sends (voter_id, sent_at) VALUES (?1, ?2)").bind(voter, nowS - 3 * 3600).run();
  const before = mailbox.length;
  const res = await post("team/code", { email: "reserve@example.com" });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.sent, true, "the team still gets its code");
  assert.equal(mailbox.length, before + 1);
  // The day as a whole still never passes the share: fill the rest and the next team code is refused.
  for (let i = voterSendBudget(env) + 1; i < share; i++) await env.DB.prepare("INSERT INTO team_code_sends (member_id, sent_at) VALUES (?1, ?2)").bind(id, nowS - 2 * 3600).run();
  await env.DB.prepare("UPDATE team_code_sends SET sent_at = ?1 WHERE member_id = ?2").bind(nowS - 2 * 3600, id).run();
  const over = await post("team/code", { email: "reserve@example.com" });
  assert.equal(over.status, 429, over.text);
  assert.equal(over.body.error, "code_budget");
  assert.equal(mailbox.length, before + 1, "nothing past the share");
  await env.DB.prepare("DELETE FROM team_code_sends").run();
  await env.DB.prepare("DELETE FROM email_sends").run();
});

test("the team's line: details only behind the team token; four lanes with a check that nobody else changed it; undo; texted is kept", async () => {
  const token = await teamToken();
  const a = await guest("Ana Ruiz", "ana@example.com");
  const id = await sessionOf("ana@example.com");
  const row = (await get("team/line", { token })).body.sessions.find((s) => s.id === id);
  assert.deepEqual(row.guests.map((g) => [g.name, g.phone, g.email, g.city]), [["Ana Ruiz", "5550102030", "ana@example.com", "Brooklyn"]], "the team sees what was filled in");
  assert.equal(row.status, "waiting");
  assert.equal(a.status, 201);
  const to = (status, from) => post(`team/sessions/${id}/status`, { status, from }, { token });
  assert.equal((await to("booth", "waiting")).body.session.status, "booth");
  const stale = await to("upload", "waiting");
  assert.equal(stale.status, 409);
  assert.equal(stale.body.status, "booth", "a second phone's stale tap is refused, with what it is now");
  assert.equal((await to("waiting", "booth")).body.session.status, "waiting", "undo is the change back");
  await to("booth", "waiting");
  assert.equal((await to("upload", "booth")).body.session.status, "upload", "red: out of the booth, to the upload station");
  assert.equal((await get("team/line", { token })).body.sessions.find((s) => s.id === id).status, "upload");
  assert.equal((await to("done", "booth")).status, 409, "a stale 'booth' seen is refused once it is at the upload station");
  assert.equal((await to("done", "upload")).body.session.status, "done");
  assert.equal((await to("upload", "done")).body.session.status, "upload", "done can be undone");
  assert.equal((await to("nowhere", "upload")).body.error, "bad_status");
  const events = (await env.DB.prepare("SELECT from_status, to_status FROM party_status_events WHERE session_id = ?1 ORDER BY id").bind(id).all()).results;
  assert.deepEqual(events.map((e) => `${e.from_status}>${e.to_status}`), ["waiting>booth", "booth>waiting", "waiting>booth", "booth>upload", "upload>done", "done>upload"], "every change is a row");
  const t = await post(`team/sessions/${id}/texted`, {}, { token });
  assert.ok(t.body.texted_at);
  assert.equal((await get("team/line", { token })).body.sessions.find((s) => s.id === id).texted_at, t.body.texted_at, "still there on the next read (any device)");
});

test("the takes: everyone tapped in for one song is one recording, together or one after another; the upload lands on exactly them, never on the next recording", async () => {
  const token = await teamToken();
  await clearStation();
  await signUps([["Ola First", "ola@gmail.com"], ["Bo Second", "bo@gmail.com"], ["Cy Next", "cy@gmail.com"], ["Di Later", "di@gmail.com"]]);
  assert.equal((await move("ola@gmail.com", "waiting", "booth", token)).status, 200);
  assert.equal((await move("bo@gmail.com", "waiting", "booth", token)).status, 200, "tapped in while Ola is in: no question, the same recording");
  const takeOf = async (e) => (await env.DB.prepare("SELECT take_id FROM party_sessions WHERE id = ?1").bind(await sessionOf(e)).first()).take_id;
  assert.ok(await takeOf("ola@gmail.com"));
  assert.equal(await takeOf("bo@gmail.com"), await takeOf("ola@gmail.com"));
  let st = await station();
  assert.deepEqual([st.next, st.in_booth, st.recording], [null, ["Ola", "Bo"], [{ first_name: "Ola", in_booth: true }, { first_name: "Bo", in_booth: true }]], "nobody at the upload station while they record; the booth page sees the whole group");
  assert.equal((await upload("Too Soon.mp3", { "x-party-take": "999.1" })).body.error, "take_changed", "an upload for a take the station does not show is refused");
  // Ola is out, Bo still in: the recording is not at the station yet, and the booth page shows both.
  await move("ola@gmail.com", "booth", "upload", token);
  st = await station();
  assert.deepEqual([st.next, st.recording], [null, [{ first_name: "Bo", in_booth: true }, { first_name: "Ola", in_booth: false }]], "half out is not out");
  await move("bo@gmail.com", "booth", "upload", token);
  st = await station();
  assert.deepEqual([st.next?.names, st.next?.size, st.queued, st.recording], ["Ola & Bo", 2, 0, []]);
  assert.equal(st.next.key, `${st.next.id}.2`, "the key the engineer confirms: the recording and how many are on it");
  assert.ok(!/@|First|Second|555/.test(JSON.stringify(st)), "first names only on the open booth page");
  const first = st.next.id;
  // Cy is next in while Ola & Bo's file is not saved yet: the server does not guess which song.
  const asked = await move("cy@gmail.com", "waiting", "booth", token);
  assert.deepEqual([asked.status, asked.body.error, asked.body.names], [409, "which_song", "Ola & Bo"], "the team is asked: same song or a new one");
  assert.equal(laneOf(await env.DB.prepare("SELECT status, done_at FROM party_sessions WHERE id = ?1").bind(await sessionOf("cy@gmail.com")).first()), "waiting", "and nothing moved");
  assert.equal((await post(`team/sessions/${await sessionOf("cy@gmail.com")}/status`, { status: "booth", from: "waiting", song: "maybe" }, { token })).body.error, "bad_song");
  assert.equal((await post(`team/sessions/${await sessionOf("cy@gmail.com")}/status`, { status: "booth", from: "waiting", song: "new" }, { token })).status, 200);
  assert.notEqual(await takeOf("cy@gmail.com"), first, "a new song: never Ola & Bo's");
  await move("cy@gmail.com", "booth", "upload", token);
  st = await station();
  assert.deepEqual([st.next.id, st.next.names, st.queued], [first, "Ola & Bo", 1], "the oldest first, Cy's waits behind it");
  assert.equal((await upload("Stale.mp3", { "x-party-take": "none" })).body.error, "take_changed", "a page that showed nobody is refused once someone is there");
  assert.equal((await upload("Short.mp3", { "x-party-take": `${first}.1` })).body.error, "take_changed", "a page that showed fewer people is refused");
  const up = await upload("Ola And Bo.mp3");
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal(up.body.tagged, true);
  assert.deepEqual(await songPeople(up.body.code), [{ email: "ola@gmail.com", guest_id: await guestId("ola@gmail.com") }, { email: "bo@gmail.com", guest_id: await guestId("bo@gmail.com") }], "exactly the recording's people, each by their one record");
  const line = (await get("team/line", { token })).body.sessions;
  for (const e of ["ola@gmail.com", "bo@gmail.com"]) {
    const id = await sessionOf(e);
    assert.equal(line.find((s) => s.id === id).status, "done", `${e}: the upload moves them to done`);
  }
  st = await station();
  assert.deepEqual([st.next?.names, st.queued], ["Cy", 0], "the station moves on to Cy's");
  const up2 = await upload("Cy Alone.mp3");
  assert.deepEqual((await songPeople(up2.body.code)).map((p) => p.email), ["cy@gmail.com"], "nobody from the earlier recording carries over");
  const ev = await env.DB.prepare("SELECT from_status, to_status, member_id FROM party_status_events WHERE session_id = ?1 ORDER BY id DESC LIMIT 1").bind(await sessionOf("cy@gmail.com")).first();
  assert.deepEqual(ev, { from_status: "upload", to_status: "done", member_id: 0 }, "the upload is on the line's record");
  // Undo moves: back to waiting takes a person off the recording; back in the booth opens it again.
  await move("di@gmail.com", "waiting", "booth", token);
  const diTake = await takeOf("di@gmail.com");
  await move("di@gmail.com", "booth", "waiting", token);
  assert.equal(await takeOf("di@gmail.com"), null, "back to waiting: off the recording");
  assert.equal((await station()).next, null, "an empty recording never reaches the station");
  assert.equal((await move("di@gmail.com", "waiting", "booth", token)).status, 200, "nobody on the open recording: no question");
  await move("di@gmail.com", "booth", "upload", token);
  assert.equal((await station()).next?.names, "Di");
  await move("di@gmail.com", "upload", "booth", token);
  assert.equal((await station()).next, null, "back in the booth: the recording is open again, off the station");
  assert.ok(diTake);
  await move("di@gmail.com", "booth", "upload", token);
  await move("di@gmail.com", "upload", "done", token);
  assert.equal((await station()).next, null, "Done, no song: nobody left to upload for");
  assert.equal((await move("di@gmail.com", "done", "upload", token)).status, 200, "an undo of Done, no song puts the recording back at the station");
  assert.equal((await station()).next?.names, "Di");
  const ola = await sessionOf("ola@gmail.com");
  const refused = await post(`team/sessions/${ola}/status`, { status: "upload", from: "done" }, { token });
  assert.deepEqual([refused.status, refused.body.error], [409, "already_uploaded"], "a song already uploaded is re-pointed, never re-uploaded over");
  await move("di@gmail.com", "upload", "done", token);
});

test("a group recording one after another (Scooter, 19 Nov 2026: \"When Carlos and Scooter go into the booth and leave one after the other, the upload should belong to both\"): one song, every one of them on it with the controls", async () => {
  const token = await teamToken();
  await clearStation();
  await signUps([["Carl Os", "carl.os@gmail.com"], ["Ken Verse", "ken.verse@gmail.com"], ["Next Group", "next.group@gmail.com"]]);
  // Carl records his verse and comes out; the booth is empty; Ken goes in for his verse of the same song.
  await move("carl.os@gmail.com", "waiting", "booth", token);
  await move("carl.os@gmail.com", "booth", "upload", token);
  assert.equal((await station()).next?.names, "Carl", "Carl alone is at the station for now");
  const same = await post(`team/sessions/${await sessionOf("ken.verse@gmail.com")}/status`, { status: "booth", from: "waiting", song: "same" }, { token });
  assert.equal(same.status, 200, same.text);
  let st = await station();
  assert.deepEqual([st.next, st.recording], [null, [{ first_name: "Carl", in_booth: false }, { first_name: "Ken", in_booth: true }]], "the song is back in the booth: off the station, the whole group on the booth page");
  await move("ken.verse@gmail.com", "booth", "upload", token);
  st = await station();
  assert.deepEqual([st.next?.names, st.next?.size], ["Carl & Ken", 2], "both, not just the last one out");
  const up = await upload("Carl And Ken.mp3");
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.deepEqual((await songPeople(up.body.code)).map((p) => p.email), ["carl.os@gmail.com", "ken.verse@gmail.com"], "the upload belongs to both");
  // Each of them opens it with their own email and the code, with the controls; an unrelated email does not.
  for (const e of ["carl.os@gmail.com", "ken.verse@gmail.com"]) {
    const c = (await B(up.body.code, "enter", { email: e })).body.contest;
    assert.deepEqual([c.you.performer, c.you.can_manage, c.access], [true, true, ["Carl", "Ken"]], e);
  }
  const stranger = (await B(up.body.code, "enter", { email: "plusone.stranger@gmail.com" })).body.contest;
  assert.deepEqual([stranger.you.performer, stranger.you.can_manage], [false, false], "an unrelated email hears and downloads only");
  // The upload ended that song: the next person in starts a new one, with no question.
  assert.equal((await move("next.group@gmail.com", "waiting", "booth", token)).status, 200);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM party_takes t JOIN party_sessions s ON s.take_id = t.id WHERE s.id = ?1 AND t.track_id IS NULL").bind(await sessionOf("next.group@gmail.com")).first()).n, 1, "a new recording");
  await move("next.group@gmail.com", "booth", "waiting", token);
});

test("stale and test sign-ups are flagged where the team picks who goes in: names, emails and phones on /team, a word on the booth page", async () => {
  const token = await teamToken();
  await clearStation();
  await signUps([["Test Ava", "ava.real@gmail.com"]]);
  const old = Date.now() - 2 * 86400e3;
  await env.DB.prepare("UPDATE party_guests SET joined_at = ?2 WHERE email = ?1").bind("ava.real@gmail.com", old).run();
  const me = (await get("team/line", { token })).body.sessions.flatMap((s) => s.guests).find((g) => g.email === "ava.real@gmail.com");
  assert.deepEqual([me.flags, me.phone, me.email], [["test", "stale"], "5550102030", "ava.real@gmail.com"], "the team sees why, with the contact details");
  await recording(["ava.real@gmail.com"], token);
  const st = await station();
  assert.deepEqual(st.next.people, [{ first_name: "Test", flags: ["test", "stale"] }], "the booth page says so, first name only");
  const songs = (await get("team/songs", { token })).body;
  assert.ok(songs.guests.some((g) => g.email === "ava.real@gmail.com" && g.flags.includes("test")), "the re-point picker shows it too");
  await move("ava.real@gmail.com", "upload", "done", token);
});

test("contest verdict: entered by anyone on it, solo or group, in at once; Scooter Taylor and test files in production are refused", () => {
  const track = { file_name: "Jingle.mp3" };
  const ticked = { ...track, contest_entered_at: 1 };
  const p = (name) => ({ name });
  assert.equal(contestVerdict({ track: ticked, people: [] }).reason, "nobody_attached");
  assert.equal(contestVerdict({ track, people: [p("Jay A")] }).reason, "not_entered");
  assert.ok(contestVerdict({ track: ticked, people: [p("Jay A")] }).ok, "a solo song is in with its one tick");
  assert.ok(contestVerdict({ track: ticked, people: [p("Jay A"), p("Mo B"), p("Kim C")] }).ok, "a group song too: no group-wide confirmation (Scooter, 18 Nov 2026)");
  assert.equal(contestVerdict({ track: { ...ticked, pulled_at: 3 }, people: [p("Jay A")] }).reason, "pulled_by_team");
  assert.equal(contestVerdict({ track: { ...ticked, file_name: "Scooter Taylor.mp3" }, people: [p("Jay A")] }).reason, "scooter_taylor");
  assert.equal(contestVerdict({ track: ticked, people: [p("Scooter Taylor")] }).reason, "scooter_taylor", "nor anyone on it");
  assert.equal(contestVerdict({ track: { ...ticked, title: "scootertaylor" }, people: [p("Jay A")] }).reason, "scooter_taylor", "nor its title");
  assert.equal(contestVerdict({ track: { ...ticked, file_name: "Test - Jingle.mp3" }, people: [p("Jay A")], production: true }).reason, "test_file_in_production");
  assert.ok(contestVerdict({ track: { ...ticked, file_name: "Test - Jingle.mp3" }, people: [p("Jay A")], production: false }).ok, "preview takes test files");
  assert.equal(voteLabel({ title: "" }, [p("Jay A"), p("Mo B"), p("Kim C")]), "Jay, Mo & Kim");
  assert.equal(voteLabel({ title: " Sleigh  Ride " }, [p("Jay A")]), "Sleigh Ride");
  assert.equal(freshSlug("Jay & Mo", new Set(["jay-mo"])), "jay-mo-2");
});

// A recording's song: everyone signs up, is tapped in and out, and the engineer uploads. → the code.
async function takeSong(people, file, token, e = env) {
  await clearStation();
  await signUps(people);
  await recording(people.map(([, mail]) => mail), token);
  const up = await upload(file, {}, e);
  assert.equal(up.status, 200, JSON.stringify(up.body));
  return up.body.code;
}

test("the song is everyone's on it (Scooter, 19 Nov 2026): each of them has the artwork, the title and the entry; anyone enters or withdraws it for everyone; who last changed it shows; its votes are kept", async () => {
  const token = await teamToken();
  const songCode = await takeSong([["Jay Holly", "jay.h@gmail.com"], ["Mo Ivy", "mo.i@gmail.com"], ["Kim Fir", "kim.f@gmail.com"]], "Jingle Bars.mp3", token);
  const view = await B(songCode, "contest-status", { email: "mo.i@gmail.com" });
  assert.equal(view.status, 200, view.text);
  assert.deepEqual(view.body.contest.access, ["Jay", "Mo", "Kim"], "all three have access before anyone opens /track");
  assert.deepEqual([view.body.contest.ticked, view.body.contest.step, view.body.contest.changed, view.body.contest.you, view.body.contest.vote_url], [false, "not_entered", null, { performer: true, can_manage: true, signed_up: true, host: false }, "/"]);
  assert.ok(!("manager" in view.body.contest), "no manager: nobody's controls depend on who came first");
  assert.equal(view.body.contest.rules_url, "/holiday-rules");
  assert.ok(!/@/.test(JSON.stringify(view.body.contest)), "no email for anyone");
  const heard = await B(songCode, "enter", { email: "friend@gmail.com" });
  assert.deepEqual([heard.status, heard.body.contest.access, heard.body.contest.you.performer, heard.body.contest.you.can_manage], [200, ["Jay", "Mo", "Kim"], false, false], "a listener sees who has access, and changes nothing");
  assert.ok(heard.body.audio_url && heard.body.download_url, "and hears and downloads it");
  assert.equal((await B(songCode, "contest", { email: "jay.h@gmail.com", enter: true })).body.error, "agree_required", "ticking needs the rules agreement");
  // Mo sets the title and the artwork, Jay ticks Enter: each of them may; the group song is in the vote by itself.
  assert.equal((await B(songCode, "title", { email: "mo.i@gmail.com", title: "Sleigh Bars" })).body.title, "Sleigh Bars");
  const art = await booth.onRequest({ request: new Request(`https://voting.test/api/booth/tracks/${songCode}/art`, { method: "POST", headers: { "cf-connecting-ip": freshIp(), "content-type": "image/png", "content-length": "8", "x-email": "kim.f@gmail.com" }, body: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]) }), env, params: { path: ["tracks", songCode, "art"] }, waitUntil: () => {} });
  assert.equal(art.status, 200, "Kim adds the artwork");
  const ticked = await B(songCode, "contest", { email: "jay.h@gmail.com", enter: true, agree: true });
  assert.equal(ticked.status, 200, ticked.text);
  const c1 = ticked.body.contest;
  assert.deepEqual([c1.ticked, c1.ticked_by, c1.entered, c1.step, c1.changed.action, c1.changed.by], [true, "Jay", true, "in", "entered", "Jay"]);
  assert.ok(Date.parse(c1.changed.at) > Date.now() - 60e3, "and when");
  const slugRow = () => env.DB.prepare("SELECT t.slug, t.label, t.active, t.id FROM tracks t JOIN booth_tracks b ON b.vote_track_id = t.id WHERE b.code = ?1").bind(songCode).first();
  const voteTrack = await slugRow();
  assert.deepEqual([voteTrack.label, voteTrack.active], ["Sleigh Bars", 1]);
  assert.equal(c1.vote_url, `/#${voteTrack.slug}`, "View Contest opens the voting page at this song");
  assert.ok(await inVote("Sleigh Bars"), "it shows in the vote, with no script run");
  const rec = await env.DB.prepare("SELECT contest_entered_by, contest_rules_version FROM booth_tracks WHERE code = ?1").bind(songCode).first();
  assert.deepEqual([rec.contest_entered_by, rec.contest_rules_version], ["jay.h@gmail.com", "holiday-2026-draft-4"], "who entered and which rules are kept");
  // Mo sees the same line on their phone, and can withdraw it for everyone.
  const moSees = (await B(songCode, "contest-status", { email: "mo.i@gmail.com" })).body.contest;
  assert.deepEqual([moSees.entered, moSees.changed.by, moSees.you.can_manage], [true, "Jay", true]);
  const iso = new Date().toISOString();
  const voter = await env.DB.prepare("INSERT INTO voters (name, email, email_key, city, created_at, verified) VALUES ('Fan', 'fan.sleigh@example.com', 'fan.sleigh@example.com', 'Bronx', ?1, 1) RETURNING id").bind(iso).first();
  await env.DB.prepare("INSERT INTO like_events (track_id, voter_id, action, created_at) VALUES (?1, ?2, 'like', ?3)").bind(voteTrack.id, voter.id, iso).run();
  const out = await B(songCode, "contest", { email: "mo.i@gmail.com", enter: false });
  assert.equal(out.status, 200, out.text);
  assert.deepEqual([out.body.contest.entered, out.body.contest.ticked, out.body.contest.changed.action, out.body.contest.changed.by, out.body.contest.vote_url], [false, false, "withdrawn", "Mo", "/"], "withdrawn by Mo, for everyone");
  assert.ok(!(await inVote("Sleigh Bars")));
  assert.deepEqual((await B(songCode, "contest-status", { email: "jay.h@gmail.com" })).body.contest.changed, out.body.contest.changed, "Jay's phone says the same");
  // Kim enters it again: the same track, the same link, and the like it had is still counted.
  const back = await B(songCode, "contest", { email: "kim.f@gmail.com", enter: true, agree: true });
  assert.deepEqual([back.body.contest.entered, back.body.contest.changed.by], [true, "Kim"]);
  assert.deepEqual([(await slugRow()).id, (await slugRow()).slug], [voteTrack.id, voteTrack.slug], "the same track, the same link");
  assert.equal((await stateNow()).tracks.find((t) => t.slug === voteTrack.slug)?.likes, 1, "its votes are kept");
  // A tick that changes nothing is not a change; every change is kept, in order.
  await B(songCode, "contest", { email: "jay.h@gmail.com", enter: true, agree: true });
  const log = (await env.DB.prepare("SELECT c.email, c.entered, c.rules_version FROM booth_contest_changes c JOIN booth_tracks b ON b.id = c.track_id WHERE b.code = ?1 ORDER BY c.id").bind(songCode).all()).results;
  assert.deepEqual(log.map((r) => [r.email, r.entered]), [["jay.h@gmail.com", 1], ["mo.i@gmail.com", 0], ["kim.f@gmail.com", 1]]);
  assert.deepEqual(log.map((r) => r.rules_version), ["holiday-2026-draft-4", null, "holiday-2026-draft-4"], "an entry keeps the rules it agreed to");
  const listed = (await get("team/songs", { token })).body.songs.find((x) => x.code === songCode);
  assert.deepEqual([listed.changed.action, listed.changed.by], ["entered", "Kim"], "the team sees who last changed it");
  // Someone not on the song cannot enter it, withdraw it or change it.
  for (const [what, body] of [["contest", { enter: false }], ["title", { title: "Theirs" }], ["public", { public: true }], ["contest-status", {}]]) {
    assert.equal((await B(songCode, what, { email: "stranger@gmail.com", ...body })).body.error, "not_attached", what);
  }
  assert.ok(await inVote("Sleigh Bars"), "the stranger changed nothing");
  await B(songCode, "contest", { email: "jay.h@gmail.com", enter: false });
});

test("everyone on the song may Share it: the first Share publishes the listen page; two at once both work", async () => {
  const token = await teamToken();
  const code = await takeSong([["Ann First", "ann.f@gmail.com"], ["Ben Second", "ben.s@gmail.com"]], "Both Share.mp3", token);
  const both = await Promise.all([B(code, "title", { email: "ben.s@gmail.com", title: "Ben's" }), B(code, "title", { email: "ann.f@gmail.com", title: "Ann's" })]);
  assert.deepEqual(both.map((r) => r.status), [200, 200], "neither is refused");
  const shared = await B(code, "public", { email: "ben.s@gmail.com", public: true });
  assert.equal(shared.body.public, true, "Ben's Share publishes it");
  assert.equal((await B(code, "public", { email: "ann.f@gmail.com", public: true })).body.share_id, shared.body.share_id, "Ann shares the same link");
});

test("typing a song's code hears and downloads it, and never puts anyone on it; Scooter's file and test files in production never go in, said neutrally", async () => {
  const token = await teamToken();
  const code = await takeSong([["Solo Sol", "sol@gmail.com"]], "Solo Jingle.mp3", token);
  const count = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM booth_people p JOIN booth_tracks b ON b.id = p.track_id WHERE b.code = ?1").bind(code).first()).n;
  const heard = await B(code, "enter", { email: "plusone@gmail.com" });
  assert.equal(heard.status, 200);
  assert.ok(heard.body.audio_url && heard.body.download_url, "hear and download");
  assert.deepEqual([heard.body.contest.on, heard.body.contest.you.performer, heard.body.contest.access], [true, false, ["Solo"]], "a listener, not a performer, who sees who has access");
  assert.equal(await count(), 1, "typing the code never attaches anyone");
  for (const what of ["contest", "title", "public"]) assert.equal((await B(code, what, { email: "plusone@gmail.com", enter: true, agree: true, title: "x", public: true })).body.error, "not_attached", what);
  const ok = await B(code, "contest", { email: "sol@gmail.com", enter: true, agree: true });
  assert.equal(ok.body.contest.entered, true, "a solo artist enters with one tick");
  assert.ok(await inVote("Solo"));
  // An upload with nobody at the station has nobody on it: hear and download only.
  const walk = await upload("Walk Up.mp3");
  const walkView = (await B(walk.body.code, "enter", { email: "sol@gmail.com" })).body.contest;
  assert.deepEqual([walkView.you.performer, walkView.nobody, walkView.access], [false, true, []]);
  // Scooter Taylor's file: never, and the page is told it is a test entry on the preview (no reason naming anyone).
  const scooter = await takeSong([["Pat Booth", "pat@gmail.com"]], "Scooter Taylor - Jingle.mp3", token);
  const refused = await B(scooter, "contest", { email: "pat@gmail.com", enter: true, agree: true });
  assert.deepEqual([refused.body.contest.entered, refused.body.contest.blocked, refused.body.contest.production], [false, "scooter_taylor", false]);
  assert.ok(!("blocked_where" in refused.body.contest), "no word on whose name set it off");
  assert.ok(!(await stateNow()).tracks.some((t) => /scooter/i.test(t.label)));
  // A test file in production: never.
  const prodEnv = { ...env, APP_ENV: "production" };
  const test1 = await takeSong([["Tess Prod", "tess@gmail.com"]], "Test - Jingle.mp3", token, prodEnv);
  const t = await B(test1, "contest", { email: "tess@gmail.com", enter: true, agree: true }, freshIp(), prodEnv);
  assert.deepEqual([t.body.contest.entered, t.body.contest.blocked, t.body.contest.production], [false, "test_file_in_production", true]);
});

test("the team re-points a song to exactly the people picked, with a note of who changed what and when; team only; the old people lose the controls", async () => {
  const token = await teamToken("fixer@example.com");
  // The 7444 case: a song lands on a stale test sign-up instead of the person who recorded it.
  await signUps([["Real Rae", "rae.real@gmail.com"]]);
  const wrong = await takeSong([["Test Old", "old.test@gmail.com"]], "Twice.mp3", token);
  assert.equal((await B(wrong, "title", { email: "old.test@gmail.com", title: "Old Title" })).status, 200, "the wrong person even has the controls");
  assert.equal((await B(wrong, "enter", { email: "rae.real@gmail.com" })).body.contest.you.performer, false, "Rae reads as a listener: identity is membership, never a matching email");
  const rae = await guestId("rae.real@gmail.com");
  assert.equal((await post(`team/songs/${wrong}/people`, { guest_ids: [rae] })).body.error, "team_sign_in", "only the team re-points");
  assert.equal((await post(`team/songs/${wrong}/people`, { guest_ids: ["x"] }, { token })).body.error, "bad_people");
  assert.equal((await post(`team/songs/${wrong}/people`, { guest_ids: [987654] }, { token })).body.error, "no_guest");
  const closedEnv = { ...env, VOTING_ENDS_AT: "2020-06-01T00:00:00Z" };
  assert.equal((await post(`team/songs/${wrong}/people`, { guest_ids: [rae] }, { token, e: closedEnv })).body.error, "voting_closed");
  const fixed = await post(`team/songs/${wrong}/people`, { guest_ids: [rae], note: "  uploaded on the wrong   sign-up  " }, { token });
  assert.equal(fixed.status, 200, fixed.text);
  assert.deepEqual(await songPeople(wrong), [{ email: "rae.real@gmail.com", guest_id: rae }], "exactly the person picked, by their record");
  assert.deepEqual(fixed.body.song.members.map((m) => m.first_name), ["Real"], "the old person is off the song");
  assert.equal((await B(wrong, "title", { email: "old.test@gmail.com", title: "Still Mine" })).body.error, "not_attached", "and has no controls any more");
  const [log] = fixed.body.song.repoints;
  assert.deepEqual([log.by, log.before, log.after, log.note], ["fixer@example.com", ["Test Old"], ["Real Rae"], "uploaded on the wrong sign-up"], "who, what and the note");
  assert.ok(Date.parse(log.at) > Date.now() - 60e3, "and when");
  const row = await env.DB.prepare("SELECT before_json, after_json, member_id FROM booth_repoints r JOIN booth_tracks b ON b.id = r.track_id WHERE b.code = ?1").bind(wrong).first();
  assert.deepEqual(JSON.parse(row.after_json), [{ guest_id: rae, name: "Real Rae" }], "kept in the table, never deleted");
  const raeNow = (await B(wrong, "enter", { email: "rae.real@gmail.com" })).body.contest;
  assert.deepEqual([raeNow.you.performer, raeNow.you.can_manage, raeNow.access], [true, true, ["Real"]], "Rae is on it, with the controls");
  assert.equal((await B(wrong, "enter", { email: "old.test@gmail.com" })).body.contest.you.performer, false, "the stale sign-up is off it");
  // A song uploaded with nobody on it is put on its people the same way; and re-pointing to nobody is allowed (the song waits).
  const walk = (await upload("Nobody Yet.mp3")).body.code;
  assert.equal((await get("team/songs", { token })).body.songs.find((s) => s.code === walk).needs_people, true, "in front of the team, marked as needing its people");
  assert.equal((await post(`team/songs/${walk}/people`, { guest_ids: [rae] }, { token })).body.song.people, 1);
  assert.equal((await post(`team/songs/${walk}/people`, { guest_ids: [] }, { token })).body.song.needs_people, true);
  assert.ok(!JSON.stringify((await get("team/songs", { token })).body.songs).includes("@gmail"), "the songs list carries no guest email (the picker list does, team only)");
});

test("after voting ends nothing moves: the box and the title answer 403 voting_closed", async () => {
  const token = await teamToken();
  const closedEnv = { ...env, VOTING_ENDS_AT: "2020-06-01T00:00:00Z" };
  const code = await takeSong([["Late Comer", "late@gmail.com"]], "Late.mp3", token);
  assert.equal((await B(code, "contest", { email: "late@gmail.com", enter: true, agree: true }, freshIp(), closedEnv)).body.error, "voting_closed");
  assert.equal((await B(code, "title", { email: "late@gmail.com", title: "x" }, freshIp(), closedEnv)).body.error, "voting_closed");
});

test("the end (Scooter, 19 Nov 2026): voting closes Friday, November 27 at 11:59 PM ET; nothing after it counts; a vote counts only after the 6-digit code", async () => {
  const { buildState } = await import("../functions/_lib/state.js");
  const before = Date.parse("2026-11-27T12:00:00Z");
  const s = await buildState(withRealEnd(env), before);
  assert.deepEqual([s.voting_ends_at, s.closed, s.open], ["2026-11-28T04:59:00.000Z", false, true], "the end is 11:59 PM EST on 27 Nov, and it is open before it");
  const { PARTY_VOTING_ENDS_AT, votingPhase } = await import("../functions/_lib/config.js");
  assert.equal(PARTY_VOTING_ENDS_AT, "2026-11-28T04:59:00Z");
  assert.equal(votingPhase(withRealEnd(env), Date.parse("2026-11-28T04:58:59Z"), null, null).closed, false, "a second before: open");
  assert.equal(votingPhase(withRealEnd(env), Date.parse("2026-11-28T04:59:00Z"), null, null).closed, true, "at 11:59 PM ET: closed");
  assert.equal((await buildState(withRealEnd(env), Date.parse("2026-11-28T05:00:00Z"))).closed, true, "/api/state says closed after it");
  assert.equal(votingPhase(withRealEnd({ ...env, HOLIDAY_EVENT: "off" }), Date.parse("2026-11-27T12:00:00Z"), null, null).closed, true, "production (party off) keeps its own end");
  assert.equal(votingPhase({ ...withRealEnd(env), ALLOW_END_OVERRIDE: "1" }, Date.parse("2026-12-19T12:00:00Z"), null, "2026-12-01T00:00:00Z").closed, true, "a preview rehearsal row still closes it");
  // Verified only: an unverified voter's like is kept and not counted; it counts once they verify.
  const token = await teamToken();
  const code = await takeSong([["Vee Count", "vee@gmail.com"]], "Count Me.mp3", token);
  await B(code, "contest", { email: "vee@gmail.com", enter: true, agree: true });
  const likes = await import("../functions/api/likes.js");
  const iso = new Date().toISOString();
  const mk = (email, verified) => env.DB.prepare("INSERT INTO voters (name, email, email_key, city, created_at, verified, unverified_reason) VALUES ('V', ?1, ?1, 'Bronx', ?2, ?3, ?4) RETURNING id").bind(email, iso, verified, verified ? null : "mail_budget").first();
  const unv = await mk("unv.count@gmail.com", 0);
  const ver = await mk("ver.count@gmail.com", 1);
  const slug = (await env.DB.prepare("SELECT t.slug FROM tracks t JOIN booth_tracks b ON b.vote_track_id = t.id WHERE b.code = ?1").bind(code).first()).slug;
  const like = async (id) => (await call(likes.onRequest, env, { method: "POST", path: "/api/likes", body: { track: slug, liked: true }, token: await signVoterToken(env, id), ip: freshIp() })).body;
  assert.equal((await like(unv.id)).likes, 0, "a like with no code is kept, not counted");
  assert.equal((await like(ver.id)).likes, 1, "a like after the code counts");
  assert.equal((await stateNow()).tracks.find((t) => t.slug === slug).likes, 1, "the page counts it the same way");
  await env.DB.prepare("UPDATE voters SET verified = 1 WHERE id = ?1").bind(unv.id).run();
  assert.equal((await stateNow()).tracks.find((t) => t.slug === slug).likes, 2, "it counts the moment that voter enters a code");
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM like_events e JOIN tracks t ON t.id = e.track_id WHERE t.slug = ?1").bind(slug).first()).n, 2, "nothing was lost");
  // A code entered after the cutoff adds no vote: a like from before the end whose voter verified
  // after it is kept and never counted, on the page and in the party's export.
  const tardy = await mk("tardy.count@gmail.com", 0);
  assert.equal((await like(tardy.id)).likes, 2, "kept, not counted yet");
  await env.DB.prepare("UPDATE voters SET verified = 1, verified_at = '2026-11-28T05:10:00.000Z' WHERE id = ?1").bind(tardy.id).run();
  const countAt = async (now) => (await buildState(withRealEnd(env), now)).tracks.find((t) => t.slug === slug).likes;
  assert.equal(await countAt(Date.parse("2026-11-28T06:00:00Z")), 2, "verified after 11:59 PM ET: not counted");
  await env.DB.prepare("UPDATE voters SET verified_at = '2026-11-28T04:58:00.000Z' WHERE id = ?1").bind(tardy.id).run();
  assert.equal(await countAt(Date.parse("2026-11-28T06:00:00Z")), 3, "verified a minute before: counted");
  const { partyCounts } = await import("../scripts/export.mjs");
  const ev = (created_at, verified_at, verified = 1) => ({ created_at, verified_at, verified });
  assert.equal(partyCounts(ev("2026-11-27T20:00:00Z", "2026-11-27T20:01:00Z")), true, "export: like and code before the end count");
  assert.equal(partyCounts(ev("2026-11-27T20:00:00Z", "2026-11-28T05:00:00Z")), false, "export: a code after the end does not");
  assert.equal(partyCounts(ev("2026-11-28T05:00:00Z", "2026-11-27T20:01:00Z")), false, "export: a like after the end does not");
  assert.equal(partyCounts(ev("2026-11-27T20:00:00Z", null, 0)), false, "export: no code, no count");
  // After the cutoff the server refuses the like itself (the route reads the same window).
  const likesRoute = await import("../functions/api/likes.js");
  const lateVoter = await env.DB.prepare("INSERT INTO voters (name, email, email_key, city, created_at, verified) VALUES ('L', 'late.like@gmail.com', 'late.like@gmail.com', 'Bronx', ?1, 1) RETURNING id").bind(new Date().toISOString()).first();
  const late = await call(likesRoute.onRequest, { ...env, VOTING_ENDS_AT: "2020-06-01T00:00:00Z" }, { method: "POST", path: "/api/likes", body: { track: slug, liked: true }, token: await signVoterToken(env, lateVoter.id), ip: freshIp() });
  assert.deepEqual([late.status, late.body.error], [403, "voting_closed"], "a like after the end is refused, not stored");
});

test("the team's safety valve: Take out of the vote from /team holds even if it is entered again; Put back re-enters; likes kept; team only", async () => {
  const token = await teamToken();
  const code = await takeSong([["Val Ve", "valve@gmail.com"]], "Valve Jingle.mp3", token);
  assert.equal((await B(code, "contest", { email: "valve@gmail.com", enter: true, agree: true })).body.contest.entered, true);
  const voteId = (await env.DB.prepare("SELECT vote_track_id FROM booth_tracks WHERE code = ?1").bind(code).first()).vote_track_id;
  const iso = new Date().toISOString();
  const voter = await env.DB.prepare("INSERT INTO voters (name, email, email_key, city, created_at) VALUES ('Liker', 'liker.valve@example.com', 'liker.valve@example.com', 'Bronx', ?1) RETURNING id").bind(iso).first();
  await env.DB.prepare("INSERT INTO like_events (track_id, voter_id, action, created_at) VALUES (?1, ?2, 'like', ?3)").bind(voteId, voter.id, iso).run();
  const likesBefore = 1;
  const listed = (await get("team/songs", { token })).body.songs.find((s) => s.code === code);
  const { members, uploaded_at, ...rest } = listed;
  assert.ok(Date.parse(uploaded_at) > 0);
  assert.deepEqual(rest, { code, label: "Val", file_name: "Valve Jingle.mp3", entered: true, pulled: false, pulled_at: null, people: 1, needs_people: false, ticked: true, ticked_by: "Val", changed: rest.changed, repoints: [] }, "the team sees the song, in, with who entered it");
  assert.deepEqual([rest.changed.action, rest.changed.by], ["entered", "Val"], "and who last changed it");
  assert.equal(members.length, 1);
  assert.deepEqual(Object.keys(members[0]).sort(), ["attached_at", "first_name", "guest_id", "id", "name", "signed_up"], "names and records, never an email");
  assert.equal(members[0].first_name, "Val");
  assert.equal((await post(`team/songs/${code}/pull`, { pulled: true })).body.error, "team_sign_in", "only the team pulls a song");
  assert.equal((await post(`team/songs/${code}/pull`, {}, { token })).body.error, "bad_pull");
  assert.equal((await post("team/songs/9999/pull", { pulled: true }, { token })).status, 404);
  const pulled = await post(`team/songs/${code}/pull`, { pulled: true }, { token });
  assert.equal(pulled.status, 200, pulled.text);
  assert.equal(pulled.body.song.entered, false);
  assert.equal(pulled.body.song.pulled, true);
  assert.ok(!(await inVote("Val")), "out of the vote at once");
  await B(code, "contest", { email: "valve@gmail.com", enter: false });
  const again = await B(code, "contest", { email: "valve@gmail.com", enter: true, agree: true });
  assert.equal(again.body.contest.entered, false);
  assert.equal(again.body.contest.blocked, "pulled_by_team", "the person on the song sees that the team took it out");
  assert.equal((await env.DB.prepare("SELECT active FROM tracks WHERE id = ?1").bind(voteId).first()).active, 0);
  const back = await post(`team/songs/${code}/pull`, { pulled: false }, { token });
  assert.equal(back.body.song.entered, true, "put back: in again, since it is still entered");
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

test("gallery photos: while the party is on, the old CultureCon photos are never served; party photos are", async () => {
  const photo = (sha, alt) => ({ url: `/media/photos/${sha}-1600.jpg`, width: 1067, height: 1600, thumb_url: `/media/photos/${sha}-640.jpg`, thumb_width: 427, thumb_height: 640, alt });
  const old = photo("aaa", "Top Barz at CultureCon, photo 1");
  const party = photo("bbb", "Top Barz at the Christmas party, photo 2");
  await env.MEDIA.put("manifest/photos.json", JSON.stringify({ photos: [old, party] }));
  try {
    assert.deepEqual((await stateNow()).photos, [party], "party on: CultureCon photos dropped, the party photo kept");
    await env.MEDIA.put("manifest/photos.json", JSON.stringify({ photos: [old] }));
    assert.deepEqual((await stateNow()).photos, [], "party on with only CultureCon photos: none");
    _resetStateMemo();
    const offState = (await call(state.onRequest, { ...env, HOLIDAY_EVENT: "off" }, { path: "/api/state" })).body;
    assert.deepEqual(offState.photos, [old], "party off (production until go-live): the photos are as before");
  } finally {
    await env.MEDIA.delete("manifest/photos.json");
    _resetStateMemo();
  }
});

test("privacy: no route but the team's answers a phone or an email of a guest; the tables are read only where they should be", () => {
  const src = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
  const partyRoute = src("functions/api/party/[[path]].js");
  // The one SELECT that reads phone and email is the team's line, behind requireMember.
  assert.equal([...partyRoute.matchAll(/LINE_GUESTS_SQL/g)].length, 2, "imported once, read once");
  assert.match(partyRoute, /async function line\(context\)/);
  assert.match(partyRoute, /const m = await member\(context\);\n    if \(parts\.length === 2 && parts\[1\] === "line"\) return line\(context\);/, "the line is read only after the team check");
  for (const file of ["functions/_lib/state.js", "functions/api/state.js", "functions/_lib/tally.js", "scripts/export.mjs", "functions/api/beats.js"]) assert.ok(!/party_guests|team_members/.test(src(file)), `${file} never reads the guests or the team`);
  assert.ok(!/party_guests|phone/.test(src("functions/api/booth/[[path]].js")), "the booth route reads names through contest.js and party.js only, never a phone");
  // The re-point picker (every sign-up's email and phone) is the team's songs route, behind the team check.
  assert.equal([...partyRoute.matchAll(/ALL_GUESTS_SQL/g)].length, 2, "imported once, read once");
  assert.match(partyRoute, /if \(parts\.length === 2 && parts\[1\] === "songs"\) return songs\(context\);/);
  assert.ok(partyRoute.indexOf('parts[1] === "songs") return songs(context)') > partyRoute.indexOf("const m = await member(context);"), "after the team check");
  // The booth page's list of who the song goes to: first names and flags only.
  const boothRoute = src("functions/api/booth/[[path]].js");
  assert.match(boothRoute, /people: people\.map\(\(p\) => \(\{ first_name: firstOf\(p\.name\), flags: guestFlags\(p, now\) \}\)\)/);
});

// "Remove everything CultureCon" (Scooter's preview notes, 17 Nov 2026; review finding): while the
// party is on, the vote is the party's own songs only. A track from before the party (any source
// other than a booth song entering itself) is not in /api/state and cannot be commented on; with
// the party off it is exactly as before.
test("party on: a pre-party track is not in the vote; party off: it is", async () => {
  const { buildState } = await import("../functions/_lib/state.js");
  const comments = await import("../functions/api/comments.js");
  const t = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO tracks (slug, label, source_name, audio_key, sort, active, created_at, updated_at) VALUES ('pre-party', 'Pre Party', 'Pre Party', 'tracks/pre-party.mp3', 1, 1, ?1, ?1)").bind(t),
    env.DB.prepare("INSERT INTO tracks (slug, label, source_name, audio_key, sort, active, created_at, updated_at) VALUES ('party-jingle', 'Party Jingle', 'booth:999999', 'booth/x.mp3', 2, 1, ?1, ?1)").bind(t),
  ]);
  try {
    const on = (await buildState(env)).tracks.map((x) => x.slug);
    assert.ok(on.includes("party-jingle"), "the party's own song is in the vote");
    assert.ok(!on.includes("pre-party"), "a pre-party track is not in the vote while the party is on");
    const read = (e) => call(comments.onRequest, e, { path: "/api/comments?track=pre-party" });
    assert.equal((await read(env)).status, 404, "a pre-party track cannot be read or commented on while the party is on");
    const off = { ...env, HOLIDAY_EVENT: "off" };
    assert.ok((await buildState(off)).tracks.some((x) => x.slug === "pre-party"), "with the party off (production) the track is in the vote as before");
    assert.equal((await read(off)).status, 200, "with the party off its comments read as before");
  } finally {
    await env.DB.prepare("DELETE FROM tracks WHERE slug IN ('pre-party', 'party-jingle')").run();
  }
});

test("the demo song (Scooter, 19 Nov 2026: \"make sure I can ... take a song through contest entry and see it appear on the voting page\"): eligible, entered by its singer's email, on the vote, and one run resets it", async () => {
  const demo = await import("../scripts/demo-song.mjs");
  assert.match(demo.checkArgs({ env: "production" }).error, /preview only/, "production is refused");
  assert.match(demo.checkArgs({ env: "preview", name: "Scooter Taylor" }).error, /Scooter Taylor/, "a song with Scooter Taylor on it never goes in the vote");
  assert.match(demo.checkArgs({ env: "preview", name: "Test Ava" }).error, /Test/);
  assert.match(demo.checkArgs({ env: "preview", email: "nope" }).error, /email/);
  assert.deepEqual(demo.checkArgs({ env: "preview" }), { name: "Demo Singer", email: "jingle.demo@example.com", host: null });
  const wav = demo.jingleWav();
  assert.deepEqual([wav.toString("ascii", 0, 4), wav.toString("ascii", 8, 12), wav.readUInt32LE(40) === wav.length - 44], ["RIFF", "WAVE", true]);
  assert.ok(wav.length / (22050 * 2) > 6, "a few seconds of music, not a click");
  await clearStation();
  const run = async (stmts) => { for (const sql of stmts) await env.DB.prepare(sql).run(); };
  const now = Date.now();
  await run(demo.createStatements({ code: "8642", key: "booth/8642-0011223344556677.wav", size: wav.length, now, name: "Demo Singer", email: "jingle.demo@example.com", guest: "ab".repeat(12), session: "DMQX" }));
  const found = await env.DB.prepare(demo.FIND_SQL).first();
  assert.deepEqual(found, { code: "8642", email: "jingle.demo@example.com" }, "the script finds its own song again (a second run resets, never a second song)");
  const view = (await B("8642", "enter", { email: "jingle.demo@example.com" })).body.contest;
  assert.deepEqual([view.access, view.you.performer, view.you.can_manage, view.step], [["Demo"], true, true, "not_entered"], "the singer's email has the controls; it is not entered yet");
  assert.deepEqual((await B("8642", "enter", { email: "listener@gmail.com" })).body.contest.you.can_manage, false, "anyone else hears it only");
  const demoRow = (await get("team/line", { token: await teamToken() })).body.sessions.find((x) => x.guests.some((g) => g.email === "jingle.demo@example.com"));
  assert.ok(!demoRow || laneOf(demoRow) === "done", "the demo singer holds no place in the line or at the upload station");
  assert.deepEqual(await station().then((st) => JSON.stringify(st).includes("Demo")), false, "and is never the engineer's next upload");
  assert.equal((await B("8642", "title", { email: "jingle.demo@example.com", title: "Jingle Demo" })).status, 200);
  const ticked = await B("8642", "contest", { email: "jingle.demo@example.com", enter: true, agree: true });
  assert.deepEqual([ticked.status, ticked.body.contest.entered, ticked.body.contest.step], [200, true, "in"], "Enter puts it in");
  assert.ok(await inVote("Jingle Demo"), "and it is on the voting page");
  await run(demo.resetStatements({ code: "8642", now: Date.now() }));
  assert.ok(!(await inVote("Jingle Demo")), "the reset takes it out of the vote");
  const after = (await B("8642", "enter", { email: "jingle.demo@example.com" })).body.contest;
  assert.deepEqual([after.ticked, after.changed, after.title, after.you.can_manage], [false, null, "", true], "not entered, no history line, no title: ready to show again");
  assert.equal((await B("8642", "contest", { email: "jingle.demo@example.com", enter: true, agree: true })).body.contest.entered, true, "and it goes in again");
  assert.ok(await inVote("Demo") || await inVote("Jingle Demo"), "the same song, back on the voting page");
  await B("8642", "contest", { email: "jingle.demo@example.com", enter: false });
});

test("the demo's host (Scooter, 19 Nov 2026: \"use my own access to take a song through contest entry and see it appear on the voting page\"): their own email has the demo song's controls and enters it, without being on it; nobody else can; production ignores it", async () => {
  const demo = await import("../scripts/demo-song.mjs");
  const host = "host.demo@example.org";
  assert.equal(demo.checkArgs({ env: "preview", host }).host, host);
  assert.match(demo.checkArgs({ env: "preview", host: "nope" }).error, /--host/);
  assert.match(demo.checkArgs({ env: "preview", host: "jingle.demo@example.com" }).error, /--host/, "the host is a second person, never the singer");
  await clearStation();
  const run = async (stmts) => { for (const sql of stmts) await env.DB.prepare(sql).run(); };
  const wav = demo.jingleWav();
  // The host has signed up as Scooter Taylor: the vote must still never see that name on the song.
  await env.DB.prepare("INSERT INTO party_sessions (code, created_at, status, status_at, done_at) VALUES ('HSTQ', 1, 'out', 1, 1)").run();
  await env.DB.prepare("INSERT INTO party_guests (session_id, name, phone, email, city, instagram, guest_key, joined_at) SELECT id, 'Scooter Taylor', '555 010 0001', ?1, 'Memphis', '', ?2, 1 FROM party_sessions WHERE code = 'HSTQ'").bind(host, "cd".repeat(12)).run();
  try {
    await run(demo.createStatements({ code: "8643", key: "booth/8643-0011223344556677.wav", size: wav.length, now: Date.now(), name: "Demo Singer", email: "jingle.demo@example.com", guest: "ef".repeat(12), session: "DMQY", host }));
    const view = (await B("8643", "enter", { email: host })).body.contest;
    assert.deepEqual([view.access, view.you.performer, view.you.can_manage, view.you.host, view.blocked, view.step], [["Demo"], true, true, true, null, "not_entered"], "the host's own email opens it with the controls; the song is still the singer's alone");
    const stranger = await B("8643", "contest", { email: "listener@gmail.com", enter: true, agree: true });
    assert.deepEqual([stranger.status, stranger.body.error], [403, "not_attached"], "anyone else with the code still only hears it");
    assert.equal((await B("8643", "title", { email: host, title: "Host Jingle" })).status, 200, "the host sets the title");
    const ticked = await B("8643", "contest", { email: host, enter: true, agree: true });
    assert.deepEqual([ticked.status, ticked.body.contest.entered, ticked.body.contest.step, ticked.body.contest.ticked_by], [200, true, "in", "the demo's host"], "Enter, by the host's own email, puts it in");
    assert.ok(await inVote("Host Jingle"), "and it is on the voting page");
    assert.deepEqual([ticked.body.contest.changed.action, ticked.body.contest.changed.by], ["entered", "the demo's host"], "the line says the host entered it, never their name or email");
    const prodEnv = { ...env, APP_ENV: "production" };
    const prod = await B("8643", "contest", { email: host, enter: false }, freshIp(), prodEnv);
    assert.deepEqual([prod.status, prod.body.error], [403, "not_attached"], "production never honours a host");
    assert.equal((await B("8643", "contest", { email: host, enter: false })).body.contest.entered, false, "the host's untick takes it out again");
    assert.ok(!(await inVote("Host Jingle")));
    await run(demo.resetStatements({ code: "8643", now: Date.now() }));
    const after = (await B("8643", "enter", { email: host })).body.contest;
    assert.deepEqual([after.ticked, after.changed, after.title, after.you.can_manage], [false, null, "", true], "a reset without --host keeps the host: ready to show again");
  } finally {
    await env.DB.prepare("DELETE FROM party_guests WHERE email = ?1").bind(host).run();
  }
});

test("names on the voting page (Scooter, 20 Nov 2026: \"Each song on the public voting page should show the people on it\"): first names only, in the order they joined it; never a last name, email or phone; off with the party", async () => {
  const token = await teamToken();
  await clearStation();
  await signUps([["Nia Lyric", "nia.lyric@gmail.com"], ["Omar Flow", "omar.flow@gmail.com"]]);
  await recording(["nia.lyric@gmail.com", "omar.flow@gmail.com"], token);
  const up = await upload("Nia And Omar.mp3");
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal((await B(up.body.code, "title", { email: "nia.lyric@gmail.com", title: "Snow Day Anthem" })).status, 200);
  assert.equal((await B(up.body.code, "contest", { email: "omar.flow@gmail.com", enter: true, agree: true })).body.contest.entered, true);
  const s = await stateNow();
  const t = s.tracks.find((x) => x.label === "Snow Day Anthem");
  assert.deepEqual(t.people, ["Nia", "Omar"], "the first names of everyone on it");
  const raw = JSON.stringify(s);
  for (const never of ["Lyric", "Flow", "nia.lyric@gmail.com", "omar.flow@gmail.com", "555"]) assert.ok(!raw.includes(never), `/api/state never carries ${never}`);
  for (const x of s.tracks) assert.ok(Array.isArray(x.people) && x.people.every((n) => typeof n === "string" && !/\s|@/.test(n)), `${x.label}: a list of single first names`);
  // The line on the card: "by Nia & Omar"; nothing when the song's own label already is its names.
  const { byLine } = await import("../public/js/logic.js");
  const { groupLabel: teamJoin } = await import("../public/js/party-rules.js");
  assert.equal(byLine("{names}", { label: "x", people: ["A", "B", "C"] }), teamJoin(["A", "B", "C"]), "the same join as the team's");
  assert.equal(byLine("by {names}", t), "by Nia & Omar");
  assert.equal(byLine("by {names}", { label: "Nia & Omar", people: ["Nia", "Omar"] }), "", "never says the names twice");
  assert.equal(byLine("by {names}", { label: "Old Track", people: [] }), "");
  assert.equal(byLine("by {names}", { label: "Old Track" }), "", "party off: no people key, no line");
  // Party off: the shape of a track is as before (no people key).
  _resetStateMemo();
  const off = (await call(state.onRequest, { ...env, HOLIDAY_EVENT: "off" }, { path: "/api/state" })).body;
  assert.ok(off.tracks.length > 0 && off.tracks.every((x) => !("people" in x)), "party off: no names on the vote");
  await B(up.body.code, "contest", { email: "nia.lyric@gmail.com", enter: false });
});

test("the team's downloads (Scooter, 20 Nov 2026: \"a CSV export on the team page\"): the line and the songs, team token only, never cached; a formula typed into a sign-up is text, a phone number is kept", async () => {
  const token = await teamToken();
  await clearStation();
  for (const route of ["export/line.csv", "export/songs.csv"]) {
    const anon = await get(`team/${route}`);
    assert.equal(anon.status, 401, `${route} refuses without the team token`);
    assert.ok(!/@|555/.test(anon.text), "and answers no detail");
    const bad = await get(`team/${route}`, { token: "not-a-token" });
    assert.equal(bad.status, 401, `${route} refuses a forged token`);
  }
  assert.equal((await guest("=HYPERLINK(\"http://x.test\") Evil", "csv.evil@gmail.com", { phone: "+1 901 555 0100", city: "-cmd", instagram: "csv_ig" })).status, 201);
  await signUps([["Pia Quotes", "pia.quotes@gmail.com"]]);
  const line = await get("team/export/line.csv", { token });
  assert.equal(line.status, 200, line.text);
  assert.match(line.headers.get("content-type"), /^text\/csv/);
  assert.match(line.headers.get("content-disposition"), /^attachment; filename="topbarz-line-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.csv"$/);
  assert.equal(line.headers.get("cache-control"), "no-store");
  const rows = line.text.replace(/^﻿/, "").trim().split("\r\n");
  assert.equal(rows[0], '"Name","Phone","Email","City","Instagram","First signed up (UTC)","Last signed up (UTC)","Times in line","Now","Flags"');
  const total = (await env.DB.prepare("SELECT COUNT(*) AS n FROM party_guests").first()).n;
  assert.equal(rows.length - 1, total, "one row for everyone who signed up");
  const evil = rows.find((r) => r.includes("csv.evil@gmail.com"));
  assert.ok(evil.startsWith(`"'=HYPERLINK(""http://x.test"") Evil","+19015550100","csv.evil@gmail.com","'-cmd","csv_ig",`), `a formula is text, the phone stays a phone: ${evil}`);
  const pia0 = await env.DB.prepare("SELECT phone FROM party_guests WHERE email = 'pia.quotes@gmail.com'").first();
  assert.ok(rows.some((r) => r.startsWith(`"Pia Quotes","${pia0.phone}","pia.quotes@gmail.com","Brooklyn","",`)), "name, phone (as kept), email, city, Instagram");
  // The songs: code, title, who is on it, in the vote, likes and comments as the page counts them.
  await recording(["pia.quotes@gmail.com"], token);
  const up = await upload("Pia Solo.mp3");
  assert.equal(up.status, 200, JSON.stringify(up.body));
  await B(up.body.code, "title", { email: "pia.quotes@gmail.com", title: "Pia's Carol" });
  await B(up.body.code, "contest", { email: "pia.quotes@gmail.com", enter: true, agree: true });
  const slug = (await env.DB.prepare("SELECT t.slug FROM tracks t JOIN booth_tracks b ON b.vote_track_id = t.id WHERE b.code = ?1").bind(up.body.code).first()).slug;
  const likes = await import("../functions/api/likes.js");
  const iso = new Date().toISOString();
  const mk = (email, verified) => env.DB.prepare("INSERT INTO voters (name, email, email_key, city, created_at, verified, unverified_reason) VALUES ('V', ?1, ?1, 'Bronx', ?2, ?3, ?4) RETURNING id").bind(email, iso, verified, verified ? null : "mail_budget").first();
  const like = async (id) => call(likes.onRequest, env, { method: "POST", path: "/api/likes", body: { track: slug, liked: true }, token: await signVoterToken(env, id), ip: freshIp() });
  for (const v of [await mk("csv.fan1@gmail.com", 1), await mk("csv.fan2@gmail.com", 1), await mk("csv.nocode@gmail.com", 0)]) assert.equal((await like(v.id)).status, 200);
  const tid = (await env.DB.prepare("SELECT id FROM tracks WHERE slug = ?1").bind(slug).first()).id;
  const fan = (await env.DB.prepare("SELECT id FROM voters WHERE email = 'csv.fan1@gmail.com'").first()).id;
  await env.DB.prepare("INSERT INTO comments (voter_id, track_id, body, created_at, hidden) VALUES (?1, ?2, 'fire', ?3, 0), (?1, ?2, 'hidden one', ?3, 1)").bind(fan, tid, iso).run();
  const page = (await stateNow()).tracks.find((t) => t.slug === slug);
  assert.deepEqual([page.likes, page.comments], [2, 1], "the page: two counted likes (the one with no code is not), one visible comment");
  const songs = await get("team/export/songs.csv", { token });
  assert.equal(songs.status, 200, songs.text);
  assert.match(songs.headers.get("content-disposition"), /filename="topbarz-songs-/);
  const srows = songs.text.replace(/^﻿/, "").trim().split("\r\n");
  assert.equal(srows[0], '"Code","Title","Who is on it","People","In the vote","Likes","Comments","Last entered or withdrawn","Uploaded (UTC)","File"');
  const pia = srows.find((r) => r.startsWith(`"${up.body.code}",`));
  assert.ok(pia.startsWith(`"${up.body.code}","Pia's Carol","Pia Quotes","1","yes","2","1",`), `the same counts as the page: ${pia}`);
  assert.ok(pia.includes('"Pia Solo.mp3"'));
  await B(up.body.code, "contest", { email: "pia.quotes@gmail.com", enter: false });
  const out = (await get("team/export/songs.csv", { token })).text.split("\r\n").find((r) => r.startsWith(`"${up.body.code}",`));
  assert.match(out, /^"\d{4}","Pia's Carol","Pia Quotes","1","no \(withdrawn\)","2","1","withdrawn by Pia at /, "withdrawn: no longer in the vote, its votes kept");
});

test("the held file (Scooter, 20 Nov 2026: \"the file waits until the right recording pops up, the engineer confirms the names, and only then it attaches\"): the page asks again only for a recording the engineer has not refused; only Yes uploads", async () => {
  const { askAboutHeld, stationSig } = await import("../public/js/booth-rules.js");
  const ava = { key: "41.2", names: "Ava & Ben" };
  const file = { name: "Take.mp3" };
  assert.equal(askAboutHeld(null, ava), false, "no file held: nothing to ask");
  assert.equal(askAboutHeld({ file, refused: null }, null), false, "held, nobody at the station yet: it keeps waiting");
  assert.equal(askAboutHeld({ file, refused: null }, ava), true, "a recording pops up: ask the engineer");
  assert.equal(askAboutHeld({ file, refused: stationSig(ava) }, ava), false, "the same names the engineer said Not them to: never asked again");
  assert.equal(askAboutHeld({ file, refused: stationSig(ava) }, { key: "41.3", names: "Ava, Ben & Cy" }), true, "someone joined: a different recording, ask again");
  assert.equal(askAboutHeld({ file, refused: stationSig(ava) }, { key: "42.1", names: "Dee" }), true, "the next recording: ask");
  assert.equal(askAboutHeld({ file, refused: null }, ava, { busy: true }), false, "never while an upload is going");
  assert.equal(askAboutHeld({ file, refused: null }, ava, { asking: true }), false, "never twice at once");
  assert.equal(stationSig(null), "");
  // The server half: a file sent for a recording that is no longer the station's next is refused, never attached.
  const token = await teamToken();
  await clearStation();
  await signUps([["Held One", "held.one@gmail.com"], ["Held Two", "held.two@gmail.com"]]);
  await recording(["held.one@gmail.com"], token);
  const shown = (await station()).next;
  assert.equal((await post(`team/sessions/${await sessionOf("held.two@gmail.com")}/status`, { status: "booth", from: "waiting", song: "new" }, { token })).status, 200);
  assert.equal((await move("held.two@gmail.com", "booth", "upload", token)).status, 200);
  const res = await upload("Held.mp3", { "x-party-take": "999999.1" });
  assert.equal(res.status, 409, "a take the station is not showing is refused");
  assert.equal(res.body.error, "take_changed");
  assert.equal((await station()).next.key, shown.key, "nothing was attached: the first recording is still waiting");
  await clearStation();
});
