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
import { VOTING_ENDS_AT, votingEndsAtMs } from "../functions/_lib/config.js";
import { ROOT, addTrack, call, makeEnv, signUp } from "./helpers.mjs";

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
