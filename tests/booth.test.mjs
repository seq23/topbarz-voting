// The booth: POST /api/booth/tracks (an engineer's upload → a 4-digit code), GET /api/booth/tracks
// (the log), POST /api/booth/tracks/<code>/enter (the rapper's way in, with an email), the people
// and the vote rule (4 Oct 2026: share is anyone's call, the vote is everyone's consent, and the
// only door onto the voting site is scripts/promote-booth.mjs), the download header, the two
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
import * as listenPage from "../functions/listen/[[path]].js";
import {
  ACCESS_SQL, ART_MAX_BYTES, ART_SQL, ATTACH_SQL, BOOTH_CODE_TRIES, BOOTH_DAY_KEY, BOOTH_EXTENSIONS, BOOTH_LOG_ROWS, BOOTH_MAX_BYTES, BOOTH_NAME_MAX, EMAIL_MAX, LISTEN_SQL, LOG_SQL, OPEN_SQL, PEOPLE_SQL, PUBLIC_SQL, VOTE_SQL,
  allIn, artKey, artMagic, artSize, artType, audioExtension, audioType, cleanEmail, cleanFileName, countPeople, downloadName, everyoneIn, isCode, isShareId, mediaKey, promoteVerdict, randomCode, reserveCode, shareId, uploadSize,
} from "../functions/_lib/booth.js";
import { LIMITS } from "../functions/_lib/config.js";
import { isScooterTaylor, isTestName } from "../functions/_lib/exclusions.js";
import { computeTally } from "../functions/_lib/tally.js";
import { COPY as BOOTH_COPY } from "../public/js/booth-copy.js";
import {
  ART_SIDE, CODE_LENGTH, EMAIL_MAX as PAGE_EMAIL_MAX, MAX_UPLOAD_BYTES, UPLOAD_EXTENSIONS, artworkFor, cleanEmail as pageCleanEmail, cleanListen, cleanPeople, cleanTrack, codeDigits, codeFromSearch, formatSize, openedWords, peopleWords, refuseFile, safeArtUrl, safeBoothUrl, shareIdFromPath, shareRoute, squareCrop, todayRows, uploadFailure, voteWords,
} from "../public/js/booth-rules.js";
import { COPY as LISTEN_COPY } from "../public/js/listen-copy.js";
import { boothShareMessage, detectPlatform, listenLink, smsHref } from "../public/js/logic.js";
import { COPY as TRACK_COPY } from "../public/js/track-copy.js";
import { BOOTH_LOG_SQL, BOOTH_PEOPLE_SQL, boothLogCsv, boothPeopleCsv } from "../scripts/booth-log.mjs";
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
// The way in (4 Oct 2026): the code WITH an email. `lookup` is the entry by one default email,
// where a test only needs the track; `lookupGet` is the route that was the lookup, now gone.
const ME = "artist@example.com";
const OTHER = "friend@example.com";
const enter = (env, code, email = ME, ip = freshIp()) => call(booth.onRequest, env, { method: "POST", path: `/api/booth/tracks/${code}/enter`, ip, body: { email }, params: { path: ["tracks", code, "enter"] } });
const lookup = (env, code, ip) => enter(env, code, ME, ip);
const lookupGet = (env, code, ip = freshIp()) => call(booth.onRequest, env, { path: `/api/booth/tracks/${code}`, ip, params: { path: ["tracks", code] } });
const vote = (env, code, body, ip = freshIp()) => call(booth.onRequest, env, { method: "POST", path: `/api/booth/tracks/${code}/vote`, ip, body: { email: ME, ...body }, params: { path: ["tracks", code, "vote"] } });
const log = (env, ip = freshIp()) => call(booth.onRequest, env, { path: "/api/booth/tracks", ip, params: { path: ["tracks"] } });
const getMedia = (env, url, headers = {}) => { const [p, q] = url.split("?"); return call(media.onRequest, env, { path: p + (q ? `?${q}` : ""), headers, params: { path: p.replace("/media/", "").split("/") } }); };
// The share (4 Oct 2026): the switch, the listen page's read, and the artwork (a raw body, as the page sends it).
// The change routes carry the email (the body for the switch and the vote, the x-email header for the artwork); ME unless a test says otherwise.
const setPublic = (env, code, body, ip = freshIp()) => call(booth.onRequest, env, { method: "POST", path: `/api/booth/tracks/${code}/public`, ip, body: body && typeof body === "object" ? { email: ME, ...body } : body, params: { path: ["tracks", code, "public"] } });
const listen = (env, id, ip = freshIp()) => call(booth.onRequest, env, { path: `/api/booth/listen/${id}`, ip, params: { path: ["listen", id] } });
async function putArt(env, code, { bytes, type = "image/jpeg", length = bytes?.byteLength, ip = freshIp(), method = "POST", email = ME } = {}) {
  const h = new Headers({ "cf-connecting-ip": ip });
  if (email !== null) h.set("x-email", email);
  if (type !== null) h.set("content-type", type);
  if (length !== null && length !== undefined) h.set("content-length", String(length));
  const request = new Request(`https://voting.test/api/booth/tracks/${code}/art`, { method, headers: h, body: bytes ?? undefined });
  const pending = [];
  const res = await booth.onRequest({ request, env, params: { path: ["tracks", code, "art"] }, waitUntil: (x) => pending.push(x) });
  await Promise.all(pending);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch {}
  return { status: res.status, body, text, headers: res.headers };
}
// The smallest things that are a JPEG and a PNG by their first bytes (the server never decodes a picture).
const jpeg = (n = 600, fill = 0x11) => { const b = new Uint8Array(n).fill(fill); b.set([0xff, 0xd8, 0xff, 0xe0]); b.set([0xff, 0xd9], n - 2); return b; };
const png = (n = 600) => { const b = new Uint8Array(n).fill(0x22); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); return b; };

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
test("POST /api/booth/tracks/<code>/enter: the right code WITH an email gives the track, attaches the email and counts the open; a wrong code is a 404; a bad email is a 400 that spends no try; never another person's email, never a list, never a search; the old GET lookup is gone", async () => {
  const up = await upload(env, { name: "Test - Chelos x Madame Prez x Cam.mp3", type: "audio/mpeg", bytes: wav(1200) });
  assert.equal(up.status, 200);
  const { code } = up.body;
  const found = await enter(env, code, " Chelos@Example.COM ");
  assert.equal(found.status, 200, found.text);
  assert.deepEqual(Object.keys(found.body), ["code", "file_name", "audio_url", "download_url", "size", "uploaded_at", "public", "share_id", "art_url", "you", "people", "opted", "everyone_in"]);
  assert.deepEqual([found.body.public, found.body.share_id, found.body.art_url], [false, null, null], "a new track is private, with no link and no artwork");
  assert.deepEqual(found.body.you, { email: "chelos@example.com", vote_opt_in: false }, "this person's own state, the email as it is kept (trimmed, lower-cased)");
  assert.deepEqual([found.body.people, found.body.opted, found.body.everyone_in], [1, 0, false], "one person attached, nobody in: not everyone in");
  assert.equal(found.body.code, code);
  assert.equal(found.body.file_name, "Test - Chelos x Madame Prez x Cam.mp3");
  assert.match(found.body.audio_url, new RegExp(`^/media/booth/${code}-[0-9a-f]{16}\\.mp3$`));
  assert.equal(found.body.download_url, `${found.body.audio_url}?dl=1`);
  assert.equal(found.body.size, 1200);
  assert.equal(found.body.uploaded_at, up.body.uploaded_at);
  assert.equal(found.headers.get("cache-control"), "no-store");
  assert.ok(!/media_key|opened|art_key|track_id|attached_at|opted_at/.test(found.text), "the keys, the count and the people's rows are not in the answer");
  const again = await enter(env, code, "chelos@example.com");
  assert.deepEqual([again.body.people, again.body.you.email], [1, "chelos@example.com"], "the same email again is the same person");
  const row = await env.DB.prepare("SELECT opened, last_opened_at FROM booth_tracks WHERE code = ?1").bind(code).first();
  assert.equal(row.opened, 2, "each entry is one open");
  assert.ok(Date.now() - row.last_opened_at < 10_000);
  const people = async () => (await env.DB.prepare("SELECT p.email, p.vote_opt_in, p.opted_at, p.attached_at FROM booth_people p JOIN booth_tracks t ON t.id = p.track_id WHERE t.code = ?1 ORDER BY p.id").bind(code).all()).results;
  assert.deepEqual((await people()).map((p) => [p.email, p.vote_opt_in, p.opted_at]), [["chelos@example.com", 0, null]], "attached once, out until they say otherwise");
  assert.ok(Date.now() - (await people())[0].attached_at < 10_000);
  // A second person, the same code: attached beside the first; each is answered their own email only.
  const second = await enter(env, code, "prez@example.com");
  assert.deepEqual([second.body.people, second.body.opted, second.body.everyone_in, second.body.you], [2, 0, false, { email: "prez@example.com", vote_opt_in: false }]);
  assert.ok(!second.text.includes("chelos"), "never another person's email");
  assert.ok(!(await enter(env, code, "chelos@example.com")).text.includes("prez"));
  // A bad email: 400 bad_email, nothing attached, and no try spent against the 5 a minute.
  const ip = freshIp();
  const bads = ["", " ", "chelos", "chelos@", "@example.com", "a@b", "a@.com", "a@b.", "a@b..c", "a b@c.d", "a@@b.co", "a@b .co", `${"x".repeat(250)}@b.co`, 5, null, ["a@b.co"]];
  for (const bad of bads) {
    const r = await call(booth.onRequest, env, { method: "POST", path: `/api/booth/tracks/${code}/enter`, ip, body: { email: bad }, params: { path: ["tracks", code, "enter"] } });
    assert.deepEqual([r.status, r.body.error, r.body.message], [400, "bad_email", "Enter your email."], JSON.stringify(bad));
  }
  assert.equal((await call(booth.onRequest, env, { method: "POST", path: `/api/booth/tracks/${code}/enter`, ip, body: "nope", params: { path: ["tracks", code, "enter"] } })).status, 400);
  assert.equal((await call(booth.onRequest, env, { method: "POST", path: `/api/booth/tracks/${code}/enter`, ip, body: {}, params: { path: ["tracks", code, "enter"] } })).body.error, "bad_email");
  assert.equal((await people()).length, 2, "none of them was attached");
  assert.equal((await enter(env, code, "cam@example.com", ip)).status, 200, `${bads.length} bad emails from one connection spent none of its 5 tries`);
  assert.equal((await people()).length, 3);
  // A wrong code: 404 not_found, the same words as before, for anything that is not a known 4-digit code.
  const wrongCode = code === "0000" ? "0001" : "0000";
  const missing = await enter(env, wrongCode);
  assert.deepEqual([missing.status, missing.body.error], [404, "not_found"]);
  assert.equal(missing.body.message, "No track with that code yet. Ask your engineer.");
  for (const bad of ["12", "12345", "abcd", "%20", "..", `${code}%0A`]) assert.equal((await enter(env, bad)).status, 404, bad);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM booth_people WHERE email = ?1").bind(ME).first()).n, 0, "a wrong code attaches nothing");
  // The old lookup is gone: there is no track without an email. The log keeps its trailing-slash address.
  assert.equal((await lookupGet(env, code)).status, 404, "GET /api/booth/tracks/<code> is no route");
  assert.equal((await call(booth.onRequest, env, { path: `/api/booth/tracks/${code}/enter`, params: { path: ["tracks", code, "enter"] } })).status, 404, "GET on enter is no route");
  assert.equal((await call(booth.onRequest, env, { path: "/api/booth/tracks/", params: { path: ["tracks", ""] } })).status, 200, "a trailing slash is the log, not a lookup");
  assert.equal((await call(booth.onRequest, env, { path: `/api/booth/tracks/${code}/x`, params: { path: ["tracks", code, "x"] } })).status, 404);
  assert.equal((await call(booth.onRequest, env, { method: "POST", path: `/api/booth/tracks/${code}/x`, params: { path: ["tracks", code, "x"] }, body: { email: ME } })).status, 404);
  const source = src("functions/api/booth/[[path]].js") + src("functions/_lib/booth.js");
  assert.ok(!/\bLIKE\b|"search"|"list"|\?q=/.test(source), "no search and no listing of codes anywhere in the booth code");
  assert.ok(!/SELECT[^;]*FROM booth_tracks(?![^;]*(?:WHERE code = \?1|WHERE share_id = \?1|LIMIT \$\{BOOTH_LOG_ROWS\}))/.test(source), "every read of the table is one code, one share id, or the capped log");
  assert.ok(!/(?:UPDATE|DELETE FROM) booth_tracks(?![^;]*WHERE (?:code|id) = \?1)/.test(source), "every write to the table is one code or one row");
  assert.match(OPEN_SQL, /^UPDATE booth_tracks SET opened = opened \+ 1, last_opened_at = \?2 WHERE code = \?1 RETURNING id, /, "one statement: the open is counted in the same step that finds the row, and the row's id is what the people hang off");
  // The people's table: every read is one track's people (by id, or by its code in the one read
  // that finds the code and the person together); every write is one person of one track; the
  // same person again is INSERT OR IGNORE; an email is never in a URL (the body or a header only).
  assert.ok(!/SELECT[^;]*FROM booth_people(?![^;]*WHERE track_id = \?1)/.test(source), "every read of the people is one track's");
  assert.ok(!/(?:UPDATE|DELETE FROM) booth_people(?![^;]*WHERE track_id = \?1 AND email = \?2)/.test(source), "every write to the people is one person of one track");
  assert.ok(!/INSERT INTO booth_people/.test(source) && ATTACH_SQL.startsWith("INSERT OR IGNORE INTO booth_people"), "attaching the same person again changes nothing");
  assert.equal(ATTACH_SQL, "INSERT OR IGNORE INTO booth_people (track_id, email, attached_at) VALUES (?1, ?2, ?3)");
  assert.equal(PEOPLE_SQL, "SELECT email, vote_opt_in FROM booth_people WHERE track_id = ?1");
  assert.equal(ACCESS_SQL, "SELECT t.id AS track_id, p.id AS person_id FROM booth_tracks t LEFT JOIN booth_people p ON p.track_id = t.id AND p.email = ?2 WHERE code = ?1");
  assert.equal(VOTE_SQL, "UPDATE booth_people SET vote_opt_in = ?3, opted_at = ?4 WHERE track_id = ?1 AND email = ?2 RETURNING vote_opt_in");
  assert.ok(!/searchParams|\.search\b|\?email|email=/.test(src("functions/api/booth/[[path]].js")), "no email in a query string, ever");
  // What the routes hand out: `you` is built from the email the request carried, never from a row's email.
  assert.match(src("functions/api/booth/[[path]].js"), /return \{ you: \{ email, vote_opt_in: me\?\.vote_opt_in === 1 \}, \.\.\.countPeople\(rows\) \};/, "the answer's email is the one the request carried");
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
    assert.deepEqual(res.body.tracks[0], { code: "0204", file_name: "Take 204.wav", uploaded_at: new Date(t0 + 204_000).toISOString(), opened: 0, size: 304, public: false, art_url: null, people: 0, everyone_in: false });
    assert.ok(!/share_id|art_key|media_key/.test(res.text), "never a share id or a key in the log");
    assert.equal(res.body.tracks[199].code, "0005", "the oldest five fell off");
    assert.ok(!res.text.includes("media_key") && !res.text.includes("booth/"), "the log never carries a key");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(LOG_SQL, "SELECT t.code, t.file_name, t.size, t.uploaded_at, t.opened, t.public, t.art_key, COUNT(p.id) AS people, COALESCE(SUM(p.vote_opt_in), 0) AS opted FROM booth_tracks t LEFT JOIN booth_people p ON p.track_id = t.id GROUP BY t.id ORDER BY t.uploaded_at DESC, t.id DESC LIMIT 200", "counts of people, never their rows");
    // The people in the log (4 Oct 2026): how many, and whether every one of them is in; never an email.
    await enter(fresh.env, "0204", "one@example.com");
    await enter(fresh.env, "0204", "two@example.com");
    await enter(fresh.env, "0203", "one@example.com");
    await vote(fresh.env, "0203", { email: "one@example.com", opt_in: true });
    const counted = await log(fresh.env);
    assert.deepEqual(counted.body.tracks.slice(0, 3).map((t) => [t.code, t.people, t.everyone_in, t.opened]), [["0204", 2, false, 2], ["0203", 1, true, 3], ["0202", 0, false, 1]], "two attached and out; one attached and in; nobody (the opens: the seeded i % 3 plus one per entry)");
    assert.ok(!/@|example|vote_opt_in|"opted"|attached|email/.test(counted.text), "no email, no name and no per-person state in the log");
    assert.equal(counted.body.tracks.length, BOOTH_LOG_ROWS, "the join does not multiply rows");
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
  for (const file of vote) assert.ok(!/booth_tracks|booth_people|\/api\/booth|booth\//i.test(src(file)), `${file} never touches the booth`);
  const mentions = (word) => {
    const found = [];
    const walk = (dir) => { for (const f of fs.readdirSync(dir, { withFileTypes: true })) { if ([".git", "node_modules", ".wrangler", ".work", "exports", "fixtures"].includes(f.name)) continue; const p = path.join(dir, f.name); if (f.isDirectory()) walk(p); else if (/\.(js|mjs|sql|md|json|html|toml|yml)$/.test(f.name) && fs.readFileSync(p, "utf8").includes(word)) found.push(path.relative(ROOT, p)); } };
    walk(ROOT);
    return found.sort();
  };
  assert.deepEqual(mentions("booth_tracks"), ["CLAUDE.md", "RUNBOOK.md", "functions/_lib/booth.js", "functions/api/booth/[[path]].js", "migrations/0004_booth_tracks.sql", "migrations/0005_booth_share.sql", "migrations/0006_booth_people.sql", "scripts/booth-log.mjs", "scripts/promote-booth.mjs", "tests/booth.test.mjs"], "booth_tracks is named only by the booth's own code, its three migrations, its two scripts, this test and the two docs");
  assert.deepEqual(mentions("booth_people"), ["CLAUDE.md", "RUNBOOK.md", "functions/_lib/booth.js", "functions/api/booth/[[path]].js", "migrations/0006_booth_people.sql", "scripts/booth-log.mjs", "scripts/promote-booth.mjs", "tests/booth.test.mjs"], "booth_people (the emails) is read by the booth's routes, its log script and its promotion script only: never /api/state, the tally, the export or /api/beats");
  assert.ok(!/booth_tracks|booth_people|\/api\/booth|share_id|ASSETS/.test(src("public/js/app.js") + src("public/js/select.js")), "the vote's pages know nothing of the share or the people");
  assert.ok(!/booth_tracks|booth_people|DB\.|MEDIA\.|prepare\(/.test(src("functions/listen/[[path]].js")), "the listen page's function reads no table and no bucket: it serves the page, the page asks the API");
  const boothSql = [src("functions/_lib/booth.js"), src("scripts/booth-log.mjs"), src("functions/api/booth/[[path]].js")].join(" ");
  const tables = [...boothSql.matchAll(/(?:FROM|INTO|UPDATE|JOIN) ([a-z_]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(tables)].sort(), ["booth_people", "booth_tracks"], "the booth reads and writes its two tables only (the counters go through ratelimit.js)");
  assert.deepEqual([...new Set([...src("scripts/promote-booth.mjs").matchAll(/(?:FROM|INTO|UPDATE|JOIN) ([a-z_]+)/g)].map((m) => m[1]))].sort(), ["booth_people", "booth_tracks", "tracks"], "the promotion reads the booth's two tables and writes the vote's tracks");
  assert.ok(!/(?:UPDATE|DELETE FROM|INSERT INTO) booth_/.test(src("scripts/promote-booth.mjs")), "and never changes a booth row");
  assert.ok(!/config\.js.*VOTING|votingWindow|votingEndsAtMs|END_SETTING/.test(src("functions/api/booth/[[path]].js")), "the booth does not read the voting window");
  const migration = src("migrations/0004_booth_tracks.sql").replace(/--.*$/gm, "");
  assert.match(migration, /CREATE TABLE booth_tracks \(/);
  assert.ok(!/\b(tracks|like_events|voters|comments|beats|settings)\b/.test(migration) && !/ALTER TABLE|DROP /.test(migration), "the migration adds the booth table and touches nothing else");
  for (const col of ["code", "file_name", "content_type", "size", "media_key", "uploaded_at", "opened", "last_opened_at"]) assert.match(migration, new RegExp(`\\n\\s+${col}\\s`), col);
  assert.match(migration, /code\s+TEXT NOT NULL UNIQUE/);
  assert.match(migration, /media_key\s+TEXT NOT NULL UNIQUE/);
  assert.match(migration, /opened\s+INTEGER NOT NULL DEFAULT 0/);
  // The share's migration (4 Oct 2026): three columns on the booth's table, one unique index, nothing else.
  const share = src("migrations/0005_booth_share.sql").replace(/--.*$/gm, "");
  assert.deepEqual(share.split(";").map((x) => x.trim()).filter(Boolean), [
    "ALTER TABLE booth_tracks ADD COLUMN public INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE booth_tracks ADD COLUMN share_id TEXT",
    "ALTER TABLE booth_tracks ADD COLUMN art_key TEXT",
    "CREATE UNIQUE INDEX booth_tracks_share_id ON booth_tracks (share_id)",
  ], "exactly these four statements: public off by default for every track, a unique share id, an artwork key");
  const cols = (await env.DB.prepare("PRAGMA table_info(booth_tracks)").all()).results.map((c) => c.name);
  assert.deepEqual(cols, ["id", "code", "file_name", "content_type", "size", "media_key", "uploaded_at", "opened", "last_opened_at", "public", "share_id", "art_key"]);
  // The people's migration (4 Oct 2026): one table hanging off booth_tracks, one index, nothing else.
  const peopleSql = src("migrations/0006_booth_people.sql").replace(/--.*$/gm, "");
  assert.match(peopleSql, /CREATE TABLE booth_people \(/);
  assert.ok(!/\b(tracks|like_events|voters|comments|beats|settings|email_codes|email_sends)\b/.test(peopleSql) && !/ALTER TABLE|DROP /.test(peopleSql), "the migration adds the people's table and touches nothing else");
  assert.deepEqual(peopleSql.split(";").map((x) => x.trim().replace(/\s+/g, " ")).filter(Boolean), [
    "CREATE TABLE booth_people ( id INTEGER PRIMARY KEY AUTOINCREMENT, track_id INTEGER NOT NULL REFERENCES booth_tracks(id), email TEXT NOT NULL, attached_at INTEGER NOT NULL, vote_opt_in INTEGER NOT NULL DEFAULT 0 CHECK (vote_opt_in IN (0, 1)), opted_at INTEGER, UNIQUE (track_id, email) )",
    "CREATE INDEX booth_people_track ON booth_people (track_id)",
  ], "exactly these two statements");
  const peopleCols = (await env.DB.prepare("PRAGMA table_info(booth_people)").all()).results.map((c) => c.name);
  assert.deepEqual(peopleCols, ["id", "track_id", "email", "attached_at", "vote_opt_in", "opted_at"]);
  await assert.rejects(env.DB.prepare("INSERT INTO booth_people (track_id, email, attached_at, vote_opt_in) VALUES (1, 'x@y.co', 1, 2)").run(), /CHECK|constraint/i, "vote_opt_in is 0 or 1");
  // The people are never in the vote's data: no vote-side file names them, and the vote's email
  // (voters.email) and the booth's (booth_people.email) are never joined or compared anywhere.
  assert.ok(!/booth_people/.test(src("functions/_lib/verify.js") + src("functions/api/voters.js") + src("functions/_lib/state.js") + src("scripts/export.mjs")));
  assert.ok(!/voters\b/.test(boothSql) && !/voters\b/.test(src("scripts/promote-booth.mjs")), "the booth never reads the voters");
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

test("the entry's answer is shown only when it is well-formed (the track, this person's own state, the counts); the two media addresses are only ever /media/booth/…", () => {
  const me = { you: { email: "Me@Example.com", vote_opt_in: false }, people: 1, opted: 0, everyone_in: false };
  const good = { code: "2468", file_name: " Take 3.wav ", audio_url: "/media/booth/2468-0123456789abcdef.wav", download_url: "/media/booth/2468-0123456789abcdef.wav?dl=1", size: 1234, uploaded_at: "2026-10-03T00:00:00.000Z", ...me };
  assert.deepEqual(cleanTrack(good), { code: "2468", file_name: "Take 3.wav", audio_url: good.audio_url, download_url: good.download_url, size: 1234, public: false, share_id: null, art_url: null, you: { email: "me@example.com", vote_opt_in: false }, people: 1, opted: 0, everyone_in: false });
  // The people part (4 Oct 2026): `you` must carry a real email; counts are whole numbers, opted never more than people; everyone_in only when the server said so AND the counts agree.
  assert.deepEqual(cleanPeople({ you: { email: "a@b.co", vote_opt_in: true }, people: 3, opted: 3, everyone_in: true }), { you: { email: "a@b.co", vote_opt_in: true }, people: 3, opted: 3, everyone_in: true });
  assert.deepEqual(cleanPeople({ you: { email: "a@b.co", vote_opt_in: "yes" }, people: "2", opted: 1, everyone_in: true }), { you: { email: "a@b.co", vote_opt_in: false }, people: 2, opted: 1, everyone_in: false }, "a server that says everyone is in while one is out is not believed");
  assert.equal(cleanPeople({ you: { email: "a@b.co" }, people: 0, opted: 0, everyone_in: true }).everyone_in, false, "nobody is not everyone");
  for (const bad of [null, {}, { you: null }, { you: { email: "nope" }, people: 1, opted: 0 }, { you: { email: "a@b.co" }, people: -1, opted: 0 }, { you: { email: "a@b.co" }, people: 1.5, opted: 0 }, { you: { email: "a@b.co" }, people: 1, opted: 2 }, { you: { email: "a@b.co" }, people: 1 }]) assert.equal(cleanPeople(bad), null, JSON.stringify(bad));
  assert.equal(cleanTrack({ ...good, you: { email: "x" } }), null, "no track without this person's state");
  // The line under the vote switch: one person → only you; all in → everyone; else how many are out.
  const copy = { voteOnlyYou: "ONLY", voteAll: "ALL", voteWaiting: "{n} of {total}" };
  assert.equal(voteWords(copy, { people: 1, opted: 0, everyone_in: false }), "ONLY");
  assert.equal(voteWords(copy, { people: 1, opted: 1, everyone_in: true }), "ONLY", "one person in is still only you: the others have not entered");
  assert.equal(voteWords(copy, { people: 3, opted: 3, everyone_in: true }), "ALL");
  assert.equal(voteWords(copy, { people: 4, opted: 1, everyone_in: false }), "3 of 4");
  assert.equal(voteWords(copy, { people: 2, opted: 0, everyone_in: false }), "2 of 2");
  assert.equal(voteWords(TRACK_COPY, { people: 4, opted: 1, everyone_in: false }), "Vote: waiting on 3 of 4");
  assert.equal(cleanTrack({ ...good, size: "x" }).size, 0);
  // The share state: public only when the server says true AND gives a 16-character id; the id only then; artwork only at its own address.
  const shared = { ...good, public: true, share_id: "0123456789abcdef", art_url: "/media/booth/art/0123456789abcdef-0123456789.jpg" };
  assert.deepEqual([cleanTrack(shared).public, cleanTrack(shared).share_id, cleanTrack(shared).art_url], [true, "0123456789abcdef", shared.art_url]);
  for (const half of [{ ...shared, public: "true" }, { ...shared, public: 1 }, { ...shared, share_id: "2468" }, { ...shared, share_id: null }, { ...shared, public: false }]) assert.deepEqual([cleanTrack(half).public, cleanTrack(half).share_id], [false, null], JSON.stringify(half));
  assert.equal(cleanTrack({ ...shared, art_url: "/media/booth/2468-abc.mp3" }).art_url, null);
  for (const bad of [null, "x", {}, { ...good, code: "24" }, { ...good, file_name: "" }, { ...good, audio_url: "/media/tracks/brian.mp3" }, { ...good, audio_url: "https://evil.example/x.wav" }, { ...good, download_url: good.audio_url }, { ...good, download_url: `${good.audio_url}?dl=1&x=1` }, { ...good, audio_url: "/media/booth/../tracks/b.mp3" }, { ...good, you: undefined }, { ...good, people: undefined }]) {
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
  assert.deepEqual(rows[1], { code: "1111", file_name: "A.wav", uploaded_at: now - 3600_000, opened: 2, size: 2735168, public: false, art_url: null, people: 0, everyone_in: false });
  // The people on a row (4 Oct 2026): a whole count or 0; all in only when the server says so AND someone is attached.
  assert.deepEqual(todayRows([{ code: "9999", file_name: "P.wav", uploaded_at: at(0.1), opened: 0, size: 5, people: 3, everyone_in: true }, { code: "9998", file_name: "Q.wav", uploaded_at: at(0.2), opened: 0, size: 5, people: "2", everyone_in: "true" }, { code: "9997", file_name: "R.wav", uploaded_at: at(0.3), opened: 0, size: 5, people: 0, everyone_in: true }, { code: "9996", file_name: "S.wav", uploaded_at: at(0.4), opened: 0, size: 5, people: -2, everyone_in: false }], now).map((r) => [r.people, r.everyone_in]), [[3, true], [2, false], [0, false], [0, false]]);
  assert.equal(peopleWords(BOOTH_COPY, 0), "nobody yet");
  assert.equal(peopleWords(BOOTH_COPY, 1), "1 person");
  assert.equal(peopleWords(BOOTH_COPY, 3), "3 people");
  const [withArt] = todayRows([{ code: "7777", file_name: "G.wav", uploaded_at: at(0.2), opened: 0, size: 5, public: true, art_url: "/media/booth/art/0123456789abcdef-0123456789.jpg" }, { code: "8888", file_name: "H.wav", uploaded_at: at(0.3), opened: 0, size: 5, public: "yes", art_url: "https://evil.example/x.jpg" }], now);
  assert.deepEqual([withArt.public, withArt.art_url], [true, "/media/booth/art/0123456789abcdef-0123456789.jpg"]);
  assert.deepEqual(todayRows([{ code: "8888", file_name: "H.wav", uploaded_at: at(0.3), opened: 0, size: 5, public: "yes", art_url: "https://evil.example/x.jpg" }], now).map((r) => [r.public, r.art_url]), [[false, null]], "a log row is public only when the server says true; artwork only at its own address");
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
  assert.deepEqual(Object.keys(BOOTH_COPY), ["headline", "intro", "zone", "zoneHint", "uploading", "doneTitle", "next", "retry", "failed", "notAudio", "tooBig", "empty", "dailyLimit", "rateLimited", "logTitle", "logEmpty", "logFailed", "nobody", "onePerson", "people", "allIn"]);
  assert.deepEqual(Object.keys(TRACK_COPY), ["headline", "intro", "codeLabel", "emailLabel", "go", "looking", "found", "download", "another", "notFound", "tooMany", "needCode", "needEmail", "badEmail", "notAttached", "you", "audioNone", "audioFailed", "publicLabel", "publicOff", "publicOn", "publicFailed", "publicNote", "share", "shareMessage", "copied", "copyFailed", "addArt", "changeArt", "artWorking", "artUnreadable", "artFailed", "voteLabel", "voteWaiting", "voteAll", "voteOnlyYou", "voteFailed"]);
  assert.deepEqual(Object.keys(LISTEN_COPY), ["title", "loading", "line", "private", "instagram", "artAlt", "audioNone", "audioFailed"]);
  for (const copy of [BOOTH_COPY, TRACK_COPY, LISTEN_COPY]) for (const [k, v] of Object.entries(copy)) assert.ok(typeof v === "string" && v.trim(), `${k} is a sentence`);
  // The share's words, as the client asked for them (4 Oct 2026).
  assert.equal(TRACK_COPY.publicLabel, "Make public");
  assert.equal(TRACK_COPY.publicNote, "Recorded this with a group? Make sure you're all on the same page about sharing.", "the client's words, 4 Oct 2026");
  assert.equal(TRACK_COPY.share, "Share");
  assert.equal(TRACK_COPY.shareMessage, "I made a song at the Top Barz experience. Check it out:");
  assert.equal(TRACK_COPY.copied, "Link copied");
  assert.equal(TRACK_COPY.addArt, "Add artwork");
  assert.equal(TRACK_COPY.changeArt, "Change artwork");
  assert.equal(TRACK_COPY.artUnreadable, "That picture could not be read, try another");
  assert.equal(LISTEN_COPY.line, "Shared from the Top Barz experience");
  assert.equal(LISTEN_COPY.private, "Sorry, this song is private");
  assert.equal(LISTEN_COPY.instagram, "Top Barz on Instagram");
  assert.equal(TRACK_COPY.headline, "Hear your track");
  assert.equal(TRACK_COPY.notFound, "No track with that code yet. Ask your engineer.");
  assert.equal(TRACK_COPY.tooMany, "Too many tries. Give it a minute.");
  // The people's words (4 Oct 2026): the client's lines for the vote, the email box, and the engineer's counts.
  assert.equal(TRACK_COPY.emailLabel, "Your email");
  assert.equal(TRACK_COPY.needEmail, "Enter your email.");
  assert.equal(TRACK_COPY.voteLabel, "Count me in for the public vote");
  assert.equal(TRACK_COPY.voteWaiting, "Vote: waiting on {n} of {total}");
  assert.equal(TRACK_COPY.voteAll, "Everyone's in for the vote");
  assert.equal(TRACK_COPY.voteOnlyYou, "Only you so far: the others enter the code with their own email");
  assert.match(TRACK_COPY.you, /\{email\}/, "the one line that shows an email shows this device's own");
  assert.deepEqual([BOOTH_COPY.nobody, BOOTH_COPY.onePerson, BOOTH_COPY.people, BOOTH_COPY.allIn], ["nobody yet", "1 person", "{n} people", "all in"]);
  assert.equal(BOOTH_COPY.dailyLimit, "Upload limit reached for today, tell Sequoia");
  assert.match(BOOTH_COPY.uploading, /\{name\}/);
  for (const [page, ids] of [["booth.html", ["tbz-booth-headline", "tbz-booth-intro", "tbz-zone-text", "tbz-zone-hint", "tbz-done-title", "tbz-next", "tbz-retry", "tbz-log-title"]], ["track.html", ["tbz-track-headline", "tbz-track-intro", "tbz-code-label", "tbz-email-label", "tbz-go", "tbz-found-title", "tbz-you", "tbz-art-pick", "tbz-public-label", "tbz-public-note", "tbz-public-group", "tbz-vote-label", "tbz-vote-note", "tbz-download", "tbz-share", "tbz-another"]], ["listen.html", ["tbz-listen-wait", "tbz-listen-title", "tbz-listen-line", "tbz-listen-private-text", "tbz-listen-ig"]]]) {
    const html = src(`public/${page}`);
    for (const id of ids) assert.match(html, new RegExp(`id="${id}"[^>]*>\\s*<`), `${page} #${id} is empty in the markup`);
  }
  // Emails on the booth pages (since 4 Oct 2026): the rapper's page takes one and shows only its
  // own; the engineer's page and the listen page have none. Every mention is enumerated here, so a
  // new one has to be argued for; and the rapper's page keeps exactly one thing on the device, its
  // own email under tbz.booth.email, never the code.
  const EMAIL_MENTIONS = {
    "track.js": ["email", "cleanEmail", "emailLabel", "tbz-email", "tbz-email-label", "EMAIL_KEY", "rememberedEmail", "rememberEmail", "rawEmail", "badEmail", "needEmail", "bad_email", "x-email"],
    "track-copy.js": ["email", "emailLabel", "needEmail", "badEmail"],
    "booth-rules.js": ["email", "cleanEmail", "EMAIL_MAX"],
  };
  for (const file of ["booth.js", "track.js", "listen.js", "booth-rules.js", "booth-copy.js", "track-copy.js", "listen-copy.js"]) {
    const js = src(`public/js/${file}`);
    const found = [...new Set([...js.matchAll(/[\w$-]*email[\w$-]*/gi)].map((m) => m[0]))].sort();
    assert.deepEqual(found, (EMAIL_MENTIONS[file] ?? []).slice().sort(), `${file}: every mention of an email is one of the named ones (${found.join(", ")})`);
    const stored = [...js.matchAll(/localStorage\.(\w+)\(([^)]*)\)/g)].map((m) => `${m[1]}(${m[2]})`);
    assert.deepEqual(stored, file === "track.js" ? ["getItem(EMAIL_KEY)", "setItem(EMAIL_KEY, email)"] : [], `${file}: ${file === "track.js" ? "the device keeps the email and nothing else" : "nothing is kept on the device"}`);
    assert.ok(!/sessionStorage|document\.cookie|indexedDB/.test(js), `${file}: no cookie, no session store, no database`);
  }
  const track = src("public/js/track.js");
  assert.match(track, /const EMAIL_KEY = "tbz\.booth\.email";/);
  assert.ok(!/tbz\.booth\.code|setItem\([^)]*code/i.test(track), "the code is never kept");
  const shown = [...track.matchAll(/\.textContent = [^;]*email[^;]*;/gi)].map((m) => m[0]);
  assert.deepEqual(shown, [".textContent = COPY.emailLabel;", '.textContent = t ? COPY.you.replace("{email}", t.you.email) : "";'], "the box's label, and the only email ever written to the page: this device's own (you.email)");
  assert.ok(!/you\.email/.test(src("public/js/booth.js") + src("public/js/listen.js")));
  assert.ok(!/@/.test(src("public/js/booth-copy.js") + src("public/js/track-copy.js") + src("public/js/listen-copy.js")), "no address in the copy");
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
  assert.match(js, /\[formatTime\(r\.uploaded_at\), formatSize\(r\.size\), openedWords\(r\.opened\), peopleWords\(COPY, r\.people\), r\.everyone_in \? COPY\.allIn : "", r\.public \? "public" : ""\]/, "each row: code, file name, time, size, how often opened, how many people, all in, and whether it is public");
  assert.ok(!/email|you\./i.test(js + html), "the engineer's page never has an email: a count, never a name");
  assert.match(js, /r\.art_url \? h\("img", \{ class: "log-art", src: r\.art_url, width: 40, height: 40, alt: "", loading: "lazy" \}\) : null/, "a small thumbnail when there is artwork");
  assert.ok(!/x-booth-key|passphrase|BOOTH_KEY/i.test(js + html), "no passphrase: the page is open (the owner's call, 3 Oct 2026)");
  assert.ok(!/\.(innerHTML|outerHTML)/.test(js));
});

test("/track: Hear your track, a numeric code box that moves on to the email box on the fourth digit (or sends, with the email filled in), the vote's player, Download; ?code= fills the code on load; this person's own vote switch", () => {
  const html = src("public/track.html");
  const js = src("public/js/track.js");
  assert.ok(!/name="robots"/.test(html), "the rapper's page is open");
  assert.match(html, /<input id="tbz-code" type="text" inputmode="numeric" autocomplete="off" autocorrect="off" spellcheck="false" maxlength="4" pattern="\[0-9\]\*" enterkeyhint="next" aria-describedby="tbz-code-msg">/);
  assert.match(html, /<input id="tbz-email" type="email" inputmode="email" autocomplete="email" autocapitalize="off" autocorrect="off" spellcheck="false" maxlength="254" enterkeyhint="go" aria-describedby="tbz-code-msg">/, "the email box: the email keyboard, the phone's own address offered, Go on the keyboard");
  assert.ok(html.indexOf('id="tbz-code"') < html.indexOf('id="tbz-email"') && html.indexOf('id="tbz-email"') < html.indexOf('id="tbz-go"'), "code, email, then Go: the client's order");
  assert.match(html, /<button type="submit" id="tbz-go" class="btn"><\/button>/);
  assert.match(html, /<form id="tbz-code-form" class="code-form" novalidate>/);
  assert.match(html, /<div class="field field-code">/, "the same big code field the gate uses");
  assert.match(html, /<div class="field field-email">/, "and the same email field");
  assert.equal(PAGE_EMAIL_MAX, 254);
  assert.match(js, /if \(digits\.length === 4\) \{ if \(cleanEmail\(els\.email\.value\)\) enterFromForm\(\); else els\.email\.focus\(\); \}/, "the fourth digit sends it when the email is there, else moves to the email box");
  assert.match(js, /const enterFromForm = \(\) => enter\(codeDigits\(els\.code\.value\), els\.email\.value\);/);
  assert.match(js, /if \(!email\) \{ say\(String\(rawEmail \?\? ""\)\.trim\(\) \? COPY\.badEmail : COPY\.needEmail\); els\.email\.focus\(\); return; \}/, "a missing or malformed email is said so before anything is sent");
  assert.match(js, /api\(`\/api\/booth\/tracks\/\$\{code\}\/enter`, \{ method: "POST", body: \{ email \}, timeout: 10000 \}\)/, "the code and the email go in the body: never in the address");
  assert.ok(!/api\(`\/api\/booth\/tracks\/\$\{code\}`/.test(js), "the old lookup is not called");
  assert.match(js, /rememberEmail\(track\.you\.email\);/, "the email is remembered once the server took it");
  assert.match(js, /els\.email\.value = rememberedEmail\(\);/, "and fills the box on the next visit");
  assert.match(js, /if \(els\.email\.value\) enterFromForm\(\); else els\.email\.focus\(\);/, "?code= enters at once with a remembered email, else the email box takes the keyboard");
  assert.ok(!/history\.(push|replace)State|location\.(href|search|hash|assign|replace)[^;]*email/i.test(js), "nothing of the email ever reaches the address bar");
  // The group note (the client's addition, 4 Oct 2026): one line of text under the Make public switch, inside its block, there whenever the switch is.
  const block = html.slice(html.indexOf('id="tbz-public-label"'), html.indexOf('id="tbz-vote-label"'));
  assert.match(block, /<p id="tbz-public-note" class="switch-note" role="status"><\/p>\s*<p id="tbz-public-group" class="switch-note"><\/p>/, "the note sits under the switch's own line, never hidden");
  assert.match(js, /els\.publicGroup\.textContent = COPY\.publicNote;/, "drawn once from the copy, as text");
  assert.ok(!/publicGroup\.hidden|tbz-public-group"[^>]*hidden/.test(js + html), "visible whenever the switch is");
  // The vote switch (4 Oct 2026): this person's own, drawn at once and put back if the server says no; the line under it from the server's counts.
  assert.match(html, /<button type="button" id="tbz-vote" class="switch" role="switch" aria-checked="false" aria-labelledby="tbz-vote-label">/);
  assert.ok(html.indexOf('id="tbz-public"') < html.indexOf('id="tbz-vote"'), "under the Make public switch");
  assert.match(js, /track\.you\.vote_opt_in = next;\s*drawPeople\(\);\s*try \{\s*const \{ data \} = await api\(`\/api\/booth\/tracks\/\$\{track\.code\}\/vote`, \{ method: "POST", body: \{ email: track\.you\.email, opt_in: next \}/, "drawn before the server answers");
  assert.match(js, /catch \(err\) \{[\s\S]*track\.you\.vote_opt_in = was;\s*drawPeople\(\);\s*els\.voteNote\.textContent = refusal\(err, COPY\.voteFailed\);/, "and put back when the server says no");
  assert.match(js, /els\.voteNote\.textContent = t \? voteWords\(COPY, t\) : "";/);
  assert.match(js, /els\.voteBtn\.setAttribute\("aria-checked", t\?\.you\.vote_opt_in \? "true" : "false"\)/);
  assert.match(js, /const confirmed = cleanPeople\(data\);\s*if \(!confirmed \|\| confirmed\.you\.email !== track\.you\.email\) throw/, "an answer about someone else is not believed");
  assert.match(js, /err\?\.status === 403 \|\| err\?\.code === "not_attached" \? COPY\.notAttached/, "a 403 is said in words");
  assert.match(js, /body: \{ email: track\.you\.email, public: next \}/, "the share switch sends the email");
  assert.match(js, /"x-email": track\.you\.email/, "so does the artwork, in a header (the body is the picture)");
  assert.match(js, /import \{ createControls, createPlayer \} from "\.\/player\.js"/, "the vote's player, not a fork");
  assert.ok(!/new Audio\(/.test(js), "no audio element of its own");
  assert.match(js, /els\.download\.href = track\.download_url/);
  assert.match(html, /<a id="tbz-download" class="btn" download><\/a>/, "a real download link, no href until there is a track");
  assert.match(js, /COPY\.notFound/);
  assert.match(js, /err\?\.status === 429 \|\| err\?\.code === "rate_limited" \? COPY\.tooMany/);
  assert.match(js, /codeFromSearch\(location\.search\)/);
  assert.match(js, /els\.code\.value = fromAddress;/, "?code= fills the box");
  assert.match(html, /<h1 class="slogan">JUMP IN THE BOOTH<\/h1>/);
  assert.ok(!/x-booth-key|passphrase/i.test(js + html));
  // The share (4 Oct 2026): a real switch, off until the server says otherwise, drawn at once and
  // put back if the server says no; Share only while public; the share sheet, else a text, else
  // the clipboard; artwork cut to a square on the device and sent as a JPEG, never the raw file.
  assert.match(html, /<button type="button" id="tbz-public" class="switch" role="switch" aria-checked="false" aria-labelledby="tbz-public-label">/);
  assert.match(js, /els\.publicBtn\.setAttribute\("aria-checked", pub \? "true" : "false"\)/);
  assert.match(js, /els\.share\.hidden = !pub/, "Share is hidden while the track is private");
  assert.match(js, /track\.public = next;[\s\S]*drawShare\(\);[\s\S]*api\(`\/api\/booth\/tracks\/\$\{track\.code\}\/public`, \{ method: "POST", body: \{ email: track\.you\.email, public: next \}/, "the switch is drawn before the server answers");
  assert.match(js, /catch \(err\) \{[\s\S]*track\.public = was\.public;[\s\S]*track\.share_id = was\.share_id;[\s\S]*drawShare\(\);/, "and put back when the server says no");
  assert.match(js, /const track = cleanTrack\(data\)/, "the share state is read from the server on every lookup");
  assert.match(html, /<button type="button" id="tbz-share" class="btn" hidden><\/button>/);
  assert.match(js, /shareRoute\(navigator, app\.platform\)/);
  assert.match(js, /await navigator\.share\(\{ text: COPY\.shareMessage, url: link \}\)/, "the share sheet gets the words and the link apart");
  assert.match(js, /if \(err\?\.name === "AbortError"\) return;/, "a closed sheet is not a failure");
  assert.match(js, /const href = smsHref\(app\.platform, message\);\s*if \(href\) \{ try \{ location\.href = href; \} catch \{\} return; \}/, "a phone without the sheet opens its text composer");
  assert.match(js, /await navigator\.clipboard\.writeText\(link\);\s*els\.shareMsg\.textContent = COPY\.copied;/, "a desktop copies the link and says so");
  assert.match(js, /listenLink\(location\.origin, track\.share_id\)/, "the link is on the page's own origin");
  assert.match(js, /boothShareMessage\(COPY\.shareMessage, link\)/);
  assert.match(html, /<input type="file" id="tbz-art-file" class="sr-only" accept="image\/\*">/);
  assert.match(html, /<label id="tbz-art-pick" class="btn btn-small btn-ghost" for="tbz-art-file"><\/label>/, "a tap on the button opens the chooser");
  assert.match(html, /<img id="tbz-art" class="art" width="240" height="240" alt="" hidden>/);
  assert.match(js, /createImageBitmap\(file, \{ imageOrientation: "from-image" \}\)/, "decoded on the device, upright");
  assert.match(js, /squareCrop\(bitmap\.width, bitmap\.height\)/);
  assert.match(js, /canvas\.toBlob\(resolve, "image\/jpeg", 0\.85\)/, "a JPEG at quality 0.85");
  assert.match(js, /if \(blob\.size > 2 \* 1024 \* 1024\) throw/, "never more than 2 MB");
  assert.match(js, /\} catch \{\s*if \(app\.track === track\) \{ els\.artMsg\.textContent = COPY\.artUnreadable;[^}]*\}\s*return;\s*\}/, "a picture that cannot be read is said so, and nothing is sent");
  assert.match(js, /fetch\(`\/api\/booth\/tracks\/\$\{track\.code\}\/art`, \{ method: "POST", headers: \{ "content-type": "image\/jpeg", accept: "application\/json", "x-email": track\.you\.email \}, credentials: "same-origin", body: blob \}\)/, "the resized JPEG goes up raw");
  assert.match(js, /artwork: artworkFor\(app\.track\?\.art_url, location\.href\)/, "the lock screen gets the artwork");
  assert.ok(!/URL\.createObjectURL|readAsDataURL|blob:|data:/.test(js), "no blob: or data: address: the policy allows neither");
  assert.ok(!/\.(innerHTML|outerHTML)/.test(js));
  assert.ok(!/sessionStorage|document\.cookie/.test(js));
  const css = src("public/css/site.css");
  assert.match(css, /\n\.switch \{[^}]*width: 84px; height: var\(--tap\);/, "the switch is thumb-sized");
  assert.match(css, /\n\.switch\[aria-checked="true"\] \{ background: var\(--color-accent\); \}/);
  assert.match(css, /\n\.found-actions \{ display: flex; flex-wrap: wrap;/, "Download and Share sit together and wrap on a narrow phone");
});

test("/listen/<share id>: the artwork or the mark, the name as the title, the vote's player, one line, no download; private and unknown are one screen with the way to Top Barz", () => {
  const html = src("public/listen.html");
  const js = src("public/js/listen.js");
  assert.match(html, /<title>Listen \| Top Barz<\/title>/);
  assert.match(html, /<script type="module" src="\/js\/listen\.js"><\/script>/);
  assert.match(html, /<img id="tbz-listen-art" class="art art-big art-mark" width="320" height="320" src="\/img\/logo\.png" alt="">/, "the Top Barz mark until there is artwork");
  assert.match(html, /<h2 id="tbz-listen-title" class="listen-title" tabindex="-1"><\/h2>/);
  assert.match(html, /<a id="tbz-listen-ig" class="btn" href="https:\/\/www\.instagram\.com\/topbarz\.xyz" rel="noopener"><\/a>/);
  assert.match(html, /<h1 class="slogan">JUMP IN THE BOOTH<\/h1>/);
  assert.match(js, /import \{ createControls, createPlayer \} from "\.\/player\.js"/, "the vote's player, not a fork");
  assert.ok(!/new Audio\(/.test(js));
  assert.match(js, /shareIdFromPath\(location\.pathname\)/);
  assert.match(js, /api\(`\/api\/booth\/listen\/\$\{id\}`/);
  assert.match(js, /if \(err\?\.status === 404 \|\| err\?\.code === "private" \|\| err\?\.code === "not_found" \|\| !err\?\.status\) showPrivate\(\);/, "private and unknown are the same screen");
  assert.match(js, /els\.art\.src = song\.art_url; els\.art\.alt = COPY\.artAlt;/);
  assert.match(js, /artwork: artworkFor\(song\.art_url, location\.href\)/);
  assert.ok(!/download|dl=1|tbz-code|\/api\/booth\/tracks/.test(js + html), "no download, no ?dl=1, no code box, never the rapper's route");
  assert.ok(!/name="robots"/.test(html), "a shared song is open");
  assert.ok(!/\.(innerHTML|outerHTML)/.test(js));
  // The function that serves the page under /listen/<anything>: the static file, through the
  // assets binding, for any id; never a lookup, never markup of its own.
  const fn = src("functions/listen/[[path]].js");
  assert.match(fn, /env\.ASSETS\.fetch\(new Request\(new URL\("\/listen\.html", request\.url\)/);
  assert.ok(!/<html|<script|<body/.test(fn), "no markup in the function");
});

test("the listen function serves public/listen.html for any /listen/<id>, GET or HEAD, 200 html, from the assets binding", async () => {
  const page = src("public/listen.html");
  const calls = [];
  const assets = (status) => ({ fetch: async (req) => { calls.push(new URL(req.url).pathname); return status === 200 ? new Response(page, { status, headers: { "content-type": "text/html", "content-security-policy": "default-src 'self'" } }) : new Response(null, { status, headers: { location: "/listen" } }); } });
  for (const p of ["/listen/0123456789abcdef", "/listen/anything", "/listen/", "/listen/a/b"]) {
    const res = await call(listenPage.onRequest, { ASSETS: assets(200) }, { path: p });
    assert.equal(res.status, 200, p);
    assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(res.headers.get("content-security-policy"), "default-src 'self'", "the static file's headers come with it");
    assert.equal(res.text, page, "the shipped file, byte for byte");
  }
  assert.ok(calls.every((p) => p === "/listen.html"));
  // The asset server's clean-URL redirect (/listen.html → /listen) is followed, never passed on.
  let n = 0;
  const redirecting = { fetch: async (req) => { n++; return new URL(req.url).pathname === "/listen.html" ? new Response(null, { status: 308, headers: { location: "/listen" } }) : new Response(page, { status: 200, headers: { "content-type": "text/html" } }); } };
  const followed = await call(listenPage.onRequest, { ASSETS: redirecting }, { path: "/listen/0123456789abcdef" });
  assert.deepEqual([followed.status, followed.text === page, n], [200, true, 2]);
  const head = await call(listenPage.onRequest, { ASSETS: assets(200) }, { method: "HEAD", path: "/listen/0123456789abcdef" });
  assert.deepEqual([head.status, head.text], [200, ""]);
  assert.equal((await call(listenPage.onRequest, { ASSETS: assets(200) }, { method: "POST", path: "/listen/x" })).status, 405);
  assert.equal((await call(listenPage.onRequest, { ASSETS: assets(404) }, { path: "/listen/x" })).status, 404, "no page, no answer");
});

// ── The share (4 Oct 2026) ──────────────────────────────────────────────────────────────────
test("a share id is 16 hex characters from the platform's random source: never the code, never made from it, never guessable", () => {
  for (let i = 0; i < 200; i++) assert.match(shareId(), /^[0-9a-f]{16}$/);
  assert.equal(shareId((n) => new Uint8Array(n).fill(0xcd)), "cdcdcdcdcdcdcdcd");
  assert.equal(new Set(Array.from({ length: 200 }, () => shareId())).size, 200, "two hundred ids are two hundred different ids");
  assert.match(shareId.toString(), /^function shareId\(random = /, "the id takes the random source and nothing else: no code can go in");
  assert.ok(!/code/.test(shareId.toString()), "the code is not in the id's making");
  for (const good of ["0123456789abcdef", "ffffffffffffffff"]) assert.equal(isShareId(good), true, good);
  for (const bad of ["2468", "0123456789ABCDEF", "0123456789abcde", "0123456789abcdef0", " 0123456789abcdef", "0123456789abcdeg", "", null, 1234567890123456]) assert.equal(isShareId(bad), false, String(bad));
  assert.equal(listenLink("https://voting.topbarz.xyz", "0123456789abcdef"), "https://voting.topbarz.xyz/listen/0123456789abcdef");
  assert.equal(listenLink("http://localhost:8788/", "0123456789abcdef"), "http://localhost:8788/listen/0123456789abcdef");
  assert.equal(shareIdFromPath("/listen/0123456789abcdef"), "0123456789abcdef");
  assert.equal(shareIdFromPath("/listen/0123456789abcdef/"), "0123456789abcdef");
  for (const bad of ["/listen", "/listen/", "/listen/2468", "/listen/0123456789ABCDEF", "/track/0123456789abcdef", "/listen/0123456789abcdef/x", "", null]) assert.equal(shareIdFromPath(bad), null, String(bad));
});

test("POST /api/booth/tracks/<code>/public: off for every track, flips on and off for anyone attached (share is anyone's call) and for nobody else (403 not_attached), hands the link out only while on; 30 a minute per connection; a wrong code is a lookup try", async () => {
  const up = await upload(env, { name: "Test - Share me.mp3", type: "audio/mpeg", bytes: wav(500) });
  const { code } = up.body;
  // Nobody attached yet: the switch answers 403 to every email, and to none.
  const stranger = await setPublic(env, code, { public: true });
  assert.deepEqual([stranger.status, stranger.body], [403, { error: "not_attached", message: "Enter the code with your email first." }]);
  for (const body of [{ public: true, email: null }, { public: true, email: "" }, { public: true, email: "nope" }, { public: true, email: 7 }]) assert.equal((await setPublic(env, code, body)).status, 403, JSON.stringify(body));
  assert.equal((await env.DB.prepare("SELECT public FROM booth_tracks WHERE code = ?1").bind(code).first()).public, 0, "nothing flipped");
  await enter(env, code, ME);
  await enter(env, code, OTHER);
  assert.equal((await setPublic(env, code, { public: true, email: "third@example.com" })).status, 403, "an email that never entered the code is not attached, however many are");
  assert.equal((await setPublic(env, code, { public: true, email: ` ${OTHER.toUpperCase()} ` })).status, 200, "an attached email, however it is typed, may flip it");
  assert.equal((await setPublic(env, code, { public: false, email: ME })).status, 200, "and any other attached person may flip it back: share is anyone's call");
  const before = await env.DB.prepare("SELECT public, share_id FROM booth_tracks WHERE code = ?1").bind(code).first();
  assert.equal(before.public, 0, "off by default");
  assert.match(before.share_id, /^[0-9a-f]{16}$/, "the id is drawn at upload");
  assert.notEqual(before.share_id, code);
  assert.ok(!before.share_id.includes(code), "and is not made from the code");
  const on = await setPublic(env, code, { public: true });
  assert.equal(on.status, 200, on.text);
  assert.deepEqual(on.body, { code, public: true, share_id: before.share_id });
  assert.equal(on.headers.get("cache-control"), "no-store");
  const seen = await lookup(env, code);
  assert.deepEqual([seen.body.public, seen.body.share_id], [true, before.share_id], "the lookup says so");
  const off = await setPublic(env, code, { public: false });
  assert.deepEqual(off.body, { code, public: false, share_id: null }, "off again: no link is handed out");
  assert.deepEqual([(await lookup(env, code)).body.public, (await lookup(env, code)).body.share_id], [false, null]);
  assert.equal((await env.DB.prepare("SELECT share_id FROM booth_tracks WHERE code = ?1").bind(code).first()).share_id, before.share_id, "the id itself is kept: the link works again when it is switched back on");
  // A track from before the share existed (no id yet) gets one on its first publish.
  await env.DB.prepare("UPDATE booth_tracks SET share_id = NULL WHERE code = ?1").bind(code).run();
  const first = await setPublic(env, code, { public: true });
  assert.match(first.body.share_id, /^[0-9a-f]{16}$/);
  assert.notEqual(first.body.share_id, before.share_id);
  assert.equal((await setPublic(env, code, { public: true })).body.share_id, first.body.share_id, "and keeps it");
  for (const bad of [{}, { public: "yes" }, { public: 1 }, { public: null }]) assert.deepEqual([(await setPublic(env, code, bad)).status, (await setPublic(env, code, bad)).body.error], [400, "bad_public"], JSON.stringify(bad));
  assert.equal((await call(booth.onRequest, env, { method: "POST", path: `/api/booth/tracks/${code}/public`, params: { path: ["tracks", code, "public"] }, body: "nope" })).status, 400);
  assert.equal((await setPublic(env, code, { public: true, email: undefined })).status, 403, "a well-formed body with no email is not attached (400 is for the switch's own value)");
  assert.equal((await call(booth.onRequest, env, { path: `/api/booth/tracks/${code}/public`, params: { path: ["tracks", code, "public"] } })).status, 404, "GET is not a route");
  assert.equal((await call(booth.onRequest, env, { method: "POST", path: `/api/booth/tracks/${code}/other`, params: { path: ["tracks", code, "other"] } })).status, 404);
  // A wrong code: 404, and counted against the lookup limits (5 a minute), so this is no second
  // way to find a code.
  const wrongCode = code === "0000" ? "0001" : "0000";
  const ip = freshIp();
  const tries = [];
  for (let i = 0; i < 7; i++) tries.push((await setPublic(env, wrongCode, { public: true }, ip)).status);
  assert.deepEqual(tries, [404, 404, 404, 404, 404, 429, 429], "the 6th wrong code in a minute is a 429, as on the lookup");
  assert.equal((await setPublic(env, "abcd", { public: true })).status, 404);
  assert.equal((await lookup(env, code, ip)).status, 429, "the same counter as the lookup");
  // 30 changes a minute from one connection.
  const editor = freshIp();
  const n = await acceptedBeforeLimit(() => setPublic(env, code, { public: true }, editor), LIMITS.boothEditsPerMinute.max);
  assert.ok(n >= LIMITS.boothEditsPerMinute.max && n <= 2 * LIMITS.boothEditsPerMinute.max + 1, `${n} accepted`);
  assert.deepEqual(LIMITS.boothEditsPerMinute, { window: 60, max: 30 });
  assert.equal(PUBLIC_SQL, "UPDATE booth_tracks SET public = ?2, share_id = COALESCE(share_id, ?3) WHERE code = ?1 RETURNING public, share_id");
  assert.ok(!/email/.test(src("functions/api/booth/[[path]].js").match(/async function setPublic[\s\S]*?\n\}/)[0].replace("await access(context, ip, now, code, body.email);", "")), "the switch reads the email for one thing only: whether this person is attached");
});

// ── The vote rule (4 Oct 2026) ───────────────────────────────────────────────────────────────
test("POST /api/booth/tracks/<code>/vote: each attached person's own opt-in, on and off; 403 for anyone else; everyone_in only when every person attached is in, never while nobody is; the counts come back, never an email", async () => {
  const up = await upload(env, { name: "Test - Group.mp3", type: "audio/mpeg", bytes: wav(400) });
  const { code } = up.body;
  const people = async () => (await env.DB.prepare("SELECT p.email, p.vote_opt_in, p.opted_at FROM booth_people p JOIN booth_tracks t ON t.id = p.track_id WHERE t.code = ?1 ORDER BY p.id").bind(code).all()).results;
  // Nobody attached: 403, and nothing to count.
  const nobody = await vote(env, code, { opt_in: true });
  assert.deepEqual([nobody.status, nobody.body.error], [403, "not_attached"]);
  const one = await enter(env, code, ME);
  assert.deepEqual([one.body.people, one.body.opted, one.body.everyone_in], [1, 0, false]);
  const two = await enter(env, code, OTHER);
  const three = await enter(env, code, "third@example.com");
  assert.deepEqual([three.body.people, three.body.opted, three.body.everyone_in], [3, 0, false]);
  assert.ok(!two.text.includes(ME) && !three.text.includes(OTHER), "nobody is told another person's email");
  // One in: their own state flips, the counts say 1 of 3, everyone_in stays false.
  const mine = await vote(env, code, { email: ME, opt_in: true });
  assert.equal(mine.status, 200, mine.text);
  assert.deepEqual(mine.body, { code, you: { email: ME, vote_opt_in: true }, people: 3, opted: 1, everyone_in: false });
  assert.deepEqual(Object.keys(mine.body), ["code", "you", "people", "opted", "everyone_in"]);
  assert.equal(mine.headers.get("cache-control"), "no-store");
  let rows = await people();
  assert.deepEqual(rows.map((r) => [r.email, r.vote_opt_in]), [[ME, 1], [OTHER, 0], ["third@example.com", 0]], "only this person's row moved");
  assert.ok(Date.now() - rows[0].opted_at < 10_000 && rows[1].opted_at === null);
  assert.equal((await enter(env, code, OTHER)).body.you.vote_opt_in, false, "another person entering sees their own state, not mine");
  assert.deepEqual((await enter(env, code, ME)).body.you, { email: ME, vote_opt_in: true }, "and I see mine, on every entry");
  // Everyone in: only when the last of them says so.
  assert.equal((await vote(env, code, { email: OTHER, opt_in: true })).body.everyone_in, false, "2 of 3");
  const all = await vote(env, code, { email: "Third@Example.com", opt_in: true });
  assert.deepEqual([all.body.people, all.body.opted, all.body.everyone_in, all.body.you.email], [3, 3, true, "third@example.com"]);
  assert.equal((await enter(env, code, ME)).body.everyone_in, true, "the entry says so too");
  assert.deepEqual((await log(env)).body.tracks.find((t) => t.code === code), { ...(await log(env)).body.tracks.find((t) => t.code === code), people: 3, everyone_in: true }, "and the log");
  // Out again: one person's say takes everyone_in away; their opted_at is cleared; nobody else moves.
  const out = await vote(env, code, { email: OTHER, opt_in: false });
  assert.deepEqual([out.body.you, out.body.opted, out.body.everyone_in], [{ email: OTHER, vote_opt_in: false }, 2, false]);
  rows = await people();
  assert.deepEqual(rows.map((r) => [r.vote_opt_in, r.opted_at === null]), [[1, false], [0, true], [1, false]]);
  // A fourth person entering later is out until they say otherwise: everyone_in falls again.
  await vote(env, code, { email: OTHER, opt_in: true });
  assert.equal((await enter(env, code, ME)).body.everyone_in, true);
  const fourth = await enter(env, code, "fourth@example.com");
  assert.deepEqual([fourth.body.people, fourth.body.opted, fourth.body.everyone_in], [4, 3, false], "a new person is a new consent to collect");
  // Refusals: a stranger, no email, a bad value, a wrong code (a lookup try), GET.
  assert.equal((await vote(env, code, { email: "stranger@example.com", opt_in: true })).status, 403);
  assert.equal((await vote(env, code, { email: "", opt_in: true })).status, 403);
  for (const bad of [{}, { opt_in: "yes" }, { opt_in: 1 }, { opt_in: null }]) assert.deepEqual([(await vote(env, code, bad)).status, (await vote(env, code, bad)).body.error], [400, "bad_opt_in"], JSON.stringify(bad));
  assert.equal((await call(booth.onRequest, env, { path: `/api/booth/tracks/${code}/vote`, params: { path: ["tracks", code, "vote"] } })).status, 404, "GET is not a route");
  const wrongCode = code === "0000" ? "0001" : "0000";
  const ip = freshIp();
  const tries = [];
  for (let i = 0; i < 7; i++) tries.push((await vote(env, wrongCode, { opt_in: true }, ip)).status);
  assert.deepEqual(tries, [404, 404, 404, 404, 404, 429, 429], "a wrong code on the vote is a lookup try: the 6th in a minute is a 429");
  assert.equal((await enter(env, code, ME, ip)).status, 429, "the same counter as the entry");
  const editor = freshIp();
  const n = await acceptedBeforeLimit(() => vote(env, code, { email: ME, opt_in: true }, editor), LIMITS.boothEditsPerMinute.max);
  assert.ok(n >= LIMITS.boothEditsPerMinute.max && n <= 2 * LIMITS.boothEditsPerMinute.max + 1, `${n} accepted: the same 30 changes a minute as the switch`);
  const answer = (await vote(env, code, { email: ME, opt_in: true })).text;
  assert.deepEqual(rows.map((r) => r.email).filter((e) => answer.includes(e)), [ME], "the answer names no one but the asker");
});

test("the people's rules, pure: an email as it is kept (the page and the server agree, word for word); everyone in is at least one person and all of them; the promotion's verdict on every refusal and the one allow", () => {
  const good = { " A@B.CO ": "a@b.co", "jane@x.co\n": "jane@x.co", "jane.doe+tag@mail.example.co": "jane.doe+tag@mail.example.co", "j@x.io": "j@x.io", "a@b.c.d": "a@b.c.d", [`${"x".repeat(240)}@b.co`]: `${"x".repeat(240)}@b.co` };
  const bad = ["", " ", null, undefined, 5, {}, "jane", "jane@", "@x.co", "jane@x", "jane@x.", "jane@.x", "jane@x..co", "ja ne@x.co", "jane@@x.co", "jane@x.\nco", `${"x".repeat(250)}@b.co`, "a@b.co c@d.co"];
  for (const [raw, kept] of Object.entries(good)) assert.equal(cleanEmail(raw), kept, raw);
  for (const raw of bad) assert.equal(cleanEmail(raw), "", String(raw));
  for (const raw of [...Object.keys(good), ...bad]) assert.equal(pageCleanEmail(raw), cleanEmail(raw), `the page agrees with the server on ${String(raw)}`);
  assert.equal(EMAIL_MAX, 254);
  const body = (text) => text.match(/export function cleanEmail\(raw\) \{([\s\S]*?)\n\}/)[1];
  assert.equal(body(src("public/js/booth-rules.js")), body(src("functions/_lib/booth.js")), "one rule, the same characters in both files");
  // Everyone in: nobody is not everyone; one person in is everyone; one out is not.
  assert.equal(everyoneIn([]), false);
  assert.equal(everyoneIn([{ vote_opt_in: 1 }]), true);
  assert.equal(everyoneIn([{ vote_opt_in: 1 }, { vote_opt_in: 0 }]), false);
  assert.equal(everyoneIn([{ vote_opt_in: 1 }, { vote_opt_in: 1 }, { vote_opt_in: 1 }]), true);
  assert.equal(everyoneIn([{ vote_opt_in: "1" }]), false, "a 1 is a number, not a word");
  assert.deepEqual([allIn(0, 0), allIn(2, 2), allIn(3, 2), allIn("2", "2"), allIn(null, null)], [false, true, false, true, false]);
  assert.deepEqual(countPeople([{ vote_opt_in: 1 }, { vote_opt_in: 0 }]), { people: 2, opted: 1, everyone_in: false });
  // The verdict, in its order: the code, Scooter Taylor's file, a test file for production, nobody, not everyone, then the one allow.
  const track = { code: "2468", file_name: "Jane Doe.wav" };
  const inRows = [{ vote_opt_in: 1 }, { vote_opt_in: 1 }];
  assert.deepEqual(promoteVerdict({ track: null, people: inRows, env: "production" }), { ok: false, reason: "no_such_code", message: "no booth track has that code" });
  assert.equal(promoteVerdict({ track: {}, people: inRows, env: "production" }).reason, "no_such_code");
  assert.equal(promoteVerdict({}).reason, "no_such_code");
  for (const name of ["Scooter Taylor.wav", "Taylor, Scooter.mp3", "scootertaylor.m4a", "@scootertaylor.flac", "Scooter.wav", "Test - Scooter Taylor.wav"]) {
    const v = promoteVerdict({ track: { code: "2468", file_name: name }, people: inRows, env: "preview" });
    assert.deepEqual([v.ok, v.reason], [false, "scooter_taylor"], name);
    assert.ok(isScooterTaylor(name.replace(/\.[^.]+$/, "")), `the same rule as the loaders: ${name}`);
  }
  assert.equal(promoteVerdict({ track: { code: "2468", file_name: "Scooter Braun.wav" }, people: inRows, env: "preview" }).ok, true, "a Scooter who is not Taylor is allowed");
  assert.deepEqual([promoteVerdict({ track: { code: "2468", file_name: "Test - Brian.mp3" }, people: inRows, env: "production" }).reason, isTestName("Test - Brian.mp3")], ["test_file_in_production", true]);
  assert.equal(promoteVerdict({ track: { code: "2468", file_name: "Test - Brian.mp3" }, people: inRows, env: "preview" }).ok, true, "a test file is fine for preview");
  assert.equal(promoteVerdict({ track: { code: "2468", file_name: "Testimony Jones.mp3" }, people: inRows, env: "production" }).ok, true, "Testimony is not a test");
  assert.deepEqual(promoteVerdict({ track, people: [], env: "production" }), { ok: false, reason: "nobody_attached", message: "nobody has entered code 2468 with their email yet, so nobody can have opted in" });
  assert.equal(promoteVerdict({ track, env: "production" }).reason, "nobody_attached", "no people at all is nobody");
  assert.deepEqual(promoteVerdict({ track, people: [{ vote_opt_in: 1 }, { vote_opt_in: 0 }, { vote_opt_in: 0 }], env: "production" }), { ok: false, reason: "not_everyone_in", message: "2 of the 3 people attached to code 2468 have not opted in to the public vote; the vote is everyone's consent" });
  assert.match(promoteVerdict({ track, people: [{ vote_opt_in: 1 }, { vote_opt_in: 0 }], env: "production" }).message, /^1 of the 2 people attached to code 2468 has not opted in/);
  assert.equal(promoteVerdict({ track, people: [{ vote_opt_in: 0 }], env: "production" }).reason, "not_everyone_in", "one person, out");
  assert.deepEqual(promoteVerdict({ track, people: [{ vote_opt_in: 1 }], env: "production" }), { ok: true, reason: "everyone_in", message: "all 1 person attached to code 2468 opted in" }, "one person, in: a solo artist is everyone");
  assert.deepEqual(promoteVerdict({ track, people: inRows, env: "production" }), { ok: true, reason: "everyone_in", message: "all 2 people attached to code 2468 opted in" });
  assert.equal(promoteVerdict({ track, people: inRows, env: "preview" }).ok, true);
  // The order: a refused file is refused before the people are counted; a wrong code before the file.
  assert.equal(promoteVerdict({ track: { code: "2468", file_name: "Scooter Taylor.wav" }, people: [], env: "production" }).reason, "scooter_taylor");
  assert.equal(promoteVerdict({ track: { code: "24", file_name: "Scooter Taylor.wav" }, people: [], env: "production" }).reason, "no_such_code");
  assert.ok(!/email/.test(src("functions/_lib/booth.js").match(/export function promoteVerdict[\s\S]*?\n\}/)[0].replace("with their email yet", "")), "the verdict reads opt-ins, never emails");
});

test("npm run promote-booth is the only door onto the voting site: it asks promoteVerdict and exits non-zero on a refusal, never writes a booth row, copies the audio under tracks/ and upserts the vote track; --dry-run writes nothing", () => {
  assert.equal(JSON.parse(src("package.json")).scripts["promote-booth"], "node scripts/promote-booth.mjs");
  const script = src("scripts/promote-booth.mjs");
  assert.match(script, /import \{ promoteVerdict \} from "\.\.\/functions\/_lib\/booth\.js";/);
  assert.match(script, /const verdict = promoteVerdict\(\{ track, people, env: args\.env \}\);/);
  assert.match(script, /if \(!verdict\.ok\) \{ console\.error\(`REFUSED: \$\{verdict\.message\}`\); process\.exit\(1\); \}/, "a refusal is named and exits 1");
  assert.ok(script.indexOf("const verdict = promoteVerdict(") < script.indexOf("r2Get(") && script.indexOf("process.exit(1); }") < script.indexOf("r2Get("), "the verdict comes before any copy");
  assert.match(script, /SELECT vote_opt_in FROM booth_people WHERE track_id = /, "only the opt-ins are read: no email leaves the table here");
  assert.ok(!/email/.test(script.replace(/\/\/.*$/gm, "")), "the script's code never names an email");
  assert.match(script, /const key = `tracks\/\$\{planned\.slug\}-\$\{createHash\("sha256"\)\.update\(bytes\)\.digest\("hex"\)\.slice\(0, 10\)\}\.\$\{ext\}`;/, "the vote's key shape, from the bytes");
  assert.match(script, /await run\("ffprobe", \["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file\]\)/, "the duration the way load-tracks.mjs reads it");
  assert.match(src("scripts/load-tracks.mjs"), /await run\("ffprobe", \["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out\]\)/);
  assert.match(script, /else await r2Put\(target, key, file, contentType\);/);
  assert.match(script, /INSERT INTO tracks \(slug, label, source_name, audio_key, duration_ms, sort, active, created_at, updated_at\)/);
  assert.match(script, /ON CONFLICT \(source_name\) DO UPDATE SET label = excluded\.label, audio_key = excluded\.audio_key, duration_ms = COALESCE\(excluded\.duration_ms, duration_ms\), active = 1, updated_at = excluded\.updated_at;/);
  assert.match(script, /if \(args\["dry-run"\]\) \{\n  console\.log\([^\n]*nothing written`\);\n  process\.exit\(0\);\n\}/, "a dry run says what it would do and stops");
  assert.ok(script.indexOf('if (args["dry-run"])') < script.indexOf("r2Get("), "and before the copy");
  assert.match(script, /The deep link: \$\{link\}/, "the slug's link is printed");
  assert.match(script, /assignSlugs\(\[\{ sourceName: fileName, label, slugBase: slugify\(label\) \|\| "track", last: "" \}\], existing\)/, "a slug a track already has never changes");
  assert.match(script, /const label = \(args\.label \?\? prior\?\.label \?\? baseName\)\.trim\(\) \|\| baseName;/, "--label, else the label it has, else the file's name without its extension");
  assert.ok(!/wrangler (pages )?deploy|booth_tracks SET|DELETE FROM booth/.test(script));
  // Run it: no --env and no --code each stop with the word, non-zero, before anything is read.
  const run = (...args) => spawnSync(process.execPath, [path.join(ROOT, "scripts/promote-booth.mjs"), ...args], { encoding: "utf8" });
  const noEnv = run();
  assert.deepEqual([noEnv.status, /--env preview \| production/.test(noEnv.stderr)], [2, true]);
  const noCode = run("--env", "preview");
  assert.deepEqual([noCode.status, /--code/.test(noCode.stderr)], [2, true]);
  assert.deepEqual([run("--env", "preview", "--code", "24").status, run("--env", "preview", "--code", "abcd").status], [2, 2], "a code is four digits");
  assert.equal(run("--env", "nowhere", "--code", "2468").status, 1, "an unknown environment stops");
  // The loaders' two name rules and the verdict's are one function each (functions/_lib/exclusions.js).
  assert.match(src("scripts/lib/names.mjs"), /import \{ isScooterTaylor, isTestName \} from "\.\.\/\.\.\/functions\/_lib\/exclusions\.js";/);
  assert.match(src("functions/_lib/booth.js"), /import \{ isScooterTaylor, isTestName \} from "\.\/exclusions\.js";/);
  assert.ok(!/scooter/i.test(src("scripts/lib/names.mjs").replace(/\/\/.*$/gm, "")) || /export \{ isScooterTaylor, isTestName \};/.test(src("scripts/lib/names.mjs")), "names.mjs re-exports the rule and does not keep a second one");
  assert.equal((src("scripts/lib/names.mjs").match(/function isScooterTaylor/g) ?? []).length, 0, "one definition, in exclusions.js");
});

test("GET /api/booth/listen/<share id>: a public track's name, audio and artwork; private and unknown are the same 404; never counts an open; 30 a minute per connection", async () => {
  const up = await upload(env, { name: "Test - Listen.mp3", type: "audio/mpeg", bytes: wav(700) });
  const { code } = up.body;
  const id = (await env.DB.prepare("SELECT share_id FROM booth_tracks WHERE code = ?1").bind(code).first()).share_id;
  const priv = await listen(env, id);
  assert.deepEqual([priv.status, priv.body], [404, { error: "private", message: "Sorry, this song is private." }]);
  const unknown = await listen(env, id.replace(/./g, (c) => (c === "0" ? "1" : "0")));
  assert.deepEqual([unknown.status, unknown.body], [404, { error: "not_found", message: "Sorry, this song is private." }], "the same status, the same words: only the code differs, for the page");
  assert.deepEqual(Object.keys(priv.body), Object.keys(unknown.body), "the same shape");
  for (const bad of [code, "x", "0123456789ABCDEF", "..", `${id}%0A`, ""]) assert.equal((await listen(env, bad)).status, 404, bad);
  const mine = await enter(env, code, ME);
  await setPublic(env, code, { public: true });
  const open = await listen(env, id);
  assert.equal(open.status, 200, open.text);
  assert.deepEqual(open.body, { file_name: "Test - Listen.mp3", audio_url: mine.body.audio_url, art_url: null });
  assert.equal(open.headers.get("cache-control"), "no-store");
  assert.ok(!/code|download|dl=1|share_id|media_key|opened|email|people|@/.test(open.text), "no code, no download, no key, no count, nothing of the people: the listen page has no email");
  const art = await putArt(env, code, { bytes: jpeg() });
  assert.equal((await listen(env, id)).body.art_url, art.body.art_url);
  const opened = async () => (await env.DB.prepare("SELECT opened FROM booth_tracks WHERE code = ?1").bind(code).first()).opened;
  const was = await opened();
  await listen(env, id); await listen(env, id);
  assert.equal(await opened(), was, "a listen is never an open");
  await setPublic(env, code, { public: false });
  assert.deepEqual([(await listen(env, id)).status, (await listen(env, id)).body.error], [404, "private"], "switched off: private again at once");
  const reader = freshIp();
  const n = await acceptedBeforeLimit(() => listen(env, id, reader), LIMITS.boothListenPerMinute.max);
  assert.ok(n >= LIMITS.boothListenPerMinute.max && n <= 2 * LIMITS.boothListenPerMinute.max + 1, `${n} accepted`);
  assert.deepEqual(LIMITS.boothListenPerMinute, { window: 60, max: 30 });
  assert.equal(LISTEN_SQL, "SELECT file_name, media_key, art_key, public FROM booth_tracks WHERE share_id = ?1");
  assert.ok(!/opened/.test(LISTEN_SQL));
  // The page's side of it.
  const good = { file_name: " Take 3.wav ", audio_url: "/media/booth/2468-0123456789abcdef.wav", art_url: "/media/booth/art/0123456789abcdef-0123456789.jpg" };
  assert.deepEqual(cleanListen(good), { file_name: "Take 3.wav", audio_url: good.audio_url, art_url: good.art_url });
  assert.equal(cleanListen({ ...good, art_url: null }).art_url, null);
  assert.equal(cleanListen({ ...good, art_url: "https://evil.example/x.jpg" }).art_url, null);
  for (const bad of [null, "x", {}, { ...good, file_name: "" }, { ...good, audio_url: "/media/tracks/brian.mp3" }, { ...good, audio_url: `${good.audio_url}?dl=1` }]) assert.equal(cleanListen(bad), null, JSON.stringify(bad));
});

test("POST /api/booth/tracks/<code>/art: a JPEG or PNG by type AND first bytes, at most 2 MB, under booth/art/<random>-<hash>, from an attached email (x-email) only; a new picture replaces the key; served by /media like everything else", async () => {
  const up = await upload(env, { name: "Test - Art.mp3", type: "audio/mpeg", bytes: wav(300) });
  const { code } = up.body;
  const bytes = jpeg(900);
  const unattached = await putArt(env, code, { bytes });
  assert.deepEqual([unattached.status, unattached.body.error], [403, "not_attached"], "nobody has entered the code yet");
  await enter(env, code, ME);
  assert.deepEqual([(await putArt(env, code, { bytes, email: null })).status, (await putArt(env, code, { bytes, email: OTHER })).status, (await putArt(env, code, { bytes, email: "" })).status], [403, 403, 403], "no x-email, a stranger's, an empty one: 403, nothing written");
  assert.equal((await env.DB.prepare("SELECT art_key FROM booth_tracks WHERE code = ?1").bind(code).first()).art_key, null);
  const art = await putArt(env, code, { bytes, email: ` ${ME.toUpperCase()} ` });
  assert.equal(art.status, 200, art.text);
  assert.deepEqual(Object.keys(art.body), ["code", "art_url"]);
  assert.match(art.body.art_url, /^\/media\/booth\/art\/[0-9a-f]{16}-[0-9a-f]{10}\.jpg$/);
  assert.ok(!art.body.art_url.includes(code), "the key carries neither the code…");
  const row = await env.DB.prepare("SELECT art_key, share_id FROM booth_tracks WHERE code = ?1").bind(code).first();
  assert.ok(!art.body.art_url.includes(row.share_id), "…nor the share id");
  assert.equal(`/media/${row.art_key}`, art.body.art_url);
  const obj = await env.MEDIA.get(row.art_key);
  assert.equal(obj.size, 900);
  assert.equal(obj.httpMetadata.contentType, "image/jpeg");
  assert.equal((await lookup(env, code)).body.art_url, art.body.art_url, "the lookup shows it");
  const served = await getMedia(env, art.body.art_url);
  assert.deepEqual([served.status, served.headers.get("content-type"), served.headers.get("cache-control"), served.headers.get("content-disposition")], [200, "image/jpeg", "public, max-age=31536000, immutable", null]);
  assert.deepEqual([...served.bytes.subarray(0, 4)], [0xff, 0xd8, 0xff, 0xe0]);
  assert.equal((await getMedia(env, `${art.body.art_url}?dl=1`)).headers.get("content-disposition"), null, "artwork is never a download");
  // A new picture: a new key, the old one forgotten by the row (the object stays: unguessable, harmless).
  const again = await putArt(env, code, { bytes: jpeg(901, 0x33) });
  assert.notEqual(again.body.art_url, art.body.art_url);
  assert.equal((await env.DB.prepare("SELECT art_key FROM booth_tracks WHERE code = ?1").bind(code).first()).art_key, again.body.art_url.replace("/media/", ""));
  assert.ok(await env.MEDIA.head(row.art_key), "the old object is left where it is");
  const asPng = await putArt(env, code, { bytes: png(), type: "image/png" });
  assert.match(asPng.body.art_url, /\.png$/);
  assert.equal((await getMedia(env, asPng.body.art_url)).headers.get("content-type"), "image/png");
  // Refused, and nothing written: the wrong type, a type that lies about its bytes, no size, empty, over 2 MB, a wrong code.
  const keyBefore = (await env.DB.prepare("SELECT art_key FROM booth_tracks WHERE code = ?1").bind(code).first()).art_key;
  const objects = async () => (await env.MEDIA.list({ prefix: "booth/art/" })).objects.length;
  const count = await objects();
  const big = jpeg(ART_MAX_BYTES + 1);
  for (const [why, args, status, error] of [
    ["a GIF", { bytes: jpeg(), type: "image/gif" }, 415, "not_image"],
    ["audio", { bytes: jpeg(), type: "audio/mpeg" }, 415, "not_image"],
    ["no type", { bytes: jpeg(), type: null }, 415, "not_image"],
    ["JPEG type, PNG bytes", { bytes: png(), type: "image/jpeg" }, 415, "not_image"],
    ["PNG type, JPEG bytes", { bytes: jpeg(), type: "image/png" }, 415, "not_image"],
    ["JPEG type, no magic", { bytes: new Uint8Array(500).fill(0xff) }, 415, "not_image"],
    ["no size", { bytes: jpeg(), length: null }, 413, "bad_size"],
    ["over 2 MB", { bytes: big }, 413, "bad_size"],
    ["declared small, sent big", { bytes: jpeg(1000), length: 500 }, 400, "bad_size"],
    ["empty", { bytes: new Uint8Array(0), length: 0 }, 413, "bad_size"],
  ]) {
    const r = await putArt(env, code, args);
    assert.deepEqual([r.status, r.body?.error], [status, error], why);
  }
  assert.equal((await putArt(env, code, { bytes: jpeg(), method: "PUT" })).status, 405);
  assert.equal((await env.DB.prepare("SELECT art_key FROM booth_tracks WHERE code = ?1").bind(code).first()).art_key, keyBefore, "the row is untouched");
  assert.equal(await objects(), count, "and nothing was written to the bucket");
  const wrongCode = code === "0000" ? "0001" : "0000";
  const ip = freshIp();
  const tries = [];
  for (let i = 0; i < 6; i++) tries.push((await putArt(env, wrongCode, { bytes: jpeg(), ip })).status);
  assert.deepEqual(tries, [404, 404, 404, 404, 404, 429], "a wrong code is a lookup try here too");
  assert.equal(await objects(), count);
  // The rules on their own.
  assert.equal(artType("image/jpeg"), "jpg");
  assert.equal(artType("IMAGE/PNG; charset=binary"), "png");
  for (const bad of ["image/gif", "image/webp", "image/heic", "application/octet-stream", "", null]) assert.equal(artType(bad), null, String(bad));
  assert.equal(artMagic(jpeg()), "jpg");
  assert.equal(artMagic(png()), "png");
  for (const bad of [new Uint8Array([0xff, 0xd8]), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0b]), new Uint8Array(0), null]) assert.equal(artMagic(bad), null);
  assert.equal(artSize("1"), 1);
  assert.equal(artSize(String(ART_MAX_BYTES)), ART_MAX_BYTES);
  for (const bad of [String(ART_MAX_BYTES + 1), "0", "-1", "1.5", "", null, "1e6"]) assert.equal(artSize(bad), null, String(bad));
  assert.equal(ART_MAX_BYTES, 2 * 1024 * 1024);
  assert.equal(artKey("jpg", "0123456789abcdefdeadbeef", (n) => new Uint8Array(n).fill(0xab)), "booth/art/abababababababab-0123456789.jpg");
  assert.equal(ART_SQL, "UPDATE booth_tracks SET art_key = ?2 WHERE code = ?1 RETURNING art_key");
  assert.equal(safeArtUrl("/media/booth/art/abababababababab-0123456789.jpg"), "/media/booth/art/abababababababab-0123456789.jpg");
  for (const bad of ["/media/booth/2468-abc.mp3", "/media/booth/art/x.jpg?dl=1", "/media/booth/art/../x.jpg", "https://evil.example/x.jpg", "", null]) assert.equal(safeArtUrl(bad), null, String(bad));
  // The page's crop: the middle square, at most 1024, never scaled up.
  assert.deepEqual(squareCrop(3000, 2000), { sx: 500, sy: 0, side: 2000, out: 1024 });
  assert.deepEqual(squareCrop(2000, 3000), { sx: 0, sy: 500, side: 2000, out: 1024 });
  assert.deepEqual(squareCrop(640, 640), { sx: 0, sy: 0, side: 640, out: 640 });
  assert.deepEqual(squareCrop(0, 0), { sx: 0, sy: 0, side: 1, out: 1 });
  assert.equal(ART_SIDE, 1024);
  assert.deepEqual(artworkFor("/media/booth/art/abababababababab-0123456789.jpg", "https://voting.topbarz.xyz/track"), [{ src: "https://voting.topbarz.xyz/media/booth/art/abababababababab-0123456789.jpg", sizes: "1024x1024", type: "image/jpeg" }]);
  assert.deepEqual(artworkFor(null, "https://voting.topbarz.xyz/track"), []);
  const player = src("public/js/player.js");
  assert.match(player, /const artwork = Array\.isArray\(track\.artwork\) && track\.artwork\.length \? \{ artwork: track\.artwork \} : \{\};/);
  assert.match(player, /new MediaMetadata\(\{ title: [^}]*, \.\.\.artwork \}\)/, "the lock screen gets the artwork when there is one");
  assert.ok(!/artwork/.test(src("public/js/app.js")) && !/artwork/.test(src("public/js/select.js")), "the vote and the beats pass none");
});

test("the share message and how it goes: the sheet when there is one, else a text on a phone, else the clipboard", () => {
  const link = "https://voting.topbarz.xyz/listen/0123456789abcdef";
  assert.equal(boothShareMessage(TRACK_COPY.shareMessage, link), "I made a song at the Top Barz experience. Check it out: https://voting.topbarz.xyz/listen/0123456789abcdef");
  assert.equal(shareRoute({ share: () => {} }, "desktop"), "share", "a browser with a share sheet uses it, wherever it is");
  assert.equal(shareRoute({ share: () => {} }, "ios"), "share");
  assert.equal(shareRoute({}, "ios"), "sms");
  assert.equal(shareRoute({ share: null }, "android"), "sms");
  assert.equal(shareRoute({}, "desktop"), "copy");
  assert.equal(shareRoute(null, "desktop"), "copy");
  assert.equal(detectPlatform({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" }), "ios");
  assert.equal(smsHref("ios", boothShareMessage(TRACK_COPY.shareMessage, link)), `sms:&body=${encodeURIComponent(`I made a song at the Top Barz experience. Check it out: ${link}`)}`);
  assert.equal(smsHref("android", "x y"), "sms:?body=x%20y");
  assert.equal(smsHref("desktop", "x"), null);
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
test("npm run booth-log writes exports/booth-log.csv (code, file name, size, uploaded_at ISO, opened, public, art, people, everyone_in) and exports/booth-people.csv (code, file name, email, attached_at ISO, vote_opt_in, opted_at ISO) from the booth's two tables only, and stops when there is nothing", async () => {
  assert.equal(JSON.parse(src("package.json")).scripts["booth-log"], "node scripts/booth-log.mjs");
  assert.equal(BOOTH_LOG_SQL, "SELECT t.code, t.file_name, t.size, t.uploaded_at, t.opened, t.public, t.art_key IS NOT NULL AS art, COUNT(p.id) AS people, COALESCE(SUM(p.vote_opt_in), 0) AS opted FROM booth_tracks t LEFT JOIN booth_people p ON p.track_id = t.id GROUP BY t.id ORDER BY t.uploaded_at DESC, t.id DESC");
  assert.equal(BOOTH_PEOPLE_SQL, "SELECT t.code, t.file_name, p.email, p.attached_at, p.vote_opt_in, p.opted_at FROM booth_people p JOIN booth_tracks t ON t.id = p.track_id ORDER BY t.uploaded_at DESC, t.id DESC, p.attached_at ASC, p.id ASC");
  const csv = boothLogCsv([
    { code: "0042", file_name: "Test - Carlos & Damien.mp3", size: 2735168, uploaded_at: Date.parse("2026-10-10T20:15:00Z"), opened: 2, public: 1, art: 1, people: 2, opted: 2 },
    { code: "1234", file_name: '=HYPERLINK("x"), "take".wav', size: null, uploaded_at: 0, opened: 0, public: 0, art: 0, people: 0, opted: 0 },
    { code: "5678", file_name: "Half.wav", size: 1, uploaded_at: 0, opened: 1, public: 0, art: 0, people: 3, opted: 2 },
  ]);
  assert.equal(csv, 'code,file_name,size,uploaded_at,opened,public,art,people,everyone_in\n0042,Test - Carlos & Damien.mp3,2735168,2026-10-10T20:15:00.000Z,2,1,1,2,1\n1234,"\'=HYPERLINK(""x""), ""take"".wav",,1970-01-01T00:00:00.000Z,0,0,0,0,0\n5678,Half.wav,1,1970-01-01T00:00:00.000Z,1,0,0,3,0\n');
  assert.equal(boothPeopleCsv([
    { code: "0042", file_name: "Test - Carlos & Damien.mp3", email: "carlos@example.com", attached_at: Date.parse("2026-10-10T20:16:00Z"), vote_opt_in: 1, opted_at: Date.parse("2026-10-10T20:17:00Z") },
    { code: "0042", file_name: "Test - Carlos & Damien.mp3", email: "=damien@example.com", attached_at: Date.parse("2026-10-10T20:18:00Z"), vote_opt_in: 0, opted_at: null },
  ]), "code,file_name,email,attached_at,vote_opt_in,opted_at\n0042,Test - Carlos & Damien.mp3,carlos@example.com,2026-10-10T20:16:00.000Z,1,2026-10-10T20:17:00.000Z\n0042,Test - Carlos & Damien.mp3,'=damien@example.com,2026-10-10T20:18:00.000Z,0,\n");
  // The two queries, run against this database: the counts the log carries agree with the people's rows, and the log carries no email.
  const up = await upload(env, { name: "Test - Logged.mp3", type: "audio/mpeg", bytes: wav(120) });
  await enter(env, up.body.code, "logged-one@example.com");
  await enter(env, up.body.code, "logged-two@example.com");
  await vote(env, up.body.code, { email: "logged-two@example.com", opt_in: true });
  const logRow = (await env.DB.prepare(BOOTH_LOG_SQL).all()).results.find((r) => r.code === up.body.code);
  assert.deepEqual([logRow.people, logRow.opted, allIn(logRow.people, logRow.opted)], [2, 1, false]);
  assert.ok(!("email" in logRow));
  const peopleRows = (await env.DB.prepare(BOOTH_PEOPLE_SQL).all()).results.filter((r) => r.code === up.body.code);
  assert.deepEqual(peopleRows.map((r) => [r.email, r.vote_opt_in, r.opted_at === null, r.file_name]), [["logged-one@example.com", 0, true, "Test - Logged.mp3"], ["logged-two@example.com", 1, false, "Test - Logged.mp3"]], "attached order, with the file's name");
  assert.ok(!/share_id|art_key AS|SELECT \*|media_key/.test(BOOTH_LOG_SQL + BOOTH_PEOPLE_SQL), "never a share id or a key in either");
  assert.match(src("scripts/booth-log.mjs"), /path\.join\(dir, "booth-people\.csv"\)/, "the people's file is written beside the log, in exports/");
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
  for (const said of ["/booth", "/track", "/track-qr", "npm run booth-log -- --env production", "exports/booth-log.csv", "exports/booth-people.csv", "100 MB", "60 uploads an hour", "300 a day", "5 a minute", "30 an hour", "booth_tracks", "booth_people", "/media/booth/", "?dl=1", "public/js/booth-copy.js", "public/js/track-copy.js", "scripts/make-track-qr.mjs", "tests/booth.test.mjs", "no passphrase", "/listen/<share_id>", "Make public", "public/js/listen-copy.js", "migrations/0005_booth_share.sql", "migrations/0006_booth_people.sql", "/media/booth/art/", "2 MB", "30 a minute", "functions/listen/[[path]].js", "npm run promote-booth -- --env production --code 2468", "scripts/promote-booth.mjs", "promoteVerdict", "not_attached", "tbz.booth.email", "Count me in for the public vote", "Share is anyone's call", "The vote is everyone's consent", "Scooter Taylor", "--dry-run", "never changed or deleted"]) {
    assert.ok(section.includes(said), `RUNBOOK.md, "The booth", does not cover: ${said}`);
  }
  const api = /\n## The API a front end calls\n([\s\S]*?)(?=\n## )/.exec(runbook)?.[1] ?? "";
  for (const route of ["`POST /api/booth/tracks`", "`GET /api/booth/tracks`", "`POST /api/booth/tracks/<code>/enter`", "`POST /api/booth/tracks/<code>/vote`", "`POST /api/booth/tracks/<code>/public`", "`POST /api/booth/tracks/<code>/art`", "`GET /api/booth/listen/<share_id>`", "`/media/booth/…`", "`/media/booth/art/…`"]) assert.ok(api.includes(route), `the API table does not list ${route}`);
  assert.ok(!/\| `GET \/api\/booth\/tracks\/<code>`/.test(api), "the old lookup is out of the table: there is no track without an email");
  assert.match(api, /\*\*`POST \/api\/booth\/tracks\/<code>\/enter`\*\* body `\{ "email": "you@example\.com" \}`/);
  assert.match(api, /\*\*`POST \/api\/booth\/tracks\/<code>\/vote`\*\* body `\{ "email", "opt_in": true \}`/);
  assert.match(api, /\*\*`POST \/api\/booth\/tracks\/<code>\/public`\*\* body `\{ "email", "public": true \}`/);
  assert.match(api, /`x-email`/, "the artwork's email travels in a header");
  assert.match(api, /\*\*`GET \/api\/booth\/listen\/<share_id>`\*\*/);
  assert.ok(/403 `not_attached`/.test(api) && /"people", "everyone_in"/.test(api), "the table says who may change a song and what the log carries");
  const limits = /\n## Limits[^\n]*\n([\s\S]*?)(?=\n## |$)/.exec(runbook)?.[1] ?? "";
  assert.match(limits, /Booth: 60 uploads an hour per IP and 300 a day for the whole site \(`booth-uploads-day`\); log 60 a minute per IP; code lookups 5 a minute and 30 an hour per IP \(a wrong code on the share routes counts here too\); the public switch, the vote and artwork 30 changes a minute per IP; listen reads 30 a minute per IP\./);
  assert.ok(!/BOOTH_KEY|passphrase/.test(runbook.replace(/no passphrase/g, "")), "nothing about a passphrase: there is none");
  const claude = src("CLAUDE.md");
  assert.match(claude, /- \*\*The booth \(`\/booth`, `\/track`, `\/listen`\)\.\*\*/);
  assert.ok(/booth_tracks/.test(claude) && /booth_people/.test(claude) && /tests\/booth\.test\.mjs/.test(claude));
  assert.ok(/Make public/.test(claude) && /\/listen\/<share_id>/.test(claude) && /artwork/.test(claude), "CLAUDE.md names the share");
  assert.match(claude, /\*\*A booth track reaches the vote only through `npm run promote-booth`, and only with everyone's opt-in\*\*/, "the repo rule, in CLAUDE.md");
  assert.ok(/scripts\/promote-booth\.mjs` refuses his booth file/.test(claude) && /functions\/_lib\/exclusions\.js/.test(claude), "and the Scooter Taylor bullet knows the second door");
  assert.ok(/tbz\.booth\.email/.test(claude) && /403 `not_attached`/.test(claude) && /exports\/booth-people\.csv/.test(claude));
});
