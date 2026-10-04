// The booth: POST /api/booth/tracks (an engineer's upload → a 4-digit code), GET /api/booth/tracks
// (the log), GET /api/booth/tracks/<code> (the rapper's lookup), the download header, the two
// pages' rules, the print sign, the log script, the docs — and the one rule that matters most:
// a booth track is never a track in the vote.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import * as beats from "../functions/api/beats.js";
import * as booth from "../functions/api/booth/[[path]].js";
import * as comments from "../functions/api/comments.js";
import * as likes from "../functions/api/likes.js";
import * as state from "../functions/api/state.js";
import * as voters from "../functions/api/voters.js";
import * as media from "../functions/media/[[path]].js";
import {
  BOOTH_CODE_TRIES, BOOTH_DAY_KEY, BOOTH_EXTENSIONS, BOOTH_LOG_ROWS, BOOTH_MAX_BYTES, BOOTH_NAME_MAX, LOG_SQL, OPEN_SQL,
  audioExtension, audioType, cleanFileName, downloadName, isCode, mediaKey, randomCode, reserveCode, uploadSize,
} from "../functions/_lib/booth.js";
import { LIMITS } from "../functions/_lib/config.js";
import { computeTally } from "../functions/_lib/tally.js";
import { COPY as BOOTH_COPY } from "../public/js/booth-copy.js";
import {
  CODE_LENGTH, MAX_UPLOAD_BYTES, UPLOAD_EXTENSIONS, cleanTrack, codeDigits, codeFromSearch, formatSize, openedWords, refuseFile, safeBoothUrl, todayRows, uploadFailure,
} from "../public/js/booth-rules.js";
import { COPY as TRACK_COPY } from "../public/js/track-copy.js";
import { BOOTH_LOG_SQL, boothLogCsv } from "../scripts/booth-log.mjs";
import { tallyCsv } from "../scripts/export.mjs";
import { TRACK_URL } from "../scripts/make-track-qr.mjs";
import { ROOT, acceptedBeforeLimit, addTrack, call, freshIp, makeEnv, signUp } from "./helpers.mjs";

const src = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const FIXTURE = path.join(ROOT, "tests", "fixtures", "Test - Carlos & Damien.mp3");
const wav = (n = 2048) => new Uint8Array(Array.from({ length: n }, (_, i) => (i < 4 ? "RIFF".charCodeAt(i) : i % 251)));

// A raw-body upload, as the page sends it (not JSON, so not helpers.call).
async function upload(env, { name = "Test - Brian.wav", type = "audio/wav", bytes = wav(), length = bytes?.byteLength, ip = freshIp(), method = "POST", headers = {} } = {}) {
  const h = new Headers({ "cf-connecting-ip": ip, ...headers });
  if (name !== null) h.set("x-file-name", name);
  if (type !== null) h.set("content-type", type);
  if (length !== null && length !== undefined) h.set("content-length", String(length));
  const request = new Request("https://voting.test/api/booth/tracks", { method, headers: h, body: bytes ?? undefined });
  const pending = [];
  const res = await booth.onRequest({ request, env, params: { path: ["tracks"] }, waitUntil: (x) => pending.push(x) });
  await Promise.all(pending);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch {}
  return { status: res.status, body, text, headers: res.headers };
}
const lookup = (env, code, ip = freshIp()) => call(booth.onRequest, env, { path: `/api/booth/tracks/${code}`, ip, params: { path: ["tracks", code] } });
const log = (env, ip = freshIp()) => call(booth.onRequest, env, { path: "/api/booth/tracks", ip, params: { path: ["tracks"] } });
const getMedia = (env, url, headers = {}) => { const [p, q] = url.split("?"); return call(media.onRequest, env, { path: p + (q ? `?${q}` : ""), headers, params: { path: p.replace("/media/", "").split("/") } }); };

let env, dispose;
before(async () => {
  ({ env, dispose } = await makeEnv());
  await addTrack(env, "brian", { sort: 10 });
});
after(() => dispose());

// ── Codes ────────────────────────────────────────────────────────────────────────────────────
test("a code is four digits from the platform's random source, with no bias, and the key under it is unguessable", () => {
  for (let i = 0; i < 500; i++) assert.match(randomCode(), /^\d{4}$/);
  // Rejection sampling: 60000–65535 is thrown away, so every code is equally likely.
  const draws = [60000, 65535, 9999, 0, 12345];
  assert.equal(randomCode((n) => Uint16Array.from([draws.shift()])), "9999", "a draw of 60000 or more is drawn again");
  assert.equal(randomCode(() => Uint16Array.from([0])), "0000");
  assert.equal(randomCode(() => Uint16Array.from([12345])), "2345");
  assert.equal(randomCode(() => Uint16Array.from([59999])), "9999");
  for (const good of ["0000", "2468", "9999"]) assert.equal(isCode(good), true, good);
  for (const bad of ["246", "24685", "24a8", " 2468", "2468\n", 2468, null, undefined, ""]) assert.equal(isCode(bad), false, String(bad));
  assert.match(mediaKey("2468", "mp3"), /^booth\/2468-[0-9a-f]{16}\.mp3$/);
  assert.equal(mediaKey("0001", "wav", (n) => new Uint8Array(n).fill(0xab)), "booth/0001-abababababababab.wav");
  assert.ok(new Set(Array.from({ length: 50 }, () => mediaKey("2468", "mp3"))).size === 50, "fifty keys for one code are fifty different keys");
  assert.equal(CODE_LENGTH, 4);
});

test("reserving a code: UNIQUE in the table decides; a collision is retried with a fresh code, bounded; never two rows on one code", async () => {
  const fresh = await makeEnv();
  try {
    const db = fresh.env.DB;
    const row = { fileName: "a.wav", contentType: "audio/wav", size: 10, ext: "wav", uploadedAt: 1700000000000 };
    const seq = (...codes) => { const q = [...codes]; return () => Uint16Array.from([q.length > 1 ? q.shift() : q[0]]); }; // the last draw repeats
    const first = await reserveCode(db, row, { random: seq(1234) });
    assert.equal(first.code, "1234");
    const second = await reserveCode(db, row, { random: seq(1234, 1234, 5678) });
    assert.equal(second.code, "5678", "two collisions, then a free code");
    const stuck = await reserveCode(db, row, { random: seq(1234), tries: 3 });
    assert.equal(stuck, null, "every try collided: null, not a throw and not a duplicate");
    const all = (await db.prepare("SELECT code, media_key FROM booth_tracks ORDER BY id").all()).results;
    assert.deepEqual(all.map((r) => r.code), ["1234", "5678"]);
    assert.ok(all.every((r) => r.media_key.startsWith(`booth/${r.code}-`)));
    assert.equal(BOOTH_CODE_TRIES, 25);
    // The constraint itself, not the code around it, is what refuses a second row.
    await assert.rejects(db.prepare("INSERT INTO booth_tracks (code, file_name, media_key, uploaded_at) VALUES ('1234', 'b.wav', 'booth/1234-x.wav', 1)").run(), /UNIQUE/);
    const codes = new Set();
    for (let i = 0; i < 40; i++) codes.add((await reserveCode(db, row)).code);
    assert.equal(codes.size, 40, "forty random reservations are forty different codes");
  } finally { await fresh.dispose(); }
});

// ── Names, types, sizes ──────────────────────────────────────────────────────────────────────
test("a file name is its base name, printable, at most 120 characters; the download name cannot escape the header", () => {
  assert.equal(cleanFileName("Test - Carlos & Damien.mp3"), "Test - Carlos & Damien.mp3");
  assert.equal(cleanFileName("Test - Chelos x Madame Prez x Cam.mp3"), "Test - Chelos x Madame Prez x Cam.mp3");
  assert.equal(cleanFileName("/Users/eng/Desktop/Take 3.wav"), "Take 3.wav", "a path is cut to its base name");
  assert.equal(cleanFileName("C:\\Sessions\\Take 3.wav"), "Take 3.wav");
  assert.equal(cleanFileName("  Take\t3\u0000.wav \n"), "Take 3.wav", "control characters go, runs of space become one");
  assert.equal(cleanFileName("..%2F..%2Fetc%2Fpasswd"), "passwd", "an encoded path is decoded, then cut to its base name");
  assert.equal(cleanFileName("Caf%C3%A9.wav"), "Café.wav", "the page sends the name URL-encoded");
  assert.equal(cleanFileName(".hidden.wav"), "hidden.wav");
  assert.equal(cleanFileName(`${"a".repeat(200)}.wav`).length, BOOTH_NAME_MAX);
  assert.equal(BOOTH_NAME_MAX, 120);
  for (const empty of ["", "   ", "/", "\\", null, undefined, 7]) assert.equal(cleanFileName(empty), "", String(empty));
  assert.equal(downloadName('Take "3" final.wav'), "Take 3 final.wav", "no quote or backslash in the header");
  assert.equal(downloadName('C:\\takes\\Take "3".wav'), "Take 3.wav", "a backslash is a path separator, cut off with the folder");
  assert.equal(downloadName("Café ñ.wav"), "Caf .wav", "ASCII only");
  assert.equal(downloadName("東京.wav"), ".wav");
  assert.equal(downloadName("東京"), "track");
  assert.equal(downloadName(undefined), "track");
});

test("audio only: the extension and the declared type both have to say so; the size is declared, 1 byte to 100 MB", () => {
  assert.deepEqual(BOOTH_EXTENSIONS, ["wav", "mp3", "m4a", "aif", "aiff", "flac"]);
  assert.deepEqual(UPLOAD_EXTENSIONS, BOOTH_EXTENSIONS, "the page refuses the same files before a byte goes up");
  for (const ext of BOOTH_EXTENSIONS) assert.equal(audioExtension(`Take.${ext.toUpperCase()}`), ext);
  for (const bad of ["Take.exe", "Take.html", "Take.wav.js", "Take", "Take.", ".wav.", "Take.ogg", "Take.aac"]) assert.equal(audioExtension(bad), null, bad);
  assert.equal(audioType("audio/wav"), "audio/wav");
  assert.equal(audioType("Audio/MPEG; charset=binary"), "audio/mpeg");
  assert.equal(audioType("application/octet-stream"), "application/octet-stream");
  for (const bad of ["text/html", "application/json", "video/mp4", "image/png", "", null, undefined, "audio"]) assert.equal(audioType(bad), null, String(bad));
  assert.equal(uploadSize("1"), 1);
  assert.equal(uploadSize(String(BOOTH_MAX_BYTES)), BOOTH_MAX_BYTES);
  for (const bad of ["0", String(BOOTH_MAX_BYTES + 1), "-1", "1.5", "abc", "", null, undefined, "1e3"]) assert.equal(uploadSize(bad), null, String(bad));
  assert.equal(BOOTH_MAX_BYTES, 100 * 1024 * 1024);
  assert.equal(MAX_UPLOAD_BYTES, BOOTH_MAX_BYTES);
  assert.equal(refuseFile({ name: "Take 3.wav", size: 1000 }), null);
  assert.equal(refuseFile({ name: "Take 3.WAV", size: 1000 }), null);
  assert.equal(refuseFile({ name: "Take 3.txt", size: 1000 }), "not_audio");
  assert.equal(refuseFile({ name: "Take 3.wav", size: 0 }), "empty");
  assert.equal(refuseFile({ name: "Take 3.wav", size: MAX_UPLOAD_BYTES + 1 }), "too_big");
  assert.equal(refuseFile(null), "not_audio");
});

// ── The upload route ─────────────────────────────────────────────────────────────────────────
test("POST /api/booth/tracks: the raw file goes to R2 under booth/<code>-<random>.<ext> with the name kept; the answer is the code", async () => {
  const bytes = wav(3000);
  const res = await upload(env, { name: "Test - Carlos & Damien.wav", type: "audio/x-wav", bytes });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(Object.keys(res.body), ["code", "file_name", "uploaded_at"]);
  assert.match(res.body.code, /^\d{4}$/);
  assert.equal(res.body.file_name, "Test - Carlos & Damien.wav");
  assert.ok(Date.now() - Date.parse(res.body.uploaded_at) < 10_000);
  const row = await env.DB.prepare("SELECT * FROM booth_tracks WHERE code = ?1").bind(res.body.code).first();
  assert.equal(row.file_name, "Test - Carlos & Damien.wav");
  assert.equal(row.content_type, "audio/x-wav");
  assert.equal(row.size, 3000);
  assert.match(row.media_key, new RegExp(`^booth/${res.body.code}-[0-9a-f]{16}\\.wav$`));
  assert.equal(row.opened, 0);
  assert.equal(row.last_opened_at, null);
  const obj = await env.MEDIA.get(row.media_key);
  assert.equal(obj.size, 3000);
  assert.equal(obj.httpMetadata.contentType, "audio/x-wav");
  assert.equal(obj.customMetadata.fileName, "Test - Carlos & Damien.wav");
  assert.deepEqual([...new Uint8Array(await obj.arrayBuffer())].slice(0, 8), [...bytes.slice(0, 8)]);
  // The page sends the name URL-encoded (a header cannot carry every character); it comes back as typed.
  const enc = await upload(env, { name: encodeURIComponent("Café take 2.mp3"), type: "audio/mpeg" , bytes: wav(100) });
  assert.equal(enc.body.file_name, "Café take 2.mp3");
  assert.equal((await upload(env, { method: "PUT" })).status, 405);
  assert.equal((await call(booth.onRequest, env, { method: "POST", path: "/api/booth/tracks/1234", params: { path: ["tracks", "1234"] }, body: {} })).status, 404, "a code cannot be posted to");
  assert.equal((await call(booth.onRequest, env, { path: "/api/booth/other", params: { path: ["other"] } })).status, 404);
});

test("POST /api/booth/tracks refuses what is not an audio file, has no name, no size, is empty or is over 100 MB, and writes nothing for any of them", async () => {
  const before = (await env.DB.prepare("SELECT COUNT(*) AS n FROM booth_tracks").first()).n;
  const cases = [
    [{ name: "notes.txt", type: "text/plain" }, 415, "not_audio"],
    [{ name: "page.html", type: "audio/wav" }, 415, "not_audio", "the extension alone is not enough"],
    [{ name: "Take.wav", type: "text/html" }, 415, "not_audio", "the type alone is not enough"],
    [{ name: "Take.wav", type: "video/mp4" }, 415, "not_audio"],
    [{ name: "Take.wav", type: null }, 415, "not_audio", "no type at all"],
    [{ name: null }, 400, "file_name_required"],
    [{ name: "   " }, 400, "file_name_required"],
    [{ name: "/" }, 400, "file_name_required"],
    [{ length: null }, 413, "bad_size", "content-length is required"],
    [{ bytes: new Uint8Array(0), length: 0 }, 413, "bad_size", "an empty file"],
    [{ length: BOOTH_MAX_BYTES + 1 }, 413, "bad_size", "over 100 MB (declared)"],
    [{ bytes: wav(500), length: 400 }, 400, "bad_size", "the bytes do not match the declared size"],
  ];
  for (const [opts, status, error, why = error] of cases) {
    const res = await upload(env, opts);
    assert.deepEqual([res.status, res.body?.error], [status, error], `${why}: ${res.text}`);
    assert.ok(typeof res.body.message === "string" && res.body.message.length > 10, "with words to show");
  }
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM booth_tracks").first()).n, before, "no row for a refused upload");
  const keys = (await env.MEDIA.list({ prefix: "booth/" })).objects.map((o) => o.key);
  assert.equal(keys.length, before, "and no object in R2");
});

test("POST /api/booth/tracks: a failed upload leaves no row behind, so its code is free again", async () => {
  const broken = { ...env, MEDIA: { put: async () => { throw new Error("R2 is down"); } } };
  const res = await upload(broken, { name: "Take.wav" });
  assert.equal(res.status, 500);
  assert.equal(res.body.error, "server_error");
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM booth_tracks WHERE file_name = 'Take.wav'").first()).n, 0);
});

test("uploads are limited to 60 an hour per connection: the 61st is a 429, with a message", async () => {
  const fresh = await makeEnv();
  try {
    const ip = freshIp();
    assert.equal(LIMITS.boothUploadsPerIp.max, 60);
    assert.equal(LIMITS.boothUploadsPerIp.window, 3600);
    const accepted = await acceptedBeforeLimit((i) => upload(fresh.env, { ip, name: `Take ${i}.wav`, bytes: wav(64) }), LIMITS.boothUploadsPerIp.max);
    assert.equal(accepted, 60);
    const other = await upload(fresh.env, { ip: freshIp(), bytes: wav(64) });
    assert.equal(other.status, 200, "another connection is not affected");
    assert.equal((await fresh.env.DB.prepare("SELECT COUNT(*) AS n FROM booth_tracks").first()).n, 61);
  } finally { await fresh.dispose(); }
});

test("uploads are limited to 300 a day for the whole site (one counter, booth-uploads-day): the 301st is a 429 daily_limit, whoever sends it", async () => {
  const fresh = await makeEnv();
  try {
    assert.equal(BOOTH_DAY_KEY, "booth-uploads-day");
    assert.deepEqual(LIMITS.boothUploadsPerDay, { window: 86400, max: 300 });
    // 299 uploads already counted in today's window, from anywhere.
    const windowStart = Math.floor(Date.now() / 1000 / 86400) * 86400;
    await fresh.env.DB.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 299)").bind(BOOTH_DAY_KEY, windowStart).run();
    const three00 = await upload(fresh.env, { ip: freshIp(), bytes: wav(64) });
    assert.equal(three00.status, 200, `the 300th goes through: ${three00.text}`);
    const three01 = await upload(fresh.env, { ip: freshIp(), bytes: wav(64) });
    assert.equal(three01.status, 429, "the 301st does not");
    assert.equal(three01.body.error, "daily_limit");
    assert.equal(three01.body.retry_after_seconds, 86400);
    assert.ok(/limit/i.test(three01.body.message));
    assert.equal((await upload(fresh.env, { ip: freshIp(), bytes: wav(64) })).status, 429, "and it stays shut");
    assert.equal((await fresh.env.DB.prepare("SELECT COUNT(*) AS n FROM booth_tracks").first()).n, 1, "one row: the 300th");
    assert.equal((await fresh.env.DB.prepare("SELECT count FROM rate_limits WHERE key = ?1 AND window_start = ?2").bind(BOOTH_DAY_KEY, windowStart).first()).count, 302, "the one site-wide counter counted all three");
    // A refused file is not an upload: it never touches the counters.
    const bad = await upload(fresh.env, { ip: freshIp(), name: "notes.txt", type: "text/plain" });
    assert.equal(bad.status, 415);
    assert.equal((await fresh.env.DB.prepare("SELECT count FROM rate_limits WHERE key = ?1 AND window_start = ?2").bind(BOOTH_DAY_KEY, windowStart).first()).count, 302);
    assert.equal(uploadFailure(BOOTH_COPY, { code: "daily_limit", status: 429 }), "Upload limit reached for today, tell Sequoia", "and the page says so in those words");
  } finally { await fresh.dispose(); }
});

// ── The lookup ───────────────────────────────────────────────────────────────────────────────
test("GET /api/booth/tracks/<code>: the right code gives the track and counts the open; a wrong one is a 404; never a list, never a search", async () => {
  const up = await upload(env, { name: "Test - Chelos x Madame Prez x Cam.mp3", type: "audio/mpeg", bytes: wav(1200) });
  assert.equal(up.status, 200);
  const { code } = up.body;
  const found = await lookup(env, code);
  assert.equal(found.status, 200, found.text);
  assert.deepEqual(Object.keys(found.body), ["code", "file_name", "audio_url", "download_url", "size", "uploaded_at"]);
  assert.equal(found.body.code, code);
  assert.equal(found.body.file_name, "Test - Chelos x Madame Prez x Cam.mp3");
  assert.match(found.body.audio_url, new RegExp(`^/media/booth/${code}-[0-9a-f]{16}\\.mp3$`));
  assert.equal(found.body.download_url, `${found.body.audio_url}?dl=1`);
  assert.equal(found.body.size, 1200);
  assert.equal(found.body.uploaded_at, up.body.uploaded_at);
  assert.equal(found.headers.get("cache-control"), "no-store");
  assert.ok(!found.text.includes("media_key") && !found.text.includes("opened"), "the key and the count are not in the answer");
  await lookup(env, code);
  const row = await env.DB.prepare("SELECT opened, last_opened_at FROM booth_tracks WHERE code = ?1").bind(code).first();
  assert.equal(row.opened, 2, "each lookup is one open");
  assert.ok(Date.now() - row.last_opened_at < 10_000);

  const wrongCode = code === "0000" ? "0001" : "0000";
  const missing = await lookup(env, wrongCode);
  assert.deepEqual([missing.status, missing.body.error], [404, "not_found"]);
  assert.equal(missing.body.message, "No track with that code yet. Ask your engineer.");
  for (const bad of ["12", "12345", "abcd", "%20", "..", `${code}%0A`]) assert.equal((await lookup(env, bad)).status, 404, bad);
  assert.equal((await call(booth.onRequest, env, { path: "/api/booth/tracks/", params: { path: ["tracks", ""] } })).status, 200, "a trailing slash is the log, not a lookup");
  assert.equal((await call(booth.onRequest, env, { path: `/api/booth/tracks/${code}/x`, params: { path: ["tracks", code, "x"] } })).status, 404);
  const source = src("functions/api/booth/[[path]].js") + src("functions/_lib/booth.js");
  assert.ok(!/\bLIKE\b|"search"|"list"|\?q=/.test(source), "no search and no listing of codes anywhere in the booth code");
  assert.ok(!/SELECT[^;]*FROM booth_tracks(?![^;]*(?:WHERE code = \?1|LIMIT \$\{BOOTH_LOG_ROWS\}))/.test(source), "every read of the table is one code, or the capped log");
  assert.match(OPEN_SQL, /^UPDATE booth_tracks SET opened = opened \+ 1, last_opened_at = \?2 WHERE code = \?1 RETURNING/, "one statement: the open is counted in the same step that finds the row");
});

test("lookups are limited to 5 a minute and 30 an hour per connection, so a code cannot be found by trying them all", async () => {
  assert.deepEqual([LIMITS.boothLookupPerMinute, LIMITS.boothLookupPerHour], [{ window: 60, max: 5 }, { window: 3600, max: 30 }]);
  const fresh = await makeEnv();
  try {
    const ip = freshIp();
    const accepted = await acceptedBeforeLimit(() => lookup(fresh.env, "1234", ip), 5);
    assert.equal(accepted, 5, "the 6th try in a minute is a 429");
    const sixth = await lookup(fresh.env, "1234", ip);
    assert.equal(sixth.status, 429);
    assert.ok(/Give it a minute/.test(sixth.body.message));
    assert.equal((await lookup(fresh.env, "1234", freshIp())).status, 404, "another connection still gets its answer");
    // The hourly cap, counted in its own window: 30 tries from one connection across minutes.
    const slow = freshIp();
    const hourStart = Math.floor(Date.now() / 1000 / 3600) * 3600;
    const { ipHash } = await import("../functions/_lib/http.js");
    const hashed = await ipHash(new Request("https://voting.test/", { headers: { "cf-connecting-ip": slow } }), fresh.env);
    await fresh.env.DB.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 29)").bind(`booth:look:ip:${hashed}:h`, hourStart).run();
    assert.equal((await lookup(fresh.env, "1234", slow)).status, 404, "the 30th in the hour");
    assert.equal((await lookup(fresh.env, "1234", slow)).status, 429, "the 31st is not");
  } finally { await fresh.dispose(); }
});

// ── The log ──────────────────────────────────────────────────────────────────────────────────
test("GET /api/booth/tracks is the log: newest first, at most 200 rows, 60 reads a minute per connection", async () => {
  const fresh = await makeEnv();
  try {
    const t0 = Date.now() - 300_000;
    const stmts = [];
    for (let i = 0; i < 205; i++) stmts.push(fresh.env.DB.prepare("INSERT INTO booth_tracks (code, file_name, content_type, size, media_key, uploaded_at, opened) VALUES (?1, ?2, 'audio/wav', ?3, ?4, ?5, ?6)").bind(String(i).padStart(4, "0"), `Take ${i}.wav`, 100 + i, `booth/${String(i).padStart(4, "0")}-aaaaaaaaaaaaaaaa.wav`, t0 + i * 1000, i % 3));
    await fresh.env.DB.batch(stmts);
    const res = await log(fresh.env);
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body), ["tracks"]);
    assert.equal(res.body.tracks.length, BOOTH_LOG_ROWS);
    assert.equal(BOOTH_LOG_ROWS, 200);
    assert.deepEqual(res.body.tracks[0], { code: "0204", file_name: "Take 204.wav", uploaded_at: new Date(t0 + 204_000).toISOString(), opened: 0, size: 304 });
    assert.equal(res.body.tracks[199].code, "0005", "the oldest five fell off");
    assert.ok(!res.text.includes("media_key") && !res.text.includes("booth/"), "the log never carries a key");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.match(LOG_SQL, /ORDER BY uploaded_at DESC, id DESC LIMIT 200$/);
    assert.equal((await call(booth.onRequest, env, { method: "POST", path: "/api/booth/tracks", params: { path: ["tracks"] }, body: { code: "0001" }, headers: { "x-file-name": "a.wav" } })).status, 415, "JSON is not a file");
    const ip = freshIp();
    assert.equal(await acceptedBeforeLimit(() => log(fresh.env, ip), LIMITS.boothLogPerIp.max), 60);
    assert.deepEqual(LIMITS.boothLogPerIp, { window: 60, max: 60 });
  } finally { await fresh.dispose(); }
});

// ── The media ────────────────────────────────────────────────────────────────────────────────
test("a booth file is served the way a track is (long cache, Range → 206); with ?dl=1 it is a download under the engineer's name", async () => {
  const bytes = wav(4096);
  const up = await upload(env, { name: 'Test "Carlos" & Damien.wav', type: "audio/wav", bytes });
  const found = await lookup(env, up.body.code);
  const whole = await getMedia(env, found.body.audio_url);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get("content-type"), "audio/wav");
  assert.equal(whole.headers.get("accept-ranges"), "bytes");
  assert.match(whole.headers.get("cache-control"), /immutable/);
  assert.equal(whole.headers.get("content-length"), "4096");
  assert.equal(whole.headers.get("content-disposition"), null, "played inline");
  assert.equal(whole.bytes.length, 4096);
  const part = await getMedia(env, found.body.audio_url, { range: "bytes=10-19" });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), "bytes 10-19/4096");
  assert.deepEqual([...part.bytes], [...bytes.slice(10, 20)]);
  const dl = await getMedia(env, found.body.download_url);
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get("content-disposition"), 'attachment; filename="Test Carlos & Damien.wav"', "the quotes cannot escape the header");
  assert.equal(dl.headers.get("content-length"), "4096");
  assert.equal(dl.bytes.length, 4096);
  const dlRange = await getMedia(env, found.body.download_url, { range: "bytes=0-1" });
  assert.equal(dlRange.status, 206, "a download also answers Range");
  assert.equal(dlRange.headers.get("content-disposition"), 'attachment; filename="Test Carlos & Damien.wav"');
  assert.equal((await getMedia(env, `${found.body.audio_url}?dl=0`)).headers.get("content-disposition"), null);
  assert.equal((await getMedia(env, "/media/tracks/brian-abc123.mp3?dl=1")).headers.get("content-disposition"), null, "only a booth file is ever a download");
  assert.equal((await getMedia(env, `/media/booth/${up.body.code}.wav`)).status, 404, "the code alone reaches nothing: the key is needed");
  assert.equal((await getMedia(env, "/media/booth/../tracks/brian-abc123.mp3")).status, 404);
});

// ── Isolation ────────────────────────────────────────────────────────────────────────────────
test("a booth track is never in the vote: not in /api/state, /api/beats, the tally or the export; not likeable; booth_tracks is read by the booth alone", async () => {
  const up = await upload(env, { name: "Isolation SECRET-BOOTH-NAME.wav", bytes: wav(100) });
  const { code } = up.body;
  state._resetStateMemo();
  const s = await call(state.onRequest, env, { path: "/api/state" });
  assert.deepEqual(Object.keys(s.body).sort(), ["closed", "gate", "giphy", "now", "photos", "tracks", "verification", "voting_ends_at"], "the shape of /api/state has not changed");
  assert.deepEqual(s.body.tracks.map((t) => t.slug), ["brian"]);
  assert.ok(!/booth|SECRET-BOOTH/.test(JSON.stringify(s.body.tracks)) && !JSON.stringify(s.body.tracks).includes(code), "no booth track, by code, name or key, is anywhere in the tracks");
  assert.ok(!/booth/i.test(s.text));
  beats._resetBeatsMemo();
  const b = await call(beats.onRequest, env, { path: "/api/beats" });
  assert.deepEqual(b.body, { beats: [] });
  const { token } = await signUp(env, voters, { email: "rapper@example.com" });
  const like = await call(likes.onRequest, env, { method: "POST", path: "/api/likes", token, body: { track: code, liked: true } });
  assert.deepEqual([like.status, like.body.error], [404, "unknown_track"], "a booth track cannot be liked");
  assert.equal((await call(comments.onRequest, env, { method: "POST", path: "/api/comments", token, body: { track: code, text: "hi" } })).status, 404, "or commented on");
  assert.equal((await call(comments.onRequest, env, { path: `/api/comments?track=${code}` })).status, 404);

  // The export, run with its own queries against this database: one track, no booth track.
  const queries = [...src("scripts/export.mjs").matchAll(/await d1\(target, "([^"]+)"\)/g)].map((m) => m[1]);
  assert.equal(queries.length, 4);
  const [trackRows, events, commentRows] = await Promise.all(queries.map(async (q) => (await env.DB.prepare(q).all()).results));
  const tally = computeTally(trackRows, events, Object.fromEntries(commentRows.map((r) => [r.track_id, r.n])));
  assert.deepEqual(tally.map((r) => r.slug), ["brian"]);
  assert.ok(!/booth|SECRET-BOOTH/i.test(tallyCsv(tally)));
  assert.ok(!/booth/i.test(queries.join(" ")), "the export never reads the booth table");

  // In the code: nothing that serves the vote or the beats reads booth_tracks or the booth routes,
  // and the booth reads nothing of the vote.
  const vote = ["functions/_lib/state.js", "functions/_lib/tally.js", "functions/_lib/verify.js", "functions/_lib/beats.js", "functions/api/state.js", "functions/api/beats.js", "functions/api/likes.js", "functions/api/comments.js", "functions/api/me.js", "functions/api/voters.js", "scripts/export.mjs", "scripts/load-tracks.mjs", "scripts/load-photos.mjs", "scripts/load-beats.mjs", "public/index.html", "public/select.html", "public/js/app.js", "public/js/select.js", "public/js/pick.js", "public/js/comments.js", "public/js/gate.js", "public/js/gallery.js", "public/js/api.js", "public/js/logic.js", "public/js/player.js", "public/js/dom.js"];
  for (const file of vote) assert.ok(!/booth_tracks|\/api\/booth|booth\//i.test(src(file)), `${file} never touches the booth`);
  const everywhere = [];
  const walk = (dir) => { for (const f of fs.readdirSync(dir, { withFileTypes: true })) { if ([".git", "node_modules", ".wrangler", ".work", "exports", "fixtures"].includes(f.name)) continue; const p = path.join(dir, f.name); if (f.isDirectory()) walk(p); else if (/\.(js|mjs|sql|md|json|html|toml|yml)$/.test(f.name) && /booth_tracks/.test(fs.readFileSync(p, "utf8"))) everywhere.push(path.relative(ROOT, p)); } };
  walk(ROOT);
  assert.deepEqual(everywhere.sort(), ["CLAUDE.md", "RUNBOOK.md", "functions/_lib/booth.js", "functions/api/booth/[[path]].js", "migrations/0004_booth_tracks.sql", "scripts/booth-log.mjs", "tests/booth.test.mjs"], "booth_tracks is named only by the booth's own code, its migration, its log script, this test and the two docs");
  const boothSql = [src("functions/_lib/booth.js"), src("scripts/booth-log.mjs"), src("functions/api/booth/[[path]].js")].join(" ");
  const tables = [...boothSql.matchAll(/(?:FROM|INTO|UPDATE) ([a-z_]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(tables)], ["booth_tracks"], "the booth reads and writes booth_tracks only (the counters go through ratelimit.js)");
  assert.ok(!/config\.js.*VOTING|votingWindow|votingEndsAtMs|END_SETTING/.test(src("functions/api/booth/[[path]].js")), "the booth does not read the voting window");
  const migration = src("migrations/0004_booth_tracks.sql").replace(/--.*$/gm, "");
  assert.match(migration, /CREATE TABLE booth_tracks \(/);
  assert.ok(!/\b(tracks|like_events|voters|comments|beats|settings)\b/.test(migration) && !/ALTER TABLE|DROP /.test(migration), "the migration adds the booth table and touches nothing else");
  for (const col of ["code", "file_name", "content_type", "size", "media_key", "uploaded_at", "opened", "last_opened_at"]) assert.match(migration, new RegExp(`\\n\\s+${col}\\s`), col);
  assert.match(migration, /code\s+TEXT NOT NULL UNIQUE/);
  assert.match(migration, /media_key\s+TEXT NOT NULL UNIQUE/);
  assert.match(migration, /opened\s+INTEGER NOT NULL DEFAULT 0/);
});

// ── The pages' rules (public/js/booth-rules.js) ──────────────────────────────────────────────
test("the code box: digits only, four at most; ?code= in the address is a code or nothing", () => {
  assert.equal(codeDigits("2468"), "2468");
  assert.equal(codeDigits(" 24-68 "), "2468", "a pasted code with a dash");
  assert.equal(codeDigits("246890"), "2468", "never more than four");
  assert.equal(codeDigits("abc"), "");
  assert.equal(codeDigits(null), "");
  assert.equal(codeFromSearch("?code=2468"), "2468");
  assert.equal(codeFromSearch("?x=1&code=0007"), "0007");
  assert.equal(codeFromSearch("?code=2468%0A"), "2468", "a stray newline at the end of a pasted address is ignored");
  for (const bad of ["?code=246", "?code=24680", "?code=abcd", "?code=", "", "?other=2468", null, "?code=24%2068"]) assert.equal(codeFromSearch(bad), null, String(bad));
});

test("the lookup's answer is shown only when it is well-formed; the two media addresses are only ever /media/booth/…", () => {
  const good = { code: "2468", file_name: " Take 3.wav ", audio_url: "/media/booth/2468-0123456789abcdef.wav", download_url: "/media/booth/2468-0123456789abcdef.wav?dl=1", size: 1234, uploaded_at: "2026-10-03T00:00:00.000Z" };
  assert.deepEqual(cleanTrack(good), { code: "2468", file_name: "Take 3.wav", audio_url: good.audio_url, download_url: good.download_url, size: 1234 });
  assert.equal(cleanTrack({ ...good, size: "x" }).size, 0);
  for (const bad of [null, "x", {}, { ...good, code: "24" }, { ...good, file_name: "" }, { ...good, audio_url: "/media/tracks/brian.mp3" }, { ...good, audio_url: "https://evil.example/x.wav" }, { ...good, download_url: good.audio_url }, { ...good, download_url: `${good.audio_url}?dl=1&x=1` }, { ...good, audio_url: "/media/booth/../tracks/b.mp3" }]) {
    assert.equal(cleanTrack(bad), null, JSON.stringify(bad));
  }
  assert.equal(safeBoothUrl("/media/booth/2468-abc.mp3", false), "/media/booth/2468-abc.mp3");
  assert.equal(safeBoothUrl("/media/booth/2468-abc.mp3?dl=1", true), "/media/booth/2468-abc.mp3?dl=1");
  assert.equal(safeBoothUrl("/media/booth/2468-abc.mp3?dl=1", false), null);
  assert.equal(safeBoothUrl("/media/booth/2468-abc.mp3", true), null);
  assert.equal(safeBoothUrl("/media/beats/x.mp3", false), null);
});

test("today's log: today's rows only, newest first, well-formed only; sizes, times and opens in words", () => {
  const now = Date.parse("2026-10-10T20:00:00Z");
  const at = (h) => new Date(now - h * 3600_000).toISOString();
  const rows = todayRows([
    { code: "1111", file_name: "A.wav", uploaded_at: at(1), opened: 2, size: 2735168 },
    { code: "2222", file_name: "B.wav", uploaded_at: at(0.5), opened: 0, size: 900 },
    { code: "3333", file_name: "C.wav", uploaded_at: at(30), opened: 1, size: 10 },
    { code: "44", file_name: "D.wav", uploaded_at: at(0.1) }, { code: "5555", uploaded_at: at(0.1) }, { code: "6666", file_name: "F.wav", uploaded_at: "yesterday" }, null,
  ], now);
  assert.deepEqual(rows.map((r) => r.code), ["2222", "1111"], "yesterday's row and the malformed ones are left out");
  assert.deepEqual(rows[1], { code: "1111", file_name: "A.wav", uploaded_at: now - 3600_000, opened: 2, size: 2735168 });
  assert.deepEqual(todayRows(null), []);
  assert.deepEqual(todayRows({ tracks: [] }), []);
  assert.equal(formatSize(2735168), "2.6 MB");
  assert.equal(formatSize(45 * 1024 * 1024), "45 MB");
  assert.equal(formatSize(900), "1 KB");
  assert.equal(formatSize(0), "");
  assert.equal(openedWords(0), "not opened yet");
  assert.equal(openedWords(1), "opened once");
  assert.equal(openedWords(3), "opened 3 times");
  assert.equal(uploadFailure(BOOTH_COPY, { code: "rate_limited", status: 429 }), BOOTH_COPY.rateLimited);
  assert.equal(uploadFailure(BOOTH_COPY, { code: "not_audio", status: 415 }), BOOTH_COPY.notAudio);
  assert.equal(uploadFailure(BOOTH_COPY, { code: "bad_size", status: 413 }), BOOTH_COPY.tooBig);
  assert.equal(uploadFailure(BOOTH_COPY, { code: "server_error", status: 500, message: "Something went wrong on our side. Try again." }), "Something went wrong on our side. Try again.");
  assert.equal(uploadFailure(BOOTH_COPY, {}), BOOTH_COPY.failed, "no connection: a plain line");
});

// ── The pages ────────────────────────────────────────────────────────────────────────────────
test("the copy of each page is one object with exactly these keys, and the page's elements are empty until it is read", () => {
  assert.deepEqual(Object.keys(BOOTH_COPY), ["headline", "intro", "zone", "zoneHint", "uploading", "doneTitle", "next", "retry", "failed", "notAudio", "tooBig", "empty", "dailyLimit", "rateLimited", "logTitle", "logEmpty", "logFailed"]);
  assert.deepEqual(Object.keys(TRACK_COPY), ["headline", "intro", "codeLabel", "go", "looking", "found", "download", "another", "notFound", "tooMany", "needCode", "audioNone", "audioFailed"]);
  for (const copy of [BOOTH_COPY, TRACK_COPY]) for (const [k, v] of Object.entries(copy)) assert.ok(typeof v === "string" && v.trim(), `${k} is a sentence`);
  assert.equal(TRACK_COPY.headline, "Hear your track");
  assert.equal(TRACK_COPY.notFound, "No track with that code yet. Ask your engineer.");
  assert.equal(TRACK_COPY.tooMany, "Too many tries. Give it a minute.");
  assert.equal(BOOTH_COPY.dailyLimit, "Upload limit reached for today, tell Sequoia");
  assert.match(BOOTH_COPY.uploading, /\{name\}/);
  for (const [page, ids] of [["booth.html", ["tbz-booth-headline", "tbz-booth-intro", "tbz-zone-text", "tbz-zone-hint", "tbz-done-title", "tbz-next", "tbz-retry", "tbz-log-title"]], ["track.html", ["tbz-track-headline", "tbz-track-intro", "tbz-code-label", "tbz-go", "tbz-found-title", "tbz-download", "tbz-another"]]]) {
    const html = src(`public/${page}`);
    for (const id of ids) assert.match(html, new RegExp(`id="${id}"[^>]*>\\s*<`), `${page} #${id} is empty in the markup`);
  }
  for (const file of ["booth.js", "track.js", "booth-rules.js", "booth-copy.js", "track-copy.js"]) {
    assert.ok(!/email/i.test(src(`public/js/${file}`)), `${file}: no email anywhere on the booth pages`);
    assert.ok(!/localStorage|sessionStorage|document\.cookie|indexedDB/.test(src(`public/js/${file}`)), `${file}: nothing is kept on the device`);
  }
});

test("/booth: a drop zone that is also tap-to-choose, an upload with progress, the code in very large type, Next file, a retry, today's log", () => {
  const html = src("public/booth.html");
  const js = src("public/js/booth.js");
  const css = src("public/css/site.css");
  assert.match(html, /<meta name="robots" content="noindex">/, "the engineer's page is not for search");
  assert.match(html, /<label id="tbz-zone" class="zone" for="tbz-file">/, "the zone is the file input's label: a tap opens the chooser");
  assert.match(html, /<input type="file" id="tbz-file" class="sr-only" accept="audio\/\*,\.wav,\.mp3,\.m4a,\.aif,\.aiff,\.flac">/);
  assert.match(js, /new XMLHttpRequest\(\)/, "an XMLHttpRequest: fetch has no upload progress");
  assert.match(js, /xhr\.upload\.addEventListener\("progress"/);
  assert.match(js, /xhr\.open\("POST", "\/api\/booth\/tracks"\)/);
  assert.match(js, /xhr\.setRequestHeader\("x-file-name", encodeURIComponent\(file\.name\)\)/);
  assert.match(js, /xhr\.setRequestHeader\("content-type", file\.type \|\| "application\/octet-stream"\)/);
  assert.match(js, /xhr\.send\(file\)/, "the raw file, not a form");
  assert.ok(!/FormData|multipart/.test(js));
  assert.match(js, /els\.file\.disabled = state === "uploading"/, "uploading disables the zone");
  for (const ev of ["dragover", "drop"]) assert.ok(js.includes(`"${ev}"`), `${ev} is handled`);
  assert.match(js, /ev\.dataTransfer\?\.files\?\.\[0\]/);
  assert.match(html, /<p id="tbz-code" class="booth-code" tabindex="-1"><\/p>/);
  assert.match(css, /\n\.booth-code \{ font: 400 clamp\(4\.5rem, 23vw, 12rem\)\/1 var\(--font-display\);[^}]*white-space: nowrap;/, "the code is as big as the phone allows, on one line (390px wide: no sideways scroll)");
  assert.match(html, /<button type="button" id="tbz-next" class="btn"><\/button>/);
  assert.match(css, /\n\.log li \{ display: grid; grid-template-columns: max-content minmax\(0, 1fr\);/, "the log's code column is as wide as the code, never a fixed width that wraps it (390px wide it broke 2947 into 294 / 7)");
  assert.match(css, /\n\.log-code \{[^}]*white-space: nowrap;/, "a code in the log stays on one line");
  assert.match(html, /<div id="tbz-failed" class="failed" role="alert" hidden>/);
  assert.match(html, /<button type="button" id="tbz-retry" class="btn btn-small"><\/button>/);
  assert.match(js, /if \(app\.lastFile\) upload\(app\.lastFile\)/, "retry sends the same file again");
  assert.match(html, /<div id="tbz-progress" class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"/);
  assert.match(js, /fetch\("\/api\/booth\/tracks"/, "the log comes from the log route");
  assert.match(js, /todayRows\(data\.tracks\)/);
  assert.match(js, /\[formatTime\(r\.uploaded_at\), formatSize\(r\.size\), openedWords\(r\.opened\)\]/, "each row: code, file name, time, size, how often opened");
  assert.ok(!/x-booth-key|passphrase|BOOTH_KEY/i.test(js + html), "no passphrase: the page is open (the owner's call, 3 Oct 2026)");
  assert.ok(!/\.(innerHTML|outerHTML)/.test(js));
});

test("/track: Hear your track, one numeric code box that sends itself on the fourth digit, the vote's player, Download; ?code= is looked up on load", () => {
  const html = src("public/track.html");
  const js = src("public/js/track.js");
  assert.ok(!/name="robots"/.test(html), "the rapper's page is open");
  assert.match(html, /<input id="tbz-code" type="text" inputmode="numeric" autocomplete="off" autocorrect="off" spellcheck="false" maxlength="4" pattern="\[0-9\]\*" enterkeyhint="go" aria-describedby="tbz-code-msg">/);
  assert.match(html, /<button type="submit" id="tbz-go" class="btn"><\/button>/);
  assert.match(html, /<form id="tbz-code-form" class="code-form" novalidate>/);
  assert.match(html, /<div class="field field-code">/, "the same big code field the gate uses");
  assert.match(js, /if \(digits\.length === 4\) lookUp\(digits\)/, "the fourth digit sends it");
  assert.match(js, /api\(`\/api\/booth\/tracks\/\$\{code\}`/);
  assert.match(js, /import \{ createControls, createPlayer \} from "\.\/player\.js"/, "the vote's player, not a fork");
  assert.ok(!/new Audio\(/.test(js), "no audio element of its own");
  assert.match(js, /els\.download\.href = track\.download_url/);
  assert.match(html, /<a id="tbz-download" class="btn" download><\/a>/, "a real download link, no href until there is a track");
  assert.match(js, /COPY\.notFound/);
  assert.match(js, /err\?\.status === 429 \|\| err\?\.code === "rate_limited" \? COPY\.tooMany/);
  assert.match(js, /codeFromSearch\(location\.search\)/);
  assert.match(js, /lookUp\(fromAddress\)/);
  assert.match(html, /<h1 class="slogan">JUMP IN THE BOOTH<\/h1>/);
  assert.ok(!/x-booth-key|passphrase/i.test(js + html));
});

test("/track-qr: one big QR that encodes exactly https://voting.topbarz.xyz/track, the line under it, the address in words; no script", () => {
  const html = src("public/track-qr.html");
  const svg = src("public/img/track-qr.svg");
  assert.equal(TRACK_URL, "https://voting.topbarz.xyz/track");
  assert.match(html, /<img class="qr-code" src="\/img\/track-qr\.svg" width="37" height="37" alt="QR code that opens voting\.topbarz\.xyz\/track">/);
  assert.equal([...html.matchAll(/<img\b/g)].length, 2, "the logo and the one QR");
  assert.match(html, /<p class="qr-text">Scan\. Enter the code your engineer gives you\. Hear and download your track\.<\/p>/);
  assert.match(html, /<p class="qr-url">https:\/\/voting\.topbarz\.xyz\/track<\/p>/);
  assert.ok(!/<script/.test(html), "no script on the sign");
  assert.match(html, /<meta name="robots" content="noindex">/);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 37 37" shape-rendering="crispEdges">/, "a 29-module QR (version 3) with a 4-module quiet zone");
  assert.match(svg, /<path fill="#ffffff" d="M0 0h37v37H0z"\/>/, "white behind the modules, so it scans on the black page and on paper");
  assert.ok(!/<script|<image|href=|xlink/.test(svg), "nothing but paths in the SVG");
  assert.equal([...svg.matchAll(/<path\b/g)].length, 2);
  // The generator writes this exact file from that exact address (run it again: nothing changes).
  const run = spawnSync(process.execPath, [path.join(ROOT, "scripts/make-track-qr.mjs")], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /encoding https:\/\/voting\.topbarz\.xyz\/track$/m);
  assert.equal(src("public/img/track-qr.svg"), svg, "the committed SVG is what the generator makes");
  assert.equal(JSON.parse(src("package.json")).scripts["make-track-qr"], "node scripts/make-track-qr.mjs");
  assert.ok("qrcode" in JSON.parse(src("package.json")).devDependencies, "the generator's library is a dev dependency, never shipped");
  assert.match(src("public/css/site.css"), /@media print \{\s*\.print-page \{ background: var\(--color-print-paper\); color: var\(--color-print-ink\); \}/, "ink on white when it is printed");
});

// ── The log script and the docs ──────────────────────────────────────────────────────────────
test("npm run booth-log writes exports/booth-log.csv (code, file name, size, uploaded_at ISO, opened) from the booth table only, and stops when there is nothing", () => {
  assert.equal(JSON.parse(src("package.json")).scripts["booth-log"], "node scripts/booth-log.mjs");
  assert.equal(BOOTH_LOG_SQL, "SELECT code, file_name, size, uploaded_at, opened FROM booth_tracks ORDER BY uploaded_at DESC, id DESC");
  const csv = boothLogCsv([
    { code: "0042", file_name: "Test - Carlos & Damien.mp3", size: 2735168, uploaded_at: Date.parse("2026-10-10T20:15:00Z"), opened: 2 },
    { code: "1234", file_name: '=HYPERLINK("x"), "take".wav', size: null, uploaded_at: 0, opened: 0 },
  ]);
  assert.equal(csv, 'code,file_name,size,uploaded_at,opened\n0042,Test - Carlos & Damien.mp3,2735168,2026-10-10T20:15:00.000Z,2\n1234,"\'=HYPERLINK(""x""), ""take"".wav",,1970-01-01T00:00:00.000Z,0\n');
  const run = (...args) => spawnSync(process.execPath, [path.join(ROOT, "scripts/booth-log.mjs"), ...args], { encoding: "utf8" });
  const none = run();
  assert.equal(none.status, 2);
  assert.match(none.stderr, /--env local \| preview \| production/);
  assert.match(src("scripts/booth-log.mjs"), /console\.error\(`STOPPED: \$\{target\.db\} has no booth tracks; there is nothing to log\.`\); process\.exit\(1\);/);
  assert.match(src("scripts/booth-log.mjs"), /path\.join\(ROOT, "exports"\)/, "into the git-ignored exports/ folder");
  assert.match(src(".gitignore"), /^exports\/$/m);
});

test("the docs say how the booth works: RUNBOOK's booth section, the three routes in the API table, the limits, and one CLAUDE.md bullet", () => {
  const runbook = src("RUNBOOK.md");
  const section = /\n## The booth \(engineer upload and track codes\)\n([\s\S]*?)(?=\n## )/.exec(runbook)?.[1] ?? "";
  for (const said of ["/booth", "/track", "/track-qr", "npm run booth-log -- --env production", "exports/booth-log.csv", "100 MB", "60 uploads an hour", "300 a day", "5 a minute", "30 an hour", "booth_tracks", "/media/booth/", "?dl=1", "public/js/booth-copy.js", "public/js/track-copy.js", "scripts/make-track-qr.mjs", "tests/booth.test.mjs", "no passphrase"]) {
    assert.ok(section.includes(said), `RUNBOOK.md, "The booth", does not cover: ${said}`);
  }
  const api = /\n## The API a front end calls\n([\s\S]*?)(?=\n## )/.exec(runbook)?.[1] ?? "";
  for (const route of ["`POST /api/booth/tracks`", "`GET /api/booth/tracks`", "`GET /api/booth/tracks/<code>`", "`/media/booth/…`"]) assert.ok(api.includes(route), `the API table does not list ${route}`);
  assert.match(api, /\*\*`GET \/api\/booth\/tracks\/<code>`\*\*/);
  const limits = /\n## Limits[^\n]*\n([\s\S]*?)(?=\n## |$)/.exec(runbook)?.[1] ?? "";
  assert.match(limits, /Booth: 60 uploads an hour per IP and 300 a day for the whole site \(`booth-uploads-day`\); log 60 a minute per IP; code lookups 5 a minute and 30 an hour per IP\./);
  assert.ok(!/BOOTH_KEY|passphrase/.test(runbook.replace(/no passphrase/g, "")), "nothing about a passphrase: there is none");
  const claude = src("CLAUDE.md");
  assert.match(claude, /- \*\*The booth \(`\/booth`, `\/track`\)\.\*\*/);
  assert.ok(/booth_tracks/.test(claude) && /tests\/booth\.test\.mjs/.test(claude));
});
