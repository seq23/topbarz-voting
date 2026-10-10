// The beats behind /select: GET /api/beats, their audio, the loader's refusals, and the one rule
// that matters most — a beat is never a track, so it is never in the vote, the tally or the export.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import * as beats from "../functions/api/beats.js";
import * as comments from "../functions/api/comments.js";
import * as likes from "../functions/api/likes.js";
import * as state from "../functions/api/state.js";
import * as voters from "../functions/api/voters.js";
import * as media from "../functions/media/[[path]].js";
import { BEATS_CACHE_SECONDS, beatsSql, creditUrl } from "../functions/_lib/beats.js";
import { computeTally } from "../functions/_lib/tally.js";
import { tallyCsv } from "../scripts/export.mjs";
import { assertLoadAllowed, isTestFolder, parseBeatFile, planBeats } from "../scripts/lib/names.mjs";
import { ROOT, addTrack, call, makeEnv, signUp } from "./helpers.mjs";

const src = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

async function addBeat(env, slug, { name = slug, sort = 0, active = 1, standIn = 0, creditLabel = null, creditUrl: url = null, sourceName = `${slug} source file` } = {}) {
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO beats (slug, name, source_name, audio_key, duration_ms, sort, active, stand_in, credit_label, credit_url, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 90000, ?5, ?6, ?7, ?8, ?9, ?10, ?10)")
    .bind(slug, name, sourceName, `beats/${slug}-abc123.mp3`, sort, active, standIn, creditLabel, url, now).run();
}

let env, dispose;
before(async () => {
  ({ env, dispose } = await makeEnv());
  await addTrack(env, "brian", { sort: 10 });
  await addBeat(env, "night-drive", { name: "Night Drive", sort: 20, creditLabel: "Kay Beats", creditUrl: "https://example.com/kay" });
  await addBeat(env, "midnight-run", { name: "Midnight Run", sort: 10, sourceName: "01 - Midnight Run SECRET-FILE-NAME" });
  await addBeat(env, "label-only", { name: "Label Only", sort: 30, creditLabel: "  The Engineer  ", creditUrl: "javascript:alert(1)" });
  await addBeat(env, "switched-off", { name: "Switched Off", active: 0 });
  await addBeat(env, "placeholder-beat-1", { name: "Placeholder beat 1", sort: 40, standIn: 1 });
});
after(() => dispose());
const getBeats = (e = env, fresh = true) => { if (fresh) beats._resetBeatsMemo(); return call(beats.onRequest, e, { path: "/api/beats" }); };
const getState = (e = env) => { state._resetStateMemo(); return call(state.onRequest, e, { path: "/api/state" }); };

test("/api/beats lists the active beats in order: slug, name, audio, duration, and a credit only where there is one", async () => {
  const res = await getBeats();
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body), ["beats"]);
  assert.deepEqual(res.body.beats, [
    { slug: "midnight-run", name: "Midnight Run", audio_url: "/media/beats/midnight-run-abc123.mp3", duration_ms: 90000, credit_label: null, credit_url: null },
    { slug: "night-drive", name: "Night Drive", audio_url: "/media/beats/night-drive-abc123.mp3", duration_ms: 90000, credit_label: "Kay Beats", credit_url: "https://example.com/kay" },
    { slug: "label-only", name: "Label Only", audio_url: "/media/beats/label-only-abc123.mp3", duration_ms: 90000, credit_label: "The Engineer", credit_url: null },
    { slug: "placeholder-beat-1", name: "Placeholder beat 1", audio_url: "/media/beats/placeholder-beat-1-abc123.mp3", duration_ms: 90000, credit_label: null, credit_url: null },
  ]);
  assert.ok(!res.text.includes("SECRET-FILE-NAME") && !res.text.includes("source"), "the file's own name is never returned");
  assert.ok(!res.text.includes("switched-off"), "a beat that is switched off is not offered");
  assert.ok(!res.text.includes("brian") && !res.text.includes("tracks/"), "and a track from the vote is never a beat");
});

test("/api/beats: a credit link is https or it is not a link; a link with no label is dropped", () => {
  assert.equal(creditUrl("https://www.instagram.com/someone"), "https://www.instagram.com/someone");
  for (const bad of ["http://example.com/x", "javascript:alert(1)", "data:text/html,x", "//example.com", "/select", "https://user:pw@example.com/", "https://localhost/", "", null, 7, `https://example.com/${"a".repeat(500)}`]) assert.equal(creditUrl(bad), null, String(bad));
});

test("/api/beats with no beats is an empty list (the page's empty state), never an error", async () => {
  const empty = await makeEnv();
  try {
    const res = await getBeats(empty.env);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { beats: [] });
  } finally { await empty.dispose(); }
});

test("/api/beats: production never returns a stand-in, whatever is in its table", async () => {
  const prod = await getBeats({ ...env, APP_ENV: "production" });
  assert.deepEqual(prod.body.beats.map((b) => b.slug), ["midnight-run", "night-drive", "label-only"]);
  assert.ok(!prod.text.toLowerCase().includes("placeholder"));
  assert.equal((await getBeats({ ...env, APP_ENV: "preview" })).body.beats.length, 4, "preview (staging) does");
  assert.match(beatsSql({ APP_ENV: "production" }), /active = 1 AND stand_in = 0/);
  assert.ok(!/stand_in = 0/.test(beatsSql({ APP_ENV: "preview" })));
  assert.match(src("wrangler.toml"), /^\[vars\]\nAPP_ENV = "production"$/m, "and production is the environment that says so");
});

test("/api/beats is read-only and cached for a few seconds", async () => {
  const first = await getBeats();
  assert.equal(first.headers.get("x-beats-cache"), "miss");
  assert.equal(first.headers.get("cache-control"), `public, max-age=${BEATS_CACHE_SECONDS}`);
  assert.ok(BEATS_CACHE_SECONDS >= 3 && BEATS_CACHE_SECONDS <= 10);
  assert.equal((await getBeats(env, false)).headers.get("x-beats-cache"), "memory");
  for (const method of ["POST", "PUT", "DELETE"]) {
    const res = await call(beats.onRequest, env, { method, path: "/api/beats", body: method === "DELETE" ? undefined : { pick: "night-drive" } });
    assert.equal(res.status, 405, `${method} is refused: a pick is never sent to the server`);
  }
  const source = src("functions/api/beats.js") + src("functions/_lib/beats.js");
  assert.ok(!/INSERT|UPDATE|DELETE FROM|\.run\(\)/.test(source), "nothing in the route writes to the database");
});

test("the select page does not depend on the voting window: beats are served the same after voting closes", async () => {
  const closedEnv = { ...env, ALLOW_END_OVERRIDE: "1" };
  await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('voting_ends_at', '2026-10-01T00:00:00Z')").run();
  try {
    assert.equal((await getState(closedEnv)).body.closed, true, "voting is closed");
    const res = await getBeats(closedEnv);
    assert.equal(res.status, 200);
    assert.equal(res.body.beats.length, 4);
  } finally {
    await env.DB.prepare("DELETE FROM settings WHERE key = 'voting_ends_at'").run();
  }
  const source = src("functions/api/beats.js") + src("functions/_lib/beats.js") + src("public/js/select.js") + src("public/js/pick.js");
  assert.ok(!/config\.js|voting_ends_at|votingEndsAt|closed|\/api\/state/.test(source), "neither the route nor the page reads the end time or the vote's state");
});

test("a beat is never in the vote: not in /api/state, not likeable, not commentable, not in the tally or the export", async () => {
  const s = await getState();
  assert.deepEqual(Object.keys(s.body).sort(), ["closed", "gate", "giphy", "now", "open", "photos", "tracks", "verification", "voting_ends_at", "voting_starts_at"], "the shape of /api/state has not changed");
  assert.deepEqual(s.body.tracks, [{ slug: "brian", label: "Brian", audio_url: "/media/tracks/brian-abc123.mp3", duration_ms: 60000, likes: 0, comments: 0 }]);
  assert.ok(!/beat|night-drive|midnight/i.test(s.text), "no beat, by slug, name or audio, is anywhere in /api/state");

  const { token } = await signUp(env, voters, { email: "picker@example.com" });
  assert.ok(token);
  const like = await call(likes.onRequest, env, { method: "POST", path: "/api/likes", token, body: { track: "night-drive", liked: true } });
  assert.deepEqual([like.status, like.body.error], [404, "unknown_track"], "a beat cannot be liked");
  const post = await call(comments.onRequest, env, { method: "POST", path: "/api/comments", token, body: { track: "night-drive", text: "hello" } });
  assert.equal(post.status, 404, "or commented on");
  assert.equal((await call(comments.onRequest, env, { path: "/api/comments?track=night-drive" })).status, 404);
  assert.equal((await call(likes.onRequest, env, { method: "POST", path: "/api/likes", token, body: { track: "brian", liked: true } })).status, 200);

  // The export, run with its own queries against this database: one track, no beat.
  const exportSource = src("scripts/export.mjs");
  const queries = [...exportSource.matchAll(/await d1\(target, "([^"]+)"\)/g)].map((m) => m[1]);
  assert.equal(queries.length, 4, "the export's four queries were read");
  const [trackRows, events, commentRows, voterRows] = await Promise.all(queries.map(async (q) => (await env.DB.prepare(q).all()).results));
  assert.equal(voterRows.length, 1);
  const tally = computeTally(trackRows, events, Object.fromEntries(commentRows.map((r) => [r.track_id, r.n])));
  assert.deepEqual(tally.map((r) => [r.slug, r.likes]), [["brian", 1]]);
  assert.ok(!/beat|night-drive|midnight/i.test(tallyCsv(tally)));

  // And in the code: nothing that serves the vote reads the beats table, and nothing that serves
  // the beats reads the vote's tables.
  const vote = ["functions/_lib/state.js", "functions/_lib/tally.js", "functions/_lib/verify.js", "functions/api/state.js", "functions/api/likes.js", "functions/api/comments.js", "functions/api/me.js", "functions/api/voters.js", "scripts/export.mjs", "scripts/load-tracks.mjs", "scripts/load-photos.mjs", "public/index.html", "public/js/app.js", "public/js/comments.js", "public/js/gate.js", "public/js/gallery.js", "public/js/api.js", "public/js/logic.js"];
  for (const file of vote) assert.ok(!/\bbeats?\b/i.test(src(file)), `${file} never mentions a beat`);
  const beatSql = beatsSql({}) + [...src("scripts/load-beats.mjs").matchAll(/(?:FROM|INTO|UPDATE) ([a-z_]+)/g)].map((m) => m[1]).join(" ");
  assert.ok(/\bbeats\b/.test(beatSql) && !/\b(tracks|like_events|likes|voters|comments|settings)\b/.test(beatSql), "the beats code reads and writes the beats table only");
  const migration = src("migrations/0003_beats.sql").replace(/--.*$/gm, "");
  assert.match(migration, /CREATE TABLE beats \(/);
  assert.ok(!/\b(tracks|like_events|voters|comments)\b/.test(migration) && !/ALTER TABLE|DROP /.test(migration), "the migration adds the beats table and touches nothing else");
});

test("beat audio is served the way track audio is: /media/beats/…, long cache, Range answered with 206", async () => {
  const bytes = new Uint8Array(4096).map((_, i) => i % 251);
  await env.MEDIA.put("beats/night-drive-abc123.mp3", bytes, { httpMetadata: { contentType: "audio/mpeg" } });
  const get = (p, headers) => call(media.onRequest, env, { path: `/media/${p}`, headers, params: { path: p.split("/") } });
  const whole = await get("beats/night-drive-abc123.mp3");
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get("content-type"), "audio/mpeg");
  assert.equal(whole.headers.get("accept-ranges"), "bytes");
  assert.match(whole.headers.get("cache-control"), /immutable/);
  assert.equal(whole.bytes.length, 4096);
  const part = await get("beats/night-drive-abc123.mp3", { range: "bytes=10-19" });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), "bytes 10-19/4096");
  assert.deepEqual([...part.bytes], [...bytes.slice(10, 20)]);
  assert.equal((await get("beats/nope-0000000000.mp3")).status, 404);
  for (const p of ["manifest/photos.json", "exports/tally.csv", "beats/../manifest/photos.json"]) assert.equal((await get(p)).status, 404, `${p} is not reachable under /media`);
});

// ── The loader ───────────────────────────────────────────────────────────────────────────────
const loader = (...args) => spawnSync(process.execPath, [path.join(ROOT, "scripts/load-beats.mjs"), ...args], { encoding: "utf8" });

test("load-beats: a file becomes a beat named for the file; a slug and a name never change once given", () => {
  assert.deepEqual(parseBeatFile("02 - Midnight Run.wav"), { sourceName: "02 - Midnight Run", name: "Midnight Run", slugBase: "midnight-run" });
  assert.equal(parseBeatFile("808 Dreams.mp3").name, "808 Dreams", "a number that is part of the name stays");
  assert.equal(parseBeatFile("3. Café  Noir.mp3").slugBase, "cafe-noir");
  const existing = [{ slug: "midnight-run", name: "Midnight Run (renamed by hand)", source_name: "02 - Midnight Run" }];
  const plan = planBeats(["01 - Night Drive.mp3", "02 - Midnight Run.wav", "03 - Midnight Run.mp3", "Placeholder Beat 1.mp3"], existing);
  assert.deepEqual(plan.map((p) => [p.slug, p.name, p.standIn, p.isNew]), [
    ["night-drive", "Night Drive", false, true],
    ["midnight-run", "Midnight Run (renamed by hand)", false, false],
    ["midnight-run-2", "Midnight Run", false, true],
    ["beat-placeholder-beat-1", "Placeholder Beat 1", false, true],
  ]);
  assert.equal(new Set(plan.map((p) => p.slug)).size, plan.length);
});

test("load-beats: a test file is a stand-in, shown as \"Placeholder beat N\" and never under its own name", () => {
  const testTracks = ["Test - Brian.mp3", "Test - Caleb.mp3", "Test - Carlos & Damien.mp3", "Test - Chelos x Madame Prez x Cam.mp3"];
  const plan = planBeats(testTracks, [], { testFolder: true });
  assert.deepEqual(plan.map((p) => [p.slug, p.name, p.standIn]), [1, 2, 3, 4].map((n) => [`placeholder-beat-${n}`, `Placeholder beat ${n}`, true]));
  assert.ok(!/brian|caleb|carlos|damien|chelos|prez|cam\b/i.test(JSON.stringify(plan.map(({ slug, name }) => ({ slug, name })))), "no person's name becomes a beat's name or slug");
  assert.equal(planBeats(["Brian.mp3"], [], { testFolder: true })[0].name, "Placeholder beat 1", "any file in a test folder");
  assert.equal(planBeats(["Test - Brian.mp3"], [], { testFolder: false })[0].standIn, true, "and a test file in any folder");
  // Run again: the same four keep their numbers; a fifth takes the next one.
  const loaded = plan.map((p) => ({ slug: p.slug, name: p.name, source_name: p.sourceName }));
  const again = planBeats([...testTracks, "Test - Zed.mp3"], loaded, { testFolder: true });
  assert.deepEqual(again.map((p) => [p.slug, p.isNew]), [["placeholder-beat-1", false], ["placeholder-beat-2", false], ["placeholder-beat-3", false], ["placeholder-beat-4", false], ["placeholder-beat-5", true]]);
  assert.equal(isTestFolder(path.join(os.homedir(), "topbarz-source", "drive", "Test tracks")), true);
  assert.equal(isTestFolder(path.join(os.homedir(), "topbarz-source", "drive", "Beats")), false);
});

test("load-beats refuses test files for production exactly as the track loader does (even via a symlink)", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "tbz-beats-"));
  const testDir = path.join(base, "Test tracks");
  fs.mkdirSync(testDir);
  fs.writeFileSync(path.join(testDir, "Brian.mp3"), "x");
  const disguised = path.join(base, "Beats");
  fs.symlinkSync(testDir, disguised);
  for (const folder of [testDir, disguised]) {
    const r = loader("--env", "production", "--folder", folder);
    assert.notEqual(r.status, 0, folder);
    assert.match(r.stderr, /REFUSED: "Test tracks" is a test folder\. Test files load into preview only, never production\./, folder);
    assert.ok(!/loaded|updated|unchanged/.test(r.stdout), "nothing was loaded");
  }
  const real = path.join(base, "Real beats");
  fs.mkdirSync(real);
  fs.writeFileSync(path.join(real, "Night Drive.mp3"), "x");
  fs.writeFileSync(path.join(real, "Test - Brian.mp3"), "x");
  const mixed = loader("--env", "production", "--folder", real);
  assert.notEqual(mixed.status, 0);
  assert.match(mixed.stderr, /REFUSED: "Test - Brian\.mp3" is a test file/);
  // Both loaders go through the one rule, and the beat loader checks it before it reads or writes.
  assert.throws(() => assertLoadAllowed("production", testDir, ["Brian.mp3"]), /REFUSED/);
  const source = src("scripts/load-beats.mjs");
  assert.ok(source.indexOf("assertLoadAllowed(args.env, folder, files)") > 0 && source.indexOf("assertLoadAllowed(args.env, folder, files)") < source.indexOf("await d1("), "the refusal comes before the first database call");
  assert.match(source, /if \(args\.env === "production" && planned\.some\(\(p\) => p\.standIn\)\) throw new Error\("REFUSED:/, "and a stand-in is refused for production a second time, by what it is");
  fs.rmSync(base, { recursive: true, force: true });
});

test("load-beats never exits 0 having done nothing: no --env, no folder and an empty folder each stop and say so", () => {
  const none = loader();
  assert.equal(none.status, 2);
  assert.match(none.stderr, /--env local \| preview \| production/);

  const base = fs.mkdtempSync(path.join(os.tmpdir(), "tbz-beats-"));
  const missing = loader("--env", "local", "--folder", path.join(base, "Beats"));
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /STOPPED: there is no beats folder at .*Beats\. Nothing was loaded\./);
  assert.match(src("scripts/load-beats.mjs"), /path\.resolve\(args\.folder \?\? path\.join\(DRIVE_DIR, "Beats"\)\)/, "the default folder is the Drive package's Beats folder");

  fs.mkdirSync(path.join(base, "Beats"));
  fs.writeFileSync(path.join(base, "Beats", "notes.txt"), "not audio");
  const empty = loader("--env", "local", "--folder", path.join(base, "Beats"));
  assert.equal(empty.status, 2);
  assert.match(empty.stderr, /STOPPED: nothing to load\. .* has no audio files\./);
  fs.rmSync(base, { recursive: true, force: true });

  const pkg = JSON.parse(src("package.json"));
  assert.equal(pkg.scripts["load-beats"], "node scripts/load-beats.mjs");
  assert.match(src("scripts/load-beats.mjs"), /if \(!active\) \{ console\.error\("STOPPED: the database has no active beat after loading\."\); process\.exit\(1\); \}/);
});

test("the docs say how to run the select page", () => {
  const runbook = src("RUNBOOK.md");
  const section = /\n## The select page\n([\s\S]*?)(?=\n## )/.exec(runbook)?.[1] ?? "";
  for (const said of ["/select", "npm run load-beats -- --env preview", "npm run load-beats -- --env production", "public/js/select-copy.js", "noindex", "tbz.pick", "/api/beats", "credit_label", "credit_url", "stand-in", "Waitwhile"]) {
    assert.ok(section.includes(said), `RUNBOOK.md, "The select page", does not cover: ${said}`);
  }
  assert.match(src("CLAUDE.md"), /\/select/);
});
