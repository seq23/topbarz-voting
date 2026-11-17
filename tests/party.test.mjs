// The holiday party (Scooter, 17 Nov 2026, with his preview notes the same day): the QR sign-up (a
// group on one phone, handed around), the team's line with its four lanes and sign-in, the
// engineer picking the song's group from the upload station, the contest entry on /track and the
// song going into the vote by itself, the gallery GIFs and the switch. Against a real local D1 and R2.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import * as booth from "../functions/api/booth/[[path]].js";
import * as party from "../functions/api/party/[[path]].js";
import * as state from "../functions/api/state.js";
import { contestVerdict, freshSlug, voteLabel } from "../functions/_lib/contest.js";
import { cleanInstagram, groupLabel, isSessionCode, laneOf, lineOrder, parseSignUp, randomSessionCode } from "../functions/_lib/party.js";
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
const slot = (name, email) => ({ name, phone: "(555) 010-2030", email, city: "Brooklyn", instagram: "" });
const guest = (name, email, extra = {}) => post("join", { ...slot(name, email), website: "", ...extra });
// A group signed up on one phone, handed around: [[name, email], …].
const group = (people) => post("join", { guests: people.map(([n, e]) => slot(n, e)), website: "" });
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
const sessionOf = async (email) => (await env.DB.prepare("SELECT session_id FROM party_guests WHERE email = ?1").bind(email).first()).session_id;
const move = async (email, from, status, token) => post(`team/sessions/${await sessionOf(email)}/status`, { status, from }, { token });
// Green, then red: the group is out of the booth, at the upload station. → the session id.
async function outOfBooth(email, token) {
  assert.equal((await move(email, "waiting", "booth", token)).status, 200);
  assert.equal((await move(email, "booth", "upload", token)).status, 200);
  return sessionOf(email);
}
const pickable = async () => (await call(booth.onRequest, env, { path: "/api/booth/sessions", params: { path: ["sessions"] } })).body.sessions;
const inVote = async (label) => (await stateNow()).tracks.some((t) => t.label === label);

test("rules: a sign-up is one person or a group of up to 10 on one phone, each with name, phone, email and city; Instagram is optional", () => {
  for (let i = 0; i < 300; i++) assert.ok(isSessionCode(randomSessionCode()));
  assert.ok(!/[IO0-9]/.test([...Array(300)].map(() => randomSessionCode()).join("")), "the group's own id has no look-alike characters");
  const ok = parseSignUp({ name: " Jay  Smith ", phone: "+1 555 010 2030", email: "Jay@Example.com", city: "Brooklyn", instagram: "@jay.bars" });
  assert.deepEqual(ok.value, { guests: [{ name: "Jay Smith", phone: "+15550102030", email: "jay@example.com", city: "Brooklyn", instagram: "@jay.bars" }] });
  const base = { name: "A", phone: "5550102030", email: "a@b.co", city: "X" };
  for (const [field, body] of [["name", { name: "" }], ["phone", { phone: "call me" }], ["email", { email: "nope" }], ["city", { city: " " }], ["instagram", { instagram: "not a handle!" }], ["website", { website: "bot" }]]) {
    assert.equal(parseSignUp({ ...base, ...body }).field, field, field);
  }
  const two = parseSignUp({ guests: [base, { ...base, email: "b@b.co", phone: "" }] });
  assert.deepEqual([two.field, two.slot], ["phone", 1], "a group's problem names its slot");
  assert.equal(parseSignUp({ guests: [base, { ...base, email: "A@B.co" }] }).error, "same_email", "each person their own email");
  assert.equal(parseSignUp({ guests: Array.from({ length: 11 }, (_, i) => ({ ...base, email: `p${i}@b.co` })) }).error, "too_many");
  assert.equal(parseSignUp({ guests: Array.from({ length: 10 }, (_, i) => ({ ...base, email: `p${i}@b.co` })) }).value.guests.length, 10);
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

test("group sign-up on one phone: each person's own slot, one group in sign-up order; one active place per email, and back in line once done", async () => {
  const token = await teamToken();
  const a = await group([["Jay Smith", "jay@example.com"], ["Mo Lee", "mo@example.com"], ["Kim Park", "kim@example.com"]]);
  assert.equal(a.status, 201, a.text);
  assert.deepEqual(a.body.session.names, ["Jay", "Mo", "Kim"]);
  assert.equal(a.body.session.size, 3);
  assert.equal(a.body.session.status, "waiting");
  assert.ok(Number.isInteger(a.body.session.place) && a.body.session.place >= 1);
  assert.ok(!("code" in a.body.session), "no group code to hand around any more");
  const sid = await sessionOf("jay@example.com");
  assert.equal(await sessionOf("kim@example.com"), sid, "one group");
  const row = (await get("team/line", { token })).body.sessions.find((s) => s.id === sid);
  assert.deepEqual(row.guests.map((g) => [g.name, g.email]), [["Jay Smith", "jay@example.com"], ["Mo Lee", "mo@example.com"], ["Kim Park", "kim@example.com"]], "the team sees each person's own details, in slot order");
  // Privacy: the sign-up phone is answered first names and the place, never a phone, an email or a last name.
  assert.ok(!/555|@|Smith|Lee|Park|Brooklyn/.test(JSON.stringify({ ...a.body, guest_key: "" })), JSON.stringify(a.body));
  assert.deepEqual((await post("me", { guest_key: a.body.guest_key })).body.session.names, ["Jay", "Mo", "Kim"]);
  assert.equal((await post("me", { guest_key: "0".repeat(24) })).body.error, "no_guest");
  // A bad slot: nobody in the group is written.
  const bad = await post("join", { guests: [slot("Zed One", "zed1@example.com"), { ...slot("Zed Two", "zed2@example.com"), city: "" }], website: "" });
  assert.equal(bad.status, 400);
  assert.deepEqual([bad.body.error, bad.body.slot], ["city_required", 1]);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM party_guests WHERE email LIKE 'zed%'").first()).n, 0);
  // One active place per person: refused with what is happening, and the slot it is about.
  const again = await group([["New Pal", "pal@example.com"], ["Mo Lee", "MO@example.com"]]);
  assert.equal(again.status, 409);
  assert.equal(again.body.error, "already_in_line");
  assert.equal(again.body.slot, 1);
  assert.match(again.body.message, /Person 2 \(Mo Lee\): this email is already in line\. One place at a time: once that group's song is uploaded/);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM party_guests WHERE email = 'pal@example.com'").first()).n, 0, "the group goes in whole or not at all");
  await outOfBooth("jay@example.com", token);
  const atUpload = await guest("Mo Lee", "mo@example.com");
  assert.equal(atUpload.body.error, "already_in_line");
  assert.match(atUpload.body.message, /just out of the booth, waiting for their song to be uploaded/);
  // Done (the song uploaded, or the team marks it): the same people get back in line, in a new group.
  assert.equal((await move("jay@example.com", "upload", "done", token)).status, 200);
  const back = await group([["Mo Lee", "mo@example.com"], ["Pal New", "pal@example.com"]]);
  assert.equal(back.status, 201, back.text);
  assert.deepEqual(back.body.session.names, ["Mo", "Pal"]);
  assert.notEqual(await sessionOf("mo@example.com"), sid);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM party_guests WHERE email = 'mo@example.com'").first()).n, 1, "still one row per person");
  const visits = (await env.DB.prepare("SELECT v.session_id FROM party_visits v JOIN party_guests g ON g.id = v.guest_id WHERE g.email = 'mo@example.com' ORDER BY v.id").all()).results;
  assert.deepEqual(visits.map((v) => v.session_id === sid), [true, false], "both visits kept");
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

test("the upload station: the engineer picks only a group just out of the booth, never the one in it; the upload lands the song on that group and the group is done", async () => {
  const token = await teamToken();
  await group([["Ola First", "ola@example.com"], ["Bo Second", "bo@example.com"]]);
  await guest("Cy Next", "cy@example.com");
  const first = await sessionOf("ola@example.com");
  await move("ola@example.com", "waiting", "booth", token);
  assert.ok(!(await pickable()).some((g) => g.id === first), "a group still in the booth is not offered");
  assert.equal((await upload("Too Soon.mp3", { "x-party-session": String(first) })).body.error, "session_not_in_booth");
  await move("ola@example.com", "booth", "upload", token);
  // The next group goes in while the engineer is still saving the first one's file.
  await move("cy@example.com", "waiting", "booth", token);
  const offered = await pickable();
  const g = offered.find((x) => x.id === first);
  assert.deepEqual([g?.names, g?.size], ["Ola & Bo", 2]);
  assert.ok(!offered.some((x) => x.names === "Cy"), "the group in the booth now is not the one the engineer uploads for");
  assert.ok(!/@|First|Second/.test(JSON.stringify(offered)), "first names only on the open booth page");
  const up = await upload("Ola And Bo.mp3", { "x-party-session": String(first) });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal(up.body.tagged, true);
  const people = (await env.DB.prepare("SELECT p.email FROM booth_people p JOIN booth_tracks b ON b.id = p.track_id WHERE b.code = ?1 ORDER BY p.email").bind(up.body.code).all()).results.map((r) => r.email);
  assert.deepEqual(people, ["bo@example.com", "ola@example.com"], "the song is the picked group's");
  assert.equal((await get("team/line", { token })).body.sessions.find((s) => s.id === first).status, "done", "the upload moves the group to done");
  assert.ok(!(await pickable()).some((x) => x.id === first), "and off the engineer's list");
  assert.equal((await upload("Again.mp3", { "x-party-session": String(first) })).body.error, "session_not_in_booth", "a stale pick is refused, never silently dropped");
  const ev = (await env.DB.prepare("SELECT from_status, to_status, member_id FROM party_status_events WHERE session_id = ?1 ORDER BY id DESC LIMIT 1").bind(first).first());
  assert.deepEqual(ev, { from_status: "upload", to_status: "done", member_id: 0 }, "the upload is on the line's record");
});

test("contest verdict: entered by someone on it, and a group song confirmed with the group; Scooter Taylor and test files in production are refused", () => {
  const track = { file_name: "Jingle.mp3" };
  const ticked = { ...track, contest_entered_at: 1 };
  const both = { ...ticked, contest_confirmed_at: 2 };
  const p = (name) => ({ name });
  assert.equal(contestVerdict({ track: both, people: [] }).reason, "nobody_attached");
  assert.equal(contestVerdict({ track, people: [p("Jay A")] }).reason, "not_entered");
  assert.ok(contestVerdict({ track: ticked, people: [p("Jay A")] }).ok, "a solo song is in with its one tick");
  assert.deepEqual([contestVerdict({ track: ticked, people: [p("Jay A"), p("Mo B")] }).reason, contestVerdict({ track: ticked, people: [p("Jay A"), p("Mo B")] }).step], ["needs_group", "needs_group"], "a group song waits for the group's confirmation");
  assert.ok(contestVerdict({ track: both, people: [p("Jay A"), p("Mo B"), p("Kim C")] }).ok);
  assert.equal(contestVerdict({ track: { ...both, pulled_at: 3 }, people: [p("Jay A")] }).reason, "pulled_by_team");
  assert.equal(contestVerdict({ track: { ...both, file_name: "Scooter Taylor.mp3" }, people: [p("Jay A")] }).reason, "scooter_taylor");
  assert.equal(contestVerdict({ track: both, people: [p("Scooter Taylor")] }).reason, "scooter_taylor", "nor anyone on it");
  assert.equal(contestVerdict({ track: { ...both, title: "scootertaylor" }, people: [p("Jay A")] }).reason, "scooter_taylor", "nor its title");
  assert.equal(contestVerdict({ track: { ...both, file_name: "Test - Jingle.mp3" }, people: [p("Jay A")], production: true }).reason, "test_file_in_production");
  assert.ok(contestVerdict({ track: { ...both, file_name: "Test - Jingle.mp3" }, people: [p("Jay A")], production: false }).ok, "preview takes test files");
  assert.equal(voteLabel({ title: "" }, [p("Jay A"), p("Mo B"), p("Kim C")]), "Jay, Mo & Kim");
  assert.equal(voteLabel({ title: " Sleigh  Ride " }, [p("Jay A")]), "Sleigh Ride");
  assert.equal(freshSlug("Jay & Mo", new Set(["jay-mo"])), "jay-mo-2");
});

// The group's song, uploaded from the upload station. → the 4-digit code.
async function groupSong(people, file, token) {
  await group(people);
  const sid = await outOfBooth(people[0][1], token);
  const up = await upload(file, { "x-party-session": String(sid) });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  return up.body.code;
}

test("the group song: someone ticks Enter (rules agreed), then confirms with the group, and it is in the vote for everyone; everyone sees who did what; unticking takes it out", async () => {
  const token = await teamToken();
  const songCode = await groupSong([["Jay Holly", "jay.h@example.com"], ["Mo Ivy", "mo.i@example.com"], ["Kim Fir", "kim.f@example.com"]], "Jingle Bars.mp3", token);
  const view = await B(songCode, "contest-status", { email: "mo.i@example.com" });
  assert.equal(view.status, 200, view.text);
  assert.deepEqual(view.body.contest.people.map((p) => p.first_name), ["Jay", "Mo", "Kim"], "all three are on the song before anyone opens /track");
  assert.deepEqual([view.body.contest.group, view.body.contest.ticked, view.body.contest.step, view.body.contest.you.performer], [true, false, "not_entered", true]);
  assert.equal(view.body.contest.rules_url, "/holiday-rules");
  assert.ok(!/@/.test(JSON.stringify(view.body.contest)), "no email for anyone");
  assert.equal((await B(songCode, "contest", { email: "jay.h@example.com", enter: true })).body.error, "agree_required", "ticking needs the rules agreement");
  // Jay ticks Enter: recorded, but a group song is not in until it is confirmed with the group.
  const ticked = await B(songCode, "contest", { email: "jay.h@example.com", enter: true, agree: true });
  assert.equal(ticked.status, 200, ticked.text);
  assert.deepEqual([ticked.body.contest.ticked, ticked.body.contest.ticked_by, ticked.body.contest.entered, ticked.body.contest.step], [true, "Jay", false, "needs_group"]);
  const label = () => env.DB.prepare("SELECT t.label, t.active FROM tracks t JOIN booth_tracks b ON b.vote_track_id = t.id WHERE b.code = ?1").bind(songCode).first();
  assert.equal(await label(), null, "ticked but not confirmed with the group: not in the vote");
  const kimSees = (await B(songCode, "contest-status", { email: "kim.f@example.com" })).body.contest;
  assert.deepEqual([kimSees.ticked, kimSees.ticked_by, kimSees.confirmed], [true, "Jay", false], "everyone on the song sees who ticked");
  // Mo confirms with the group: in the vote, with no script run.
  const confirmed = await B(songCode, "contest", { email: "mo.i@example.com", enter: true, agree: true, group_confirmed: true });
  assert.deepEqual([confirmed.body.contest.entered, confirmed.body.contest.ticked_by, confirmed.body.contest.confirmed_by, confirmed.body.contest.step], [true, "Jay", "Mo", "in"]);
  assert.deepEqual(await label(), { label: "Jay, Mo & Kim", active: 1 });
  assert.ok(await inVote("Jay, Mo & Kim"), "it shows in the vote");
  const rec = await env.DB.prepare("SELECT contest_entered_by, contest_entered_at, contest_rules_version, contest_confirmed_by, contest_confirmed_at FROM booth_tracks WHERE code = ?1").bind(songCode).first();
  assert.deepEqual([rec.contest_entered_by, rec.contest_rules_version, rec.contest_confirmed_by], ["jay.h@example.com", "holiday-2026-draft-2", "mo.i@example.com"], "who ticked, which rules, and who confirmed are kept");
  assert.ok(rec.contest_entered_at > 0 && rec.contest_confirmed_at > 0);
  // A title anyone on it sets is its name in the vote.
  const titled = await B(songCode, "title", { email: "kim.f@example.com", title: "Sleigh Bars" });
  assert.equal(titled.body.title, "Sleigh Bars");
  assert.equal((await label()).label, "Sleigh Bars");
  // Unticking the confirmation takes it out; confirming again puts the same track back.
  assert.equal((await B(songCode, "contest", { email: "kim.f@example.com", enter: true, agree: true, group_confirmed: false })).body.contest.entered, false);
  assert.equal((await label()).active, 0);
  const slug = (await env.DB.prepare("SELECT t.slug FROM tracks t JOIN booth_tracks b ON b.vote_track_id = t.id WHERE b.code = ?1").bind(songCode).first()).slug;
  await B(songCode, "contest", { email: "kim.f@example.com", enter: true, agree: true, group_confirmed: true });
  assert.equal((await label()).active, 1);
  assert.equal((await env.DB.prepare("SELECT t.slug FROM tracks t JOIN booth_tracks b ON b.vote_track_id = t.id WHERE b.code = ?1").bind(songCode).first()).slug, slug, "the same track, the same link");
  // Anyone on it unticks Enter: out for everyone, the entry cleared, likes kept.
  const out = await B(songCode, "contest", { email: "mo.i@example.com", enter: false });
  assert.deepEqual([out.body.contest.entered, out.body.contest.ticked, out.body.contest.confirmed], [false, false, false]);
  assert.ok(!(await inVote("Sleigh Bars")));
  // Someone not on the song cannot enter or read it.
  assert.equal((await B(songCode, "contest", { email: "stranger@example.com", enter: true, agree: true })).body.error, "not_attached");
  assert.equal((await B(songCode, "contest-status", { email: "stranger@example.com" })).body.error, "not_attached");
});

test("typing a song's code hears and downloads it, and never puts anyone on it; a solo song is in with one tick; Scooter's file and test files in production never go in", async () => {
  const token = await teamToken();
  const code = await groupSong([["Solo Sol", "sol@example.com"]], "Solo Jingle.mp3", token);
  const count = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM booth_people p JOIN booth_tracks b ON b.id = p.track_id WHERE b.code = ?1").bind(code).first()).n;
  const heard = await B(code, "enter", { email: "plusone@example.com" });
  assert.equal(heard.status, 200);
  assert.ok(heard.body.audio_url && heard.body.download_url, "hear and download");
  assert.deepEqual([heard.body.contest.on, heard.body.contest.you.performer], [true, false], "a listener, not a performer");
  assert.equal(await count(), 1, "typing the code never attaches anyone");
  for (const what of ["contest", "title", "public"]) assert.equal((await B(code, what, { email: "plusone@example.com", enter: true, agree: true, title: "x", public: true })).body.error, "not_attached", what);
  const mine = await B(code, "enter", { email: "sol@example.com" });
  assert.equal(mine.body.contest.you.performer, true);
  const ok = await B(code, "contest", { email: "sol@example.com", enter: true, agree: true });
  assert.equal(ok.body.contest.entered, true, "a solo artist enters with one tick");
  assert.equal(ok.body.contest.group, false);
  assert.ok(await inVote("Solo"));
  // A walk-up upload (no group picked) has nobody on it: hear and download only.
  const walk = await upload("Walk Up.mp3");
  assert.equal((await B(walk.body.code, "enter", { email: "sol@example.com" })).body.contest.you.performer, false);
  // Scooter Taylor's file: never.
  const scooter = await groupSong([["Pat Booth", "pat@example.com"]], "Scooter Taylor - Jingle.mp3", token);
  const refused = await B(scooter, "contest", { email: "pat@example.com", enter: true, agree: true });
  assert.deepEqual([refused.body.contest.entered, refused.body.contest.blocked], [false, "scooter_taylor"]);
  assert.ok(!(await stateNow()).tracks.some((t) => /scooter/i.test(t.label)));
  // A test file in production: never.
  const prodEnv = { ...env, APP_ENV: "production" };
  await group([["Tess Prod", "tess@example.com"]]);
  const sid = await outOfBooth("tess@example.com", token);
  const test1 = await upload("Test - Jingle.mp3", { "x-party-session": String(sid) }, prodEnv);
  const t = await B(test1.body.code, "contest", { email: "tess@example.com", enter: true, agree: true }, freshIp(), prodEnv);
  assert.deepEqual([t.body.contest.entered, t.body.contest.blocked], [false, "test_file_in_production"]);
});

test("the team's songs: who entered and who confirmed, by first name; Remove takes off someone who did neither (the song is judged again); a person who ticked is never removed", async () => {
  const token = await teamToken();
  const code = await groupSong([["Rae Lead", "rae@example.com"], ["Gus Gone", "gus@example.com"]], "Team View.mp3", token);
  await B(code, "contest", { email: "rae@example.com", enter: true, agree: true });
  let listed = (await get("team/songs", { token })).body.songs.find((s) => s.code === code);
  assert.deepEqual([listed.entered, listed.ticked, listed.ticked_by, listed.confirmed, listed.people], [false, true, "Rae", false, 2], "waiting on the group's confirmation, in front of the team");
  assert.ok(!JSON.stringify(listed).includes("@"), "never an email");
  const rae = listed.members.find((m) => m.first_name === "Rae");
  const gus = listed.members.find((m) => m.first_name === "Gus");
  assert.equal((await post(`team/songs/${code}/people/${gus.id}/remove`, {})).body.error, "team_sign_in", "only the team removes");
  const kept = await post(`team/songs/${code}/people/${rae.id}/remove`, {}, { token });
  assert.deepEqual([kept.status, kept.body.error], [409, "ticked"], "the person who ticked is never removed by the team");
  const closedEnv = { ...env, VOTING_ENDS_AT: "2020-06-01T00:00:00Z" };
  assert.equal((await post(`team/songs/${code}/people/${gus.id}/remove`, {}, { token, e: closedEnv })).body.error, "voting_closed");
  const removed = await post(`team/songs/${code}/people/${gus.id}/remove`, {}, { token });
  assert.equal(removed.status, 200, removed.text);
  assert.deepEqual([removed.body.song.entered, removed.body.song.people], [true, 1], "judged again on the people left: a solo song with its tick, in");
  assert.equal((await post(`team/songs/${code}/people/${gus.id}/remove`, {}, { token })).status, 404, "removing twice says they are gone");
});

test("a song uploaded with nobody on it is never stuck: the team puts the group that recorded it on it (still in the booth, at the station, or a walk-up who signed up after), once, team only", async () => {
  const token = await teamToken();
  // Scooter's timing case: the engineer uploads before the team taps the group Out.
  await group([["Uma Early", "uma@example.com"], ["Vic Early", "vic@example.com"]]);
  await move("uma@example.com", "waiting", "booth", token);
  const groupId = await sessionOf("uma@example.com");
  const up = await upload("Too Early.mp3");
  assert.equal(up.status, 200, JSON.stringify(up.body));
  const code = up.body.code;
  let listed = (await get("team/songs", { token })).body.songs.find((s) => s.code === code);
  assert.deepEqual([listed?.needs_group, listed?.people], [true, 0], "the untagged song is in front of the team, marked as needing its group");
  const stuck = await B(code, "enter", { email: "uma@example.com" });
  assert.deepEqual([stuck.body.contest.you.performer, stuck.body.contest.nobody], [false, true], "/track says nobody is on it yet");
  assert.equal((await post(`team/songs/${code}/group`, { session_id: groupId })).body.error, "team_sign_in", "only the team");
  assert.equal((await post(`team/songs/${code}/group`, { session_id: "x" }, { token })).body.error, "bad_session");
  const closedEnv = { ...env, VOTING_ENDS_AT: "2020-06-01T00:00:00Z" };
  assert.equal((await post(`team/songs/${code}/group`, { session_id: groupId }, { token, e: closedEnv })).body.error, "voting_closed");
  const put = await post(`team/songs/${code}/group`, { session_id: groupId }, { token });
  assert.equal(put.status, 200, put.text);
  assert.deepEqual([put.body.song.people, put.body.song.needs_group], [2, false]);
  const people = (await env.DB.prepare("SELECT p.email FROM booth_people p JOIN booth_tracks b ON b.id = p.track_id WHERE b.code = ?1 ORDER BY p.email").bind(code).all()).results.map((r) => r.email);
  assert.deepEqual(people, ["uma@example.com", "vic@example.com"], "the song is now that group's, exactly as a tagged upload would make it");
  assert.equal((await get("team/line", { token })).body.sessions.find((s) => s.id === groupId).status, "done", "and the group is done");
  const ev = await env.DB.prepare("SELECT from_status, to_status FROM party_status_events WHERE session_id = ?1 ORDER BY id DESC LIMIT 1").bind(groupId).first();
  assert.deepEqual(ev, { from_status: "booth", to_status: "done" }, "on the line's record");
  const now = await B(code, "contest", { email: "uma@example.com", enter: true, agree: true, group_confirmed: true });
  assert.equal(now.status, 200, now.text);
  assert.equal(now.body.contest.entered, true, "the people put on it can enter it");
  // A song that has its people is never handed to another group.
  await guest("Wes Walkup", "wes@example.com");
  const wes = await sessionOf("wes@example.com");
  assert.equal((await post(`team/songs/${code}/group`, { session_id: wes }, { token })).body.error, "has_people");
  // A walk-up who never signed up: the engineer uploads with no group, Wes signs up afterwards (waiting), the team puts him on it.
  const walk = (await upload("Walk Up.mp3")).body.code;
  assert.equal((await post(`team/songs/${walk}/group`, { session_id: groupId }, { token })).body.error, "session_done", "a group whose song is uploaded is not offered again");
  const wesOn = await post(`team/songs/${walk}/group`, { session_id: wes }, { token });
  assert.deepEqual([wesOn.status, wesOn.body.song.people], [200, 1], wesOn.text);
  assert.ok(!JSON.stringify(wesOn.body).includes("@"), "never an email");
});

test("after voting ends nothing moves: the box and the title answer 403 voting_closed", async () => {
  const token = await teamToken();
  const closedEnv = { ...env, VOTING_ENDS_AT: "2020-06-01T00:00:00Z" };
  const code = await groupSong([["Late Comer", "late@example.com"]], "Late.mp3", token);
  assert.equal((await B(code, "contest", { email: "late@example.com", enter: true, agree: true }, freshIp(), closedEnv)).body.error, "voting_closed");
  assert.equal((await B(code, "title", { email: "late@example.com", title: "x" }, freshIp(), closedEnv)).body.error, "voting_closed");
});

test("the team's safety valve: Take out of the vote from /team holds even if it is entered again; Put back re-enters; likes kept; team only", async () => {
  const token = await teamToken();
  const code = await groupSong([["Val Ve", "valve@example.com"]], "Valve Jingle.mp3", token);
  assert.equal((await B(code, "contest", { email: "valve@example.com", enter: true, agree: true })).body.contest.entered, true);
  const voteId = (await env.DB.prepare("SELECT vote_track_id FROM booth_tracks WHERE code = ?1").bind(code).first()).vote_track_id;
  const iso = new Date().toISOString();
  const voter = await env.DB.prepare("INSERT INTO voters (name, email, email_key, city, created_at) VALUES ('Liker', 'liker.valve@example.com', 'liker.valve@example.com', 'Bronx', ?1) RETURNING id").bind(iso).first();
  await env.DB.prepare("INSERT INTO like_events (track_id, voter_id, action, created_at) VALUES (?1, ?2, 'like', ?3)").bind(voteId, voter.id, iso).run();
  const likesBefore = 1;
  const listed = (await get("team/songs", { token })).body.songs.find((s) => s.code === code);
  const { members, ...rest } = listed;
  assert.deepEqual(rest, { code, label: "Val", entered: true, pulled: false, pulled_at: null, people: 1, needs_group: false, ticked: true, confirmed: false, ticked_by: "Val", confirmed_by: null }, "the team sees the song, in, with who entered it");
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
  assert.ok(!(await inVote("Val")), "out of the vote at once");
  // Entering it again does not put it back: only the team does.
  await B(code, "contest", { email: "valve@example.com", enter: false });
  const again = await B(code, "contest", { email: "valve@example.com", enter: true, agree: true });
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
