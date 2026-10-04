// The booth: an engineer hands a finished recording back by a 4-digit code.
//   POST /api/booth/tracks         the raw file (not multipart), streamed into R2 → { code, file_name, uploaded_at }
//   GET  /api/booth/tracks         the log, newest first, at most 200 rows
//   POST /api/booth/tracks/<code>/enter   { email } → the track (as below) + { you: { email, vote_opt_in }, people, opted, everyone_in }
//                                         the rapper's way in (4 Oct 2026): attaches the email to the track and counts the open
//   POST /api/booth/tracks/<code>/vote    { email, opt_in: true|false } → { code, you, people, opted, everyone_in }   this person's own consent to the public vote
//   POST /api/booth/tracks/<code>/public  { email, public: true|false } → { code, public, share_id }   the share switch (4 Oct 2026)
//   POST /api/booth/tracks/<code>/art     the artwork, raw (image/jpeg or image/png, ≤ 2 MB, checked by its first bytes), header x-email → { code, art_url }
//   GET  /api/booth/listen/<share_id>     the listen page's read → { file_name, audio_url, art_url }; 404 private | not_found (the same status for both)
// Open routes (no passphrase, no token), kept safe by what they accept: audio only (the extension
// AND the declared type), a required content-length of 1 byte to 100 MB, 60 uploads an hour per
// connection, 300 a day for the whole site, code entries 5 a minute and 30 an hour per connection
// (so codes cannot be guessed by trying them all; a wrong code on any change route counts as a
// try, so no route is a second way in), 30 changes and 30 listen reads a minute per connection,
// and never a list or a search. Since 4 Oct 2026 the code is entered WITH an email, and every
// route that changes a song (public, art, vote) takes the email and answers 403 not_attached
// unless that email entered that code: share is anyone's call, the vote is everyone's consent.
// An email is never in a URL, never in the log, and never answered to anyone but its owner.
// Booth tracks are their own data (booth_tracks, booth_people, R2 booth/): never in the vote (tests/booth.test.mjs).
import {
  ACCESS_SQL, ART_SQL, ATTACH_SQL, BOOTH_DAY_KEY, DROP_SQL, LISTEN_SQL, LOG_SQL, OPEN_SQL, PEOPLE_SQL, PUBLIC_SQL, VOTE_SQL, allIn, artKey, artMagic, artSize, artType, artUrl, audioExtension, audioType, cleanEmail, cleanFileName, countPeople, isCode, isShareId, reserveCode, shareId, toTrack, uploadSize,
} from "../../_lib/booth.js";
import { LIMITS } from "../../_lib/config.js";
import { HttpError, fail, ipHash, json, readJson, route } from "../../_lib/http.js";
import { assertUnderLimit, limitStatement, maybePrune } from "../../_lib/ratelimit.js";

// The file goes to R2 as it arrives, never held in memory: on the Workers runtime the body is
// piped through a FixedLengthStream of the declared size, which R2 streams and which fails the
// upload if the bytes do not match the declared length. The handler tests run on Node, where the
// local R2 proxy cannot take a stream, so there (and only there) the body is read whole first.
function fileBody(request, size) {
  if (typeof FixedLengthStream === "function") {
    const fixed = new FixedLengthStream(size);
    const piping = request.body.pipeTo(fixed.writable);
    return { body: fixed.readable, done: piping };
  }
  const done = request.arrayBuffer().then((buf) => {
    if (buf.byteLength !== size) throw new HttpError(400, "bad_size", "The file is not the size the request declared.");
    return buf;
  });
  return { body: done, done };
}

const segments = (params) => (Array.isArray(params?.path) ? params.path : [params?.path]).filter((s) => typeof s === "string" && s !== "");

async function upload(context) {
  const { request, env } = context;
  const fileName = cleanFileName(request.headers.get("x-file-name"));
  if (!fileName) throw new HttpError(400, "file_name_required", "Send the file's name in the x-file-name header.");
  const ext = audioExtension(fileName);
  const contentType = audioType(request.headers.get("content-type"));
  if (!ext || !contentType) throw new HttpError(415, "not_audio", "The booth takes audio only: WAV, MP3, M4A, AIFF or FLAC.");
  const size = uploadSize(request.headers.get("content-length"));
  if (size === null) throw new HttpError(413, "bad_size", "The file has to be between 1 byte and 100 MB, with its size declared.");
  if (!request.body) throw new HttpError(400, "empty_body", "The request has no file in it.");

  const db = env.DB;
  const now = Date.now();
  const ip = await ipHash(request, env);
  const [ipLimit, dayLimit] = await db.batch([
    limitStatement(db, `booth:up:ip:${ip}`, LIMITS.boothUploadsPerIp, now),
    limitStatement(db, BOOTH_DAY_KEY, LIMITS.boothUploadsPerDay, now),
  ]);
  assertUnderLimit(ipLimit, LIMITS.boothUploadsPerIp, "uploads");
  if ((dayLimit?.results?.[0]?.count ?? 0) > LIMITS.boothUploadsPerDay.max) {
    throw new HttpError(429, "daily_limit", "The booth has reached its upload limit for today.", { retry_after_seconds: LIMITS.boothUploadsPerDay.window });
  }

  const reserved = await reserveCode(db, { fileName, contentType, size, ext, uploadedAt: now });
  if (!reserved) throw new HttpError(503, "no_code_free", "No code is free right now. Try again in a moment.");
  try {
    const { body, done } = fileBody(request, size);
    await Promise.all([env.MEDIA.put(reserved.mediaKey, await body, { httpMetadata: { contentType }, customMetadata: { fileName } }), done]);
  } catch (err) {
    await db.prepare(DROP_SQL).bind(reserved.id).run().catch(() => {});
    throw err;
  }
  maybePrune(context);
  return json({ code: reserved.code, file_name: fileName, uploaded_at: new Date(now).toISOString() });
}

async function log(context) {
  const { request, env } = context;
  const db = env.DB;
  const ip = await ipHash(request, env);
  const [limit, rows] = await db.batch([
    limitStatement(db, `booth:log:ip:${ip}`, LIMITS.boothLogPerIp),
    db.prepare(LOG_SQL),
  ]);
  assertUnderLimit(limit, LIMITS.boothLogPerIp, "requests");
  return json({
    tracks: (rows.results ?? []).map((r) => ({ code: r.code, file_name: r.file_name, uploaded_at: new Date(r.uploaded_at).toISOString(), opened: r.opened, size: r.size ?? null, public: r.public === 1, art_url: artUrl(r), people: r.people, everyone_in: allIn(r.people, r.opted) })),
  });
}

const NOT_FOUND = "No track with that code yet. Ask your engineer.";
// A code that found nothing, on any booth route: it is counted against the lookup limits (5 a
// minute, 30 an hour), so the share routes give a guesser no more tries than the lookup does.
async function miss(context, ip, now) {
  const db = context.env.DB;
  const [minute, hour] = await db.batch([
    limitStatement(db, `booth:look:ip:${ip}:m`, LIMITS.boothLookupPerMinute, now),
    limitStatement(db, `booth:look:ip:${ip}:h`, LIMITS.boothLookupPerHour, now),
  ]);
  assertUnderLimit(minute, LIMITS.boothLookupPerMinute, "tries");
  assertUnderLimit(hour, LIMITS.boothLookupPerHour, "tries");
  throw new HttpError(404, "not_found", NOT_FOUND);
}
async function underEditLimit(context, ip, now) {
  const db = context.env.DB;
  assertUnderLimit(await limitStatement(db, `booth:edit:ip:${ip}`, LIMITS.boothEditsPerMinute, now).all(), LIMITS.boothEditsPerMinute, "changes");
}

// The way in: the code WITH an email. A bad email is refused before any code is looked at (no
// try is spent). The right code counts one open, attaches the email (the same email again is the
// same person, nothing changes) and answers the track with this person's own state and the
// counts. Only the email they typed comes back, never anyone else's.
async function enter(context, code) {
  const { request, env } = context;
  const email = cleanEmail((await readJson(request)).email);
  if (!email) throw new HttpError(400, "bad_email", "Enter your email.");
  const db = env.DB;
  const now = Date.now();
  const ip = await ipHash(request, env);
  const [minute, hour] = await db.batch([
    limitStatement(db, `booth:look:ip:${ip}:m`, LIMITS.boothLookupPerMinute, now),
    limitStatement(db, `booth:look:ip:${ip}:h`, LIMITS.boothLookupPerHour, now),
  ]);
  assertUnderLimit(minute, LIMITS.boothLookupPerMinute, "tries");
  assertUnderLimit(hour, LIMITS.boothLookupPerHour, "tries");
  const row = isCode(code) ? (await db.prepare(OPEN_SQL).bind(code, now).all()).results?.[0] : null;
  if (!row) throw new HttpError(404, "not_found", NOT_FOUND);
  const [, people] = await db.batch([
    db.prepare(ATTACH_SQL).bind(row.id, email, now),
    db.prepare(PEOPLE_SQL).bind(row.id),
  ]);
  maybePrune(context);
  return json({ ...toTrack(row), ...youAnd(people.results ?? [], email) });
}
// This person's own state and the counts: { you: { email, vote_opt_in }, people, opted, everyone_in }.
function youAnd(rows, email) {
  const me = rows.find((r) => r.email === email);
  return { you: { email, vote_opt_in: me?.vote_opt_in === 1 }, ...countPeople(rows) };
}
// Who may change a song: an email that entered this code. One read finds the code and the person
// together: no row is a wrong code (a lookup try, 404 or 429); no person is 403 not_attached.
// → { track_id, email }.
async function access(context, ip, now, code, rawEmail) {
  const email = cleanEmail(rawEmail);
  const row = isCode(code) ? (await context.env.DB.prepare(ACCESS_SQL).bind(code, email || "-").all()).results?.[0] : null;
  if (!row) return miss(context, ip, now);
  if (!email || row.person_id === null || row.person_id === undefined) throw new HttpError(403, "not_attached", "Enter the code with your email first.");
  return { track_id: row.track_id, email };
}

// This person's own consent to the public vote, on or off; the answer carries the counts so the
// page can say who is still out (as a number, never a name).
async function vote(context, code) {
  const { request, env } = context;
  const body = await readJson(request);
  if (typeof body.opt_in !== "boolean") throw new HttpError(400, "bad_opt_in", "Send { opt_in: true } or { opt_in: false }.");
  const now = Date.now();
  const ip = await ipHash(request, env);
  await underEditLimit(context, ip, now);
  const { track_id: trackId, email } = await access(context, ip, now, code, body.email);
  const db = env.DB;
  const [, people] = await db.batch([
    db.prepare(VOTE_SQL).bind(trackId, email, body.opt_in ? 1 : 0, body.opt_in ? now : null),
    db.prepare(PEOPLE_SQL).bind(trackId),
  ]);
  maybePrune(context);
  return json({ code, ...youAnd(people.results ?? [], email) });
}

// The share switch: anyone attached to the song may flip it either way ("share is anyone's
// call"). A track from before the share existed has no share id yet: it gets one here, on its
// first publish.
async function setPublic(context, code) {
  const { request, env } = context;
  const body = await readJson(request);
  if (typeof body.public !== "boolean") throw new HttpError(400, "bad_public", "Send { public: true } or { public: false }.");
  const now = Date.now();
  const ip = await ipHash(request, env);
  await underEditLimit(context, ip, now);
  await access(context, ip, now, code, body.email);
  const row = (await env.DB.prepare(PUBLIC_SQL).bind(code, body.public ? 1 : 0, shareId()).all()).results?.[0];
  if (!row) return miss(context, ip, now); // taken down between the check and the write
  maybePrune(context);
  return json({ code, public: row.public === 1, share_id: row.public === 1 ? row.share_id : null });
}

// The artwork: the page sends a square JPEG it made itself (the email in the x-email header: the
// body is the picture); the server takes image/jpeg or image/png, at most 2 MB, and reads the
// first bytes to be sure. A new picture is a new key; the old object is left where it is
// (unguessable, harmless) and forgotten by the row.
async function setArt(context, code) {
  const { request, env } = context;
  const ext = artType(request.headers.get("content-type"));
  if (!ext) throw new HttpError(415, "not_image", "Artwork is a JPEG or PNG picture.");
  const size = artSize(request.headers.get("content-length"));
  if (size === null) throw new HttpError(413, "bad_size", "Artwork has to be between 1 byte and 2 MB, with its size declared.");
  if (!request.body) throw new HttpError(400, "empty_body", "The request has no picture in it.");
  const now = Date.now();
  const ip = await ipHash(request, env);
  await underEditLimit(context, ip, now);
  const db = env.DB;
  await access(context, ip, now, code, request.headers.get("x-email"));
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength !== size) throw new HttpError(400, "bad_size", "The picture is not the size the request declared.");
  if (artMagic(bytes) !== ext) throw new HttpError(415, "not_image", "That is not a JPEG or PNG picture.");
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const key = artKey(ext, hash);
  await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: ext === "png" ? "image/png" : "image/jpeg" } });
  const row = (await db.prepare(ART_SQL).bind(code, key).all()).results?.[0];
  if (!row) { // taken down between the check and the write
    await env.MEDIA.delete(key).catch(() => {});
    return miss(context, ip, now);
  }
  maybePrune(context);
  return json({ code, art_url: artUrl(row) });
}

// The listen page's read, by share id only. A private track and an unknown id answer the same
// status and the same words (only the error code differs, for the page), and nothing is counted
// as an open: opens are the rapper's own.
async function listen(context, id) {
  const { request, env } = context;
  const db = env.DB;
  const ip = await ipHash(request, env);
  assertUnderLimit(await limitStatement(db, `booth:listen:ip:${ip}`, LIMITS.boothListenPerMinute).all(), LIMITS.boothListenPerMinute, "requests");
  const row = isShareId(id) ? (await db.prepare(LISTEN_SQL).bind(id).all()).results?.[0] : null;
  if (!row) throw new HttpError(404, "not_found", "Sorry, this song is private.");
  if (row.public !== 1) throw new HttpError(404, "private", "Sorry, this song is private.");
  maybePrune(context);
  return json({ file_name: row.file_name, audio_url: `/media/${row.media_key}`, art_url: artUrl(row) });
}

export const onRequest = route({
  async GET(context) {
    const parts = segments(context.params);
    if (parts.length === 1 && parts[0] === "tracks") return log(context);
    if (parts.length === 2 && parts[0] === "listen") return listen(context, parts[1]);
    // GET /api/booth/tracks/<code> was the lookup until 4 Oct 2026: there is no track without an email now.
    return fail(404, "not_found", "No such API route.");
  },
  async POST(context) {
    const parts = segments(context.params);
    if (parts.length === 1 && parts[0] === "tracks") return upload(context);
    if (parts.length === 3 && parts[0] === "tracks" && parts[2] === "enter") return enter(context, parts[1]);
    if (parts.length === 3 && parts[0] === "tracks" && parts[2] === "vote") return vote(context, parts[1]);
    if (parts.length === 3 && parts[0] === "tracks" && parts[2] === "public") return setPublic(context, parts[1]);
    if (parts.length === 3 && parts[0] === "tracks" && parts[2] === "art") return setArt(context, parts[1]);
    return fail(404, "not_found", "No such API route.");
  },
});
