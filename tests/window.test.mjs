// The voting window: one end time, in one place, enforced by the server clock.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { parse } from "smol-toml";
import * as comments from "../functions/api/comments.js";
import * as likes from "../functions/api/likes.js";
import * as state from "../functions/api/state.js";
import * as voters from "../functions/api/voters.js";
import { VOTING_ENDS_AT, VOTING_STARTS_AT, votingEndsAtMs, votingPhase, votingStartsAtMs } from "../functions/_lib/config.js";
import { LONG_OPEN, ROOT, addTrack, call, makeEnv, signUp } from "./helpers.mjs";

let env, dispose, voter;
before(async () => {
  ({ env, dispose } = await makeEnv());
  await addTrack(env, "brian");
  voter = await signUp(env, voters, { email: "window@example.com" });
});
after(() => dispose());
const past = new Date(Date.now() - 60_000).toISOString();
const soon = new Date(Date.now() + 60_000).toISOString();
const act = (e) => Promise.all([
  call(likes.onRequest, e, { method: "POST", path: "/api/likes", token: voter.token, body: { track: "brian", liked: true } }),
  call(comments.onRequest, e, { method: "POST", path: "/api/comments", token: voter.token, body: { track: "brian", text: "hello" } }),
]);
const getState = async (e) => { state._resetStateMemo(); return (await call(state.onRequest, e, { path: "/api/state" })).body; };

test("the end time is Sunday 11 Oct 2026 11:59 PM PDT, and it is written in exactly one file", () => {
  assert.equal(VOTING_ENDS_AT, "2026-10-12T06:59:00Z");
  assert.equal(new Date(VOTING_ENDS_AT).toLocaleString("en-US", { timeZone: "America/Los_Angeles", dateStyle: "full", timeStyle: "short" }), "Sunday, October 11, 2026 at 11:59 PM");
  const hits = [];
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", ".git", ".wrangler", ".work", "exports", "tests"].includes(f.name)) continue;
      const p = path.join(dir, f.name);
      if (f.isDirectory()) walk(p);
      else if (/\.(js|mjs|toml|json|yml|html)$/.test(f.name) && /2026-10-12T06:59/.test(fs.readFileSync(p, "utf8"))) hits.push(path.relative(ROOT, p));
    }
  };
  walk(ROOT);
  assert.deepEqual(hits, ["functions/_lib/config.js"]);
});

test("production carries no end-time override; only preview may move it", () => {
  const cfg = parse(fs.readFileSync(path.join(ROOT, "wrangler.toml"), "utf8"));
  assert.equal(cfg.vars?.VOTING_ENDS_AT, undefined);
  assert.equal(cfg.vars?.ALLOW_END_OVERRIDE, undefined);
  assert.equal(cfg.env.preview.vars.ALLOW_END_OVERRIDE, "1");
  assert.equal(votingEndsAtMs({}, past), Date.parse(VOTING_ENDS_AT), "a settings row means nothing without the switch");
  assert.equal(votingEndsAtMs({ ALLOW_END_OVERRIDE: "1" }, past), Date.parse(past));
  assert.equal(votingEndsAtMs({ ALLOW_END_OVERRIDE: "1" }, "garbage"), Date.parse(VOTING_ENDS_AT), "an unreadable value falls back to the real end");
  assert.equal(votingEndsAtMs({ VOTING_ENDS_AT: soon }, null), Date.parse(soon));
});

test("before the end: likes and comments are accepted and the state is open", async () => {
  const [like, comment] = await act({ ...env, VOTING_ENDS_AT: soon });
  assert.equal(like.status, 200);
  assert.equal(comment.status, 201);
  const s = await getState({ ...env, VOTING_ENDS_AT: soon });
  assert.equal(s.closed, false);
  assert.equal(s.voting_ends_at, soon);
  assert.equal((await getState(env)).voting_ends_at, "2026-10-12T06:59:00.000Z", "with no override the constant is used");
});

test("after the end: the server rejects likes and comments, whatever the browser thinks", async () => {
  const closedEnv = { ...env, VOTING_ENDS_AT: past };
  const eventsBefore = (await env.DB.prepare("SELECT COUNT(*) AS n FROM like_events").first()).n;
  const commentsBefore = (await env.DB.prepare("SELECT COUNT(*) AS n FROM comments").first()).n;
  for (const res of await act(closedEnv)) {
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "voting_closed");
  }
  const unlike = await call(likes.onRequest, closedEnv, { method: "POST", path: "/api/likes", token: voter.token, body: { track: "brian" } });
  assert.equal(unlike.status, 403, "an un-like after close is rejected too");
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM like_events").first()).n, eventsBefore);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM comments").first()).n, commentsBefore);
  const s = await getState(closedEnv);
  assert.equal(s.closed, true);
  assert.equal(s.tracks.length, 1, "tracks stay listed (and playable) after close");
  const read = await call(comments.onRequest, closedEnv, { path: "/api/comments?track=brian" });
  assert.equal(read.status, 200, "comments stay readable after close");
});

test("a short test window: the settings row closes voting only where the environment allows it", async () => {
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('voting_ends_at', ?1)").bind(past).run();
  const [likeProd] = await act(env); // production shape: no switch
  assert.equal(likeProd.status, 200, "production ignores the row");
  assert.equal((await getState(env)).closed, false);
  const previewEnv = { ...env, ALLOW_END_OVERRIDE: "1" };
  for (const res of await act(previewEnv)) assert.equal(res.body.error, "voting_closed");
  assert.equal((await getState(previewEnv)).closed, true);
  await env.DB.prepare("DELETE FROM settings WHERE key = 'voting_ends_at'").run();
  const [reopened] = await act(previewEnv);
  assert.equal(reopened.status, 200, "removing the row reopens it");
});

// ── The start (Scooter, 9 Oct 2026: "Voting starts Sunday, October 11, at 10am ET") ──────────────
const walkSources = (hit) => {
  const hits = [];
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", ".git", ".wrangler", ".work", "exports", "tests"].includes(f.name)) continue;
      const p = path.join(dir, f.name);
      if (f.isDirectory()) walk(p);
      else if (/\.(js|mjs|toml|json|yml|html)$/.test(f.name) && hit.test(fs.readFileSync(p, "utf8"))) hits.push(path.relative(ROOT, p));
    }
  };
  walk(ROOT);
  return hits;
};

test("the start time is Sunday 11 Oct 2026 10 AM ET, and it is written in exactly one file", () => {
  assert.equal(VOTING_STARTS_AT, "2026-10-11T14:00:00Z");
  assert.equal(new Date(VOTING_STARTS_AT).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "full", timeStyle: "short" }), "Sunday, October 11, 2026 at 10:00 AM");
  assert.ok(Date.parse(VOTING_STARTS_AT) < Date.parse(VOTING_ENDS_AT), "it starts before it ends");
  assert.deepEqual(walkSources(/2026-10-11T14:00/), ["functions/_lib/config.js"]);
});

test("production carries no start override; only preview may move it", () => {
  const cfg = parse(fs.readFileSync(path.join(ROOT, "wrangler.toml"), "utf8"));
  assert.equal(cfg.vars?.VOTING_STARTS_AT, undefined);
  assert.equal(cfg.env.preview.vars?.VOTING_STARTS_AT, undefined, "preview moves it with a settings row, not a variable");
  assert.equal(votingStartsAtMs({}, soon), Date.parse(VOTING_STARTS_AT), "a settings row means nothing without the switch");
  assert.equal(votingStartsAtMs({ ALLOW_END_OVERRIDE: "1" }, soon), Date.parse(soon));
  assert.equal(votingStartsAtMs({ ALLOW_END_OVERRIDE: "1" }, "garbage"), Date.parse(VOTING_STARTS_AT));
  assert.equal(votingStartsAtMs({ VOTING_STARTS_AT: past }, null), Date.parse(past));
  const at = (iso) => votingPhase({}, Date.parse(iso), null, null);
  assert.deepEqual([at("2026-10-11T13:59:59Z").notOpen, at("2026-10-11T13:59:59Z").closed], [true, false], "one second before the start");
  assert.deepEqual([at("2026-10-11T14:00:00Z").notOpen, at("2026-10-11T14:00:00Z").closed], [false, false], "at the start it is open");
  assert.deepEqual([at("2026-10-12T06:59:00Z").notOpen, at("2026-10-12T06:59:00Z").closed], [false, true], "at the end it is closed");
  assert.equal(votingPhase({ VOTING_ENDS_AT: past }, Date.now(), null, null).notOpen, false, "closed wins over not open");
});

test("before the start: the server refuses likes and comments, whatever the browser thinks, and the state says so", async () => {
  const early = { ...env, VOTING_STARTS_AT: soon };
  const eventsBefore = (await env.DB.prepare("SELECT COUNT(*) AS n FROM like_events").first()).n;
  const commentsBefore = (await env.DB.prepare("SELECT COUNT(*) AS n FROM comments").first()).n;
  for (const res of await act(early)) {
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "voting_not_open");
    assert.match(res.body.message, /Sunday, October 11, at 10 AM ET/);
  }
  assert.equal((await call(likes.onRequest, early, { method: "POST", path: "/api/likes", token: voter.token, body: { track: "brian" } })).body.error, "voting_not_open", "a toggle too");
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM like_events").first()).n, eventsBefore);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM comments").first()).n, commentsBefore);
  const s = await getState(early);
  assert.deepEqual([s.open, s.closed, s.voting_starts_at], [false, false, soon]);
  assert.equal((await call(comments.onRequest, early, { path: "/api/comments?track=brian" })).status, 200, "comments stay readable");
  assert.equal(s.tracks.length, 1, "tracks stay listed (and playable) before the start");
  const open = await getState({ ...env, VOTING_STARTS_AT: LONG_OPEN });
  assert.deepEqual([open.open, open.closed], [true, false]);
  const real = await getState({ ...env, VOTING_STARTS_AT: undefined });
  assert.equal(real.voting_starts_at, "2026-10-11T14:00:00.000Z", "with no override the constant is used");
});

test("a short test start: the settings row holds voting back only where the environment allows it", async () => {
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('voting_starts_at', ?1)").bind(soon).run();
  const [likeProd] = await act(env);
  assert.equal(likeProd.status, 200, "production ignores the row");
  const previewEnv = { ...env, ALLOW_END_OVERRIDE: "1" };
  for (const res of await act(previewEnv)) assert.equal(res.body.error, "voting_not_open");
  assert.equal((await getState(previewEnv)).open, false);
  await env.DB.prepare("DELETE FROM settings WHERE key = 'voting_starts_at'").run();
  const [reopened] = await act(previewEnv);
  assert.equal(reopened.status, 200, "removing the row opens it");
});
