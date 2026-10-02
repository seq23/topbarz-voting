// Likes: a toggle, one per voter per track, every like and un-like kept, flagged voters not counted.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import * as likes from "../functions/api/likes.js";
import * as state from "../functions/api/state.js";
import * as voters from "../functions/api/voters.js";
import { LIMITS } from "../functions/_lib/config.js";
import { computeTally } from "../functions/_lib/tally.js";
import { acceptedBeforeLimit, addTrack, call, makeEnv, signUp } from "./helpers.mjs";

let env, dispose;
before(async () => {
  ({ env, dispose } = await makeEnv());
  for (const s of ["brian", "caleb", "carlos", "off"]) await addTrack(env, s, { active: s === "off" ? 0 : 1 });
});
after(() => dispose());
const like = (token, body) => call(likes.onRequest, env, { method: "POST", path: "/api/likes", token, body });
const liveCounts = async () => {
  state._resetStateMemo();
  const res = await call(state.onRequest, env, { path: "/api/state" });
  return Object.fromEntries(res.body.tracks.map((t) => [t.slug, t.likes]));
};

test("tapping like toggles: on, off, on — and the count follows", async () => {
  const v = await signUp(env, voters, { email: "toggle@example.com" });
  const on = await like(v.token, { track: "brian" });
  assert.deepEqual(on.body, { track: "brian", liked: true, likes: 1 });
  const off = await like(v.token, { track: "brian" });
  assert.deepEqual(off.body, { track: "brian", liked: false, likes: 0 });
  const onAgain = await like(v.token, { track: "brian" });
  assert.deepEqual(onAgain.body, { track: "brian", liked: true, likes: 1 });
});

test("every like AND un-like is kept, with a timestamp, in order", async () => {
  const rows = (await env.DB.prepare("SELECT e.action, e.created_at FROM like_events e JOIN voters v ON v.id = e.voter_id WHERE v.email = 'toggle@example.com' ORDER BY e.id").all()).results;
  assert.deepEqual(rows.map((r) => r.action), ["like", "unlike", "like"]);
  for (const r of rows) assert.match(r.created_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  const view = (await env.DB.prepare("SELECT removed_at FROM likes l JOIN voters v ON v.id = l.voter_id WHERE v.email = 'toggle@example.com' ORDER BY l.created_at").all()).results;
  assert.equal(view.length, 2);
  assert.ok(view[0].removed_at, "the first like has its removal time");
  assert.equal(view[1].removed_at, null, "the current like has none");
});

test("one active like per voter per track, however it is asked for", async () => {
  const v = await signUp(env, voters, { email: "once@example.com" });
  for (let i = 0; i < 4; i++) {
    const res = await like(v.token, { track: "caleb", liked: true });
    assert.deepEqual(res.body, { track: "caleb", liked: true, likes: 1 });
  }
  // Parallel taps cannot stack either.
  await Promise.all(Array.from({ length: 6 }, () => like(v.token, { track: "caleb", liked: true })));
  assert.equal((await liveCounts()).caleb, 1);
  const events = (await env.DB.prepare("SELECT COUNT(*) AS n FROM like_events e JOIN voters v ON v.id = e.voter_id WHERE v.email = 'once@example.com'").first()).n;
  assert.equal(events, 1, "repeating the same state writes nothing");
  assert.deepEqual((await like(v.token, { track: "caleb", liked: false })).body, { track: "caleb", liked: false, likes: 0 });
  assert.deepEqual((await like(v.token, { track: "caleb", liked: false })).body, { track: "caleb", liked: false, likes: 0 });
});

test("a voter can like as many different tracks as they want", async () => {
  const v = await signUp(env, voters, { email: "many@example.com" });
  for (const track of ["brian", "caleb", "carlos"]) assert.equal((await like(v.token, { track })).body.liked, true);
  const again = await signUp(env, voters, { email: "many@example.com" });
  assert.deepEqual(again.liked.sort(), ["brian", "caleb", "carlos"]);
});

test("unknown and switched-off tracks cannot be liked", async () => {
  const v = await signUp(env, voters, { email: "ghosttrack@example.com" });
  for (const track of ["nope", "off"]) {
    const res = await like(v.token, { track });
    assert.equal(res.status, 404, track);
    assert.equal(res.body.error, "unknown_track");
  }
  assert.equal((await like(v.token, {})).status, 400);
  assert.equal((await like(v.token, { track: "brian", liked: "yes" })).status, 400);
});

test("a flagged voter's likes stop counting, live and in the tally", async () => {
  const good = await signUp(env, voters, { email: "good@example.com" });
  const bad = await signUp(env, voters, { email: "bad@example.com" });
  const before = (await liveCounts()).carlos;
  await like(good.token, { track: "carlos" });
  await like(bad.token, { track: "carlos" });
  assert.equal((await liveCounts()).carlos, before + 2);
  await env.DB.prepare("UPDATE voters SET flagged = 1, flag_reason = 'test' WHERE email = 'bad@example.com'").run();
  assert.equal((await liveCounts()).carlos, before + 1);
  assert.equal((await like(good.token, { track: "carlos", liked: true })).body.likes, before + 1);
});

test("the export's tally (replayed from events) equals the live count", async () => {
  const tracks = (await env.DB.prepare("SELECT id, slug, label FROM tracks WHERE active = 1").all()).results;
  const events = (await env.DB.prepare("SELECT id, track_id, action, created_at FROM like_events WHERE voter_id NOT IN (SELECT id FROM voters WHERE flagged = 1) ORDER BY id").all()).results;
  assert.ok(events.length > 5, "there are events to replay");
  const tally = Object.fromEntries(computeTally(tracks, events).map((r) => [r.slug, r.likes]));
  assert.deepEqual(tally, await liveCounts());
});

test("likes are rate limited per voter", async () => {
  const v = await signUp(env, voters, { email: "tapper@example.com" });
  const accepted = await acceptedBeforeLimit(() => like(v.token, { track: "brian" }), LIMITS.likesPerVoter.max);
  assert.ok(accepted >= LIMITS.likesPerVoter.max && accepted <= 2 * LIMITS.likesPerVoter.max, `limited after ${accepted}`);
});

test("likes are rate limited per IP", async () => {
  await env.DB.prepare("DELETE FROM rate_limits").run();
  const ip = "192.0.2.77";
  const people = [];
  for (let i = 0; i < 12; i++) people.push(await signUp(env, voters, { email: `shared${i}@example.com` }));
  const accepted = await acceptedBeforeLimit(
    (i) => call(likes.onRequest, env, { method: "POST", path: "/api/likes", token: people[i % 12].token, ip, body: { track: "brian" } }),
    LIMITS.likesPerIp.max,
  );
  assert.ok(accepted >= LIMITS.likesPerIp.max && accepted <= 2 * LIMITS.likesPerIp.max, `limited after ${accepted}`);
});
