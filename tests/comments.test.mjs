// Comments: first name only, emails never leave the server, hidden rows never returned.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import * as comments from "../functions/api/comments.js";
import * as likes from "../functions/api/likes.js";
import * as me from "../functions/api/me.js";
import * as state from "../functions/api/state.js";
import * as voters from "../functions/api/voters.js";
import { COMMENT_MAX_CHARS, LIMITS } from "../functions/_lib/config.js";
import { acceptedBeforeLimit, addTrack, call, makeEnv, signUp } from "./helpers.mjs";

let env, dispose, jane, omar;
before(async () => {
  ({ env, dispose } = await makeEnv());
  await addTrack(env, "brian");
  await addTrack(env, "caleb");
  jane = await signUp(env, voters, { name: "Jane Q. Doe-Smith", email: "jane.private@example.com", city: "Secretville" });
  omar = await signUp(env, voters, { name: "omar", email: "omar.private@example.org", city: "Hiddenton" });
});
after(() => dispose());
const say = (who, body) => call(comments.onRequest, env, { method: "POST", path: "/api/comments", token: who.token, body });
const read = (qs) => call(comments.onRequest, env, { path: `/api/comments?${qs}` });

test("a comment is stored and returned with the first name only, text and time", async () => {
  const res = await say(jane, { track: "brian", text: "  This one goes hard  " });
  assert.equal(res.status, 201);
  assert.deepEqual(Object.keys(res.body.comment).sort(), ["created_at", "first_name", "gif", "id", "text"]);
  assert.equal(res.body.comment.first_name, "Jane");
  assert.equal(res.body.comment.text, "This one goes hard");
  assert.equal(res.body.comments, 1);
  const list = await read("track=brian");
  assert.equal(list.body.total, 1);
  assert.deepEqual(list.body.comments[0], res.body.comment);
});

test("a GIF comment stores the Giphy id and only a Giphy URL", async () => {
  const ok = await say(omar, { track: "brian", gif: { id: "3o7TKsQ8UQ4l4LhGz6", url: "https://media2.giphy.com/media/3o7TKsQ8UQ4l4LhGz6/200.gif?cid=abc" } });
  assert.equal(ok.status, 201);
  assert.deepEqual(ok.body.comment.gif, { id: "3o7TKsQ8UQ4l4LhGz6", url: "https://media2.giphy.com/media/3o7TKsQ8UQ4l4LhGz6/200.gif?cid=abc" });
  assert.equal(ok.body.comment.text, "");
  const swapped = await say(omar, { track: "brian", text: "look", gif: { id: "abc123", url: "https://evil.example/x.gif" } });
  assert.equal(swapped.body.comment.gif.url, "https://media.giphy.com/media/abc123/giphy.gif", "a non-Giphy URL is replaced by Giphy's own");
  const lookalike = await say(omar, { track: "brian", gif: { id: "abc123", url: "https://giphy.com.evil.example/x.gif" } });
  assert.equal(lookalike.body.comment.gif.url, "https://media.giphy.com/media/abc123/giphy.gif");
  const bad = await say(omar, { track: "brian", gif: { id: "../../etc" } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, "bad_gif");
});

test("empty and oversized comments are refused; unknown tracks too", async () => {
  assert.equal((await say(jane, { track: "brian", text: "   " })).body.error, "empty_comment");
  assert.equal((await say(jane, { track: "brian", text: "x".repeat(COMMENT_MAX_CHARS + 1) })).body.error, "comment_too_long");
  assert.equal((await say(jane, { track: "nope", text: "hi" })).status, 404);
  assert.equal((await read("track=nope")).status, 404);
  assert.equal((await read("")).status, 400);
  assert.equal((await call(comments.onRequest, env, { method: "POST", path: "/api/comments", body: { track: "brian", text: "anon" } })).status, 401);
});

test("hidden comments are never returned and never counted", async () => {
  const res = await say(jane, { track: "caleb", text: "hide me please" });
  await say(omar, { track: "caleb", text: "keep me" });
  await env.DB.prepare("UPDATE comments SET hidden = 1 WHERE id = ?1").bind(res.body.comment.id).run();
  const list = await read("track=caleb");
  assert.equal(list.body.total, 1);
  assert.deepEqual(list.body.comments.map((c) => c.text), ["keep me"]);
  assert.ok(!list.text.includes("hide me please"));
  state._resetStateMemo();
  const s = await call(state.onRequest, env, { path: "/api/state" });
  assert.equal(s.body.tracks.find((t) => t.slug === "caleb").comments, 1);
  const next = await say(omar, { track: "caleb", text: "another" });
  assert.equal(next.body.comments, 2, "the count a POST returns skips hidden rows too");
});

test("newest at the bottom, with `before` paging back", async () => {
  await env.DB.prepare("DELETE FROM rate_limits").run();
  await addTrack(env, "pager");
  const people = [];
  for (let i = 0; i < 3; i++) people.push(await signUp(env, voters, { name: `P${i} X`, email: `pager${i}@example.com` }));
  for (let i = 1; i <= 12; i++) await say(people[i % 3], { track: "pager", text: `c${i}` });
  const first = await read("track=pager&limit=5");
  assert.deepEqual(first.body.comments.map((c) => c.text), ["c8", "c9", "c10", "c11", "c12"]);
  assert.equal(first.body.has_more, true);
  assert.equal(first.body.total, 12);
  const older = await read(`track=pager&limit=5&before=${first.body.comments[0].id}`);
  assert.deepEqual(older.body.comments.map((c) => c.text), ["c3", "c4", "c5", "c6", "c7"]);
  const oldest = await read(`track=pager&limit=5&before=${older.body.comments[0].id}`);
  assert.deepEqual(oldest.body.comments.map((c) => c.text), ["c1", "c2"]);
  assert.equal(oldest.body.has_more, false);
});

test("no response from any route ever contains an email, a last name or a city", async () => {
  await call(likes.onRequest, env, { method: "POST", path: "/api/likes", token: jane.token, body: { track: "brian" } });
  state._resetStateMemo();
  const responses = [
    await read("track=brian"), await read("track=caleb"),
    await call(state.onRequest, env, { path: "/api/state" }),
    await call(me.onRequest, env, { path: "/api/me", token: jane.token }),
    await call(likes.onRequest, env, { method: "POST", path: "/api/likes", token: omar.token, body: { track: "brian" } }),
    await say(jane, { track: "brian", text: "one more" }),
    await call(voters.onRequest, env, { method: "POST", path: "/api/voters", ip: "203.0.113.200", body: { name: "Jane Q. Doe-Smith", email: "jane.private@example.com", city: "Secretville" } }),
  ];
  for (const res of responses) {
    assert.ok(res.status < 300, `${res.status} ${res.text.slice(0, 80)}`);
    for (const secret of ["@example", "jane.private", "omar.private", "Doe-Smith", "Secretville", "Hiddenton", "ip_hash", "email"]) {
      assert.ok(!res.text.includes(secret), `"${secret}" leaked in: ${res.text.slice(0, 200)}`);
    }
  }
});

test("comments are rate limited per voter", async () => {
  await env.DB.prepare("DELETE FROM rate_limits").run();
  const max = LIMITS.commentsPerVoter.max;
  const accepted = await acceptedBeforeLimit((i) => say(jane, { track: "brian", text: `flood ${i}` }), max);
  assert.ok(accepted >= max && accepted <= 2 * max, `limited after ${accepted}`);
});
