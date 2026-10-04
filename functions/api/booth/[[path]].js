// The booth: an engineer hands a finished recording back by a 4-digit code.
//   POST /api/booth/tracks         the raw file (not multipart), streamed into R2 → { code, file_name, uploaded_at }
//   GET  /api/booth/tracks         the log, newest first, at most 200 rows
//   GET  /api/booth/tracks/<code>  the rapper's lookup: counts the open → { code, file_name, audio_url, download_url, size, uploaded_at }
// Open routes (no passphrase, no token, no email), kept safe by what they accept: audio only (the
// extension AND the declared type), a required content-length of 1 byte to 100 MB, 60 uploads an
// hour per connection, 300 a day for the whole site, lookups 5 a minute and 30 an hour per
// connection (so codes cannot be guessed by trying them all), and never a list or a search.
// Booth tracks are their own data (booth_tracks, R2 booth/): never in the vote (tests/booth.test.mjs).
import { BOOTH_DAY_KEY, DROP_SQL, LOG_SQL, OPEN_SQL, audioExtension, audioType, cleanFileName, isCode, reserveCode, toTrack, uploadSize } from "../../_lib/booth.js";
import { LIMITS } from "../../_lib/config.js";
import { HttpError, fail, ipHash, json, route } from "../../_lib/http.js";
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
    tracks: (rows.results ?? []).map((r) => ({ code: r.code, file_name: r.file_name, uploaded_at: new Date(r.uploaded_at).toISOString(), opened: r.opened, size: r.size ?? null })),
  });
}

async function lookup(context, code) {
  const { request, env } = context;
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
  if (!row) throw new HttpError(404, "not_found", "No track with that code yet. Ask your engineer.");
  maybePrune(context);
  return json(toTrack(row));
}

export const onRequest = route({
  async GET(context) {
    const parts = segments(context.params);
    if (parts.length === 1 && parts[0] === "tracks") return log(context);
    if (parts.length === 2 && parts[0] === "tracks") return lookup(context, parts[1]);
    return fail(404, "not_found", "No such API route.");
  },
  async POST(context) {
    const parts = segments(context.params);
    if (parts.length === 1 && parts[0] === "tracks") return upload(context);
    return fail(404, "not_found", "No such API route.");
  },
});
