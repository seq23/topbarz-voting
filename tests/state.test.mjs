// /api/state, /media/*, the Giphy proxy and the catch-all.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import * as catchAll from "../functions/api/[[path]].js";
import * as search from "../functions/api/giphy/search.js";
import * as trending from "../functions/api/giphy/trending.js";
import * as state from "../functions/api/state.js";
import * as media from "../functions/media/[[path]].js";
import { GIPHY, STATE_CACHE_SECONDS } from "../functions/_lib/config.js";
import { PHOTO_MANIFEST_KEY } from "../functions/_lib/state.js";
import { addTrack, call, freshIp, makeEnv } from "./helpers.mjs";

let env, dispose;
before(async () => {
  ({ env, dispose } = await makeEnv());
  await addTrack(env, "caleb", { sort: 20 });
  await addTrack(env, "brian", { sort: 10, sourceName: "Brian Secret-Lastname" });
  await addTrack(env, "gone", { active: 0 });
});
after(() => dispose());
const getState = (e = env, fresh = true) => { if (fresh) state._resetStateMemo(); return call(state.onRequest, e, { path: "/api/state" }); };

test("state lists active tracks in order with counts, the end time, closed, photos and named states", async () => {
  const res = await getState();
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body).sort(), ["closed", "gate", "giphy", "now", "photos", "tracks", "voting_ends_at"]);
  assert.deepEqual(res.body.tracks, [
    { slug: "brian", label: "Brian", audio_url: "/media/tracks/brian-abc123.mp3", duration_ms: 60000, likes: 0, comments: 0 },
    { slug: "caleb", label: "Caleb", audio_url: "/media/tracks/caleb-abc123.mp3", duration_ms: 60000, likes: 0, comments: 0 },
  ]);
  assert.ok(!res.text.includes("Secret-Lastname"), "a contestant's full name is never returned");
  assert.equal(res.body.closed, false);
  assert.equal(res.body.voting_ends_at, "2026-10-12T06:59:00.000Z");
  assert.deepEqual(res.body.photos, [], "no manifest = no photos = the slider hides");
  assert.deepEqual(res.body.gate, { available: true });
});

test("a missing Giphy key or signing secret is a named state in /api/state, never silently off", async () => {
  assert.deepEqual((await getState()).body.giphy, { available: false, reason: "no_key" });
  assert.deepEqual((await getState({ ...env, GIPHY_BETA_KEY: "k" })).body.giphy, { available: true });
  assert.deepEqual((await getState({ ...env, VOTER_TOKEN_SECRET: "" })).body.gate, { available: false, reason: "token_secret_missing" });
});

test("state is cached for a few seconds so pollers do not each hit the database", async () => {
  const first = await getState();
  assert.equal(first.headers.get("x-state-cache"), "miss");
  assert.equal(first.headers.get("cache-control"), `public, max-age=${STATE_CACHE_SECONDS}`);
  assert.ok(STATE_CACHE_SECONDS >= 3 && STATE_CACHE_SECONDS <= 10);
  await addTrack(env, "late", { sort: 99 });
  const second = await getState(env, false);
  assert.equal(second.headers.get("x-state-cache"), "memory");
  assert.equal(second.body.tracks.length, 2, "served from cache: the new track is not there yet");
  assert.equal((await getState()).body.tracks.length, 3);
  await env.DB.prepare("UPDATE tracks SET active = 0 WHERE slug = 'late'").run();
});

test("the photo manifest in R2 is what state returns", async () => {
  const photos = [{ url: "/media/photos/aaa-1600.jpg", width: 1067, height: 1600, thumb_url: "/media/photos/aaa-640.jpg", thumb_width: 427, thumb_height: 640, alt: "Top Barz at CultureCon, photo 1" }];
  await env.MEDIA.put(PHOTO_MANIFEST_KEY, JSON.stringify({ photos }));
  assert.deepEqual((await getState()).body.photos, photos);
  await env.MEDIA.put(PHOTO_MANIFEST_KEY, "{not json");
  assert.deepEqual((await getState()).body.photos, [], "a broken manifest hides the slider instead of breaking the page");
  await env.MEDIA.delete(PHOTO_MANIFEST_KEY);
});

test("media: long cache, and Range requests answered with 206 (iOS Safari audio)", async () => {
  const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
  await env.MEDIA.put("tracks/brian-abc123.mp3", bytes, { httpMetadata: { contentType: "audio/mpeg" } });
  const get = (headers = {}, method = "GET", p = "tracks/brian-abc123.mp3") => call(media.onRequest, env, { method, path: `/media/${p}`, headers, params: { path: p.split("/") } });

  const full = await get();
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("content-type"), "audio/mpeg");
  assert.equal(full.headers.get("accept-ranges"), "bytes");
  assert.equal(full.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(full.headers.get("content-length"), "1000");
  assert.ok(full.bytes.equals(bytes));

  const probe = await get({ range: "bytes=0-1" }); // what iOS Safari sends first
  assert.equal(probe.status, 206);
  assert.equal(probe.headers.get("content-range"), "bytes 0-1/1000");
  assert.ok(probe.bytes.equals(bytes.subarray(0, 2)));
  const middle = await get({ range: "bytes=100-299" });
  assert.equal(middle.headers.get("content-range"), "bytes 100-299/1000");
  assert.equal(middle.headers.get("content-length"), "200");
  assert.ok(middle.bytes.equals(bytes.subarray(100, 300)));
  const open = await get({ range: "bytes=990-" });
  assert.equal(open.headers.get("content-range"), "bytes 990-999/1000");
  assert.ok(open.bytes.equals(bytes.subarray(990)));
  const suffix = await get({ range: "bytes=-10" });
  assert.equal(suffix.headers.get("content-range"), "bytes 990-999/1000");
  const past = await get({ range: "bytes=500-5000" });
  assert.equal(past.headers.get("content-range"), "bytes 500-999/1000");
  const bad = await get({ range: "bytes=2000-" });
  assert.equal(bad.status, 416);
  assert.equal(bad.headers.get("content-range"), "bytes */1000");

  assert.equal((await get({ "if-none-match": full.headers.get("etag") })).status, 304);
  const head = await get({}, "HEAD");
  assert.equal(head.status, 200);
  assert.equal(head.bytes.length, 0);
  assert.equal((await get({}, "POST")).status, 405);
  assert.equal((await get({}, "GET", "tracks/missing.mp3")).status, 404);
  await env.MEDIA.put("manifest/photos.json", "{}");
  assert.equal((await get({}, "GET", "manifest/photos.json")).status, 404, "only tracks/ and photos/ are served");
  assert.equal((await get({}, "GET", "tracks/../manifest/photos.json")).status, 404);
  await env.MEDIA.delete("manifest/photos.json");
});

test("an unknown /api route is a JSON 404 and a wrong method is a 405", async () => {
  const res = await call(catchAll.onRequest, env, { path: "/api/nothing-here" });
  assert.equal(res.status, 404);
  assert.equal(res.body.error, "not_found");
  assert.equal((await call(state.onRequest, env, { method: "POST", path: "/api/state", body: {} })).status, 405);
});

// ── Giphy ───────────────────────────────────────────────────────────────────────────────────────
const gif = (id) => ({ id, title: `gif ${id}`, images: { fixed_height: { url: `https://media1.giphy.com/media/${id}/200.gif`, width: "356", height: "200" }, fixed_width_small: { url: `https://media1.giphy.com/media/${id}/100w.gif`, width: "100", height: "56" } } });
function stubGiphy(t, handler) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => { calls.push(new URL(String(url))); return handler(new URL(String(url))); };
  t.after(() => { globalThis.fetch = real; });
  return calls;
}
const many = (n) => new Response(JSON.stringify({ data: Array.from({ length: n }, (_, i) => gif(`g${i}`)) }), { status: 200 });
const keyed = () => ({ ...env, GIPHY_BETA_KEY: "beta-key-for-tests" });
const q = (e, term, ip = freshIp()) => call(search.onRequest, e, { path: `/api/giphy/search?q=${encodeURIComponent(term)}`, ip });

test("giphy: with no key both routes answer { available: false } and never call out", async (t) => {
  const calls = stubGiphy(t, () => many(3));
  for (const res of [await call(trending.onRequest, env, { path: "/api/giphy/trending" }), await q(env, "fire")]) {
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { available: false, reason: "no_key", results: [] });
  }
  assert.equal(calls.length, 0);
});

test("giphy: results are trimmed to 12, the key stays server-side, and a term is fetched once", async (t) => {
  const calls = stubGiphy(t, () => many(25));
  const first = await q(keyed(), "  Fire!! ");
  assert.equal(first.body.available, true);
  assert.equal(first.body.cached, false);
  assert.ok(first.body.results.length >= 8 && first.body.results.length <= 12);
  assert.deepEqual(Object.keys(first.body.results[0]).sort(), ["height", "id", "preview_height", "preview_url", "preview_width", "title", "url", "width"]);
  assert.ok(!first.text.includes("beta-key-for-tests"));
  const again = await q(keyed(), "fire");
  assert.equal(again.body.cached, true);
  assert.deepEqual(again.body.results, first.body.results);
  assert.equal(calls.length, 1, "the second ask for the same term is served from cache");
  assert.equal(calls[0].pathname, "/v1/gifs/search");
  assert.equal(calls[0].searchParams.get("q"), "fire");
  assert.equal(calls[0].searchParams.get("limit"), String(GIPHY.pageSize));
  assert.equal((await q(keyed(), "a")).status, 400);
});

test("giphy: trending is one cached call", async (t) => {
  const calls = stubGiphy(t, () => many(12));
  for (let i = 0; i < 5; i++) {
    const res = await call(trending.onRequest, keyed(), { path: "/api/giphy/trending", ip: freshIp() });
    assert.equal(res.body.results.length, 12);
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pathname, "/v1/gifs/trending");
});

test("giphy: the site-wide hourly budget is never exceeded; past it, cache or `limited`", async (t) => {
  assert.ok(GIPHY.budgetPerHour < 100);
  const calls = stubGiphy(t, () => many(9));
  const nowS = Math.floor(Date.now() / 1000);
  const used = (await env.DB.prepare("SELECT COUNT(*) AS n FROM giphy_calls WHERE called_at > ?1").bind(nowS - 3600).first()).n;
  for (let i = used; i < GIPHY.budgetPerHour - 1; i++) await env.DB.prepare("INSERT INTO giphy_calls (called_at) VALUES (?1)").bind(nowS - 60).run();
  assert.equal((await q(keyed(), "last one in budget")).body.cached, false);
  assert.equal(calls.length, 1);
  const over = await q(keyed(), "one too many");
  assert.deepEqual(over.body, { available: true, limited: true, results: [] });
  assert.equal(calls.length, 1, "no upstream call once the budget is spent");
  // A term cached earlier is still served, stale, when over budget.
  await env.DB.prepare("UPDATE giphy_cache SET fetched_at = ?1 WHERE term = 'fire'").bind(nowS - GIPHY.searchTtl - 10).run();
  const stale = await q(keyed(), "fire");
  assert.equal(stale.body.limited, true);
  assert.ok(stale.body.results.length > 0);
  assert.equal(calls.length, 1);
  // Calls older than an hour free the budget again.
  await env.DB.prepare("UPDATE giphy_calls SET called_at = ?1").bind(nowS - 3700).run();
  assert.equal((await q(keyed(), "fresh hour")).body.cached, false);
  assert.equal(calls.length, 2);
});

test("giphy: a rejected key is a named state; an upstream error is not a crash", async (t) => {
  await env.DB.prepare("DELETE FROM giphy_calls").run();
  let status = 403;
  stubGiphy(t, () => new Response("{}", { status }));
  assert.deepEqual((await q(keyed(), "rejected key")).body, { available: false, reason: "key_rejected", results: [] });
  status = 500;
  assert.deepEqual((await q(keyed(), "upstream down")).body, { available: true, degraded: "upstream_error", results: [] });
});
