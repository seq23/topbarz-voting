// POST /api/entries/upload — step 1 of the contest entry (/entry, 9 Oct 2026): the raw audio file
// (not multipart), streamed into R2 under entries/<id>.<ext> → { upload_id, file_name, size }.
// Headers: x-file-name (URL-encoded), content-type (audio/*), content-length (1 byte to 100 MB).
// The booth's file rules, word for word (functions/_lib/booth.js): audio only (the extension AND
// the declared type), declared size. 10 uploads an hour per connection and 300 a day for the
// whole site. Refused with 403 entries_closed once voting has ended. The upload id is used once:
// POST /api/entries takes it with the form's fields. The file is never served (the media route
// does not take entries/) and no route answers a name, an email or a phone number.
import { fileBody } from "../../_lib/booth.js";
import { END_SETTING_SQL, LIMITS, START_SETTING_SQL, votingPhase } from "../../_lib/config.js";
import { ENTRY_UPLOAD_DAY_KEY, INSERT_UPLOAD_SQL, audioExtension, audioType, cleanFileName, entryKey, uploadId, uploadSize } from "../../_lib/entries.js";
import { HttpError, ipHash, json, route } from "../../_lib/http.js";
import { assertUnderLimit, limitStatement, maybePrune } from "../../_lib/ratelimit.js";

export const onRequest = route({
  async POST(context) {
    const { request, env } = context;
    const fileName = cleanFileName(request.headers.get("x-file-name"));
    if (!fileName) throw new HttpError(400, "file_name_required", "Send the file's name in the x-file-name header.");
    const ext = audioExtension(fileName);
    const contentType = audioType(request.headers.get("content-type"));
    if (!ext || !contentType) throw new HttpError(415, "not_audio", "Your track has to be an audio file: WAV, MP3, M4A, AIFF or FLAC.");
    const size = uploadSize(request.headers.get("content-length"));
    if (size === null) throw new HttpError(413, "bad_size", "Your track has to be between 1 byte and 100 MB.");
    if (!request.body) throw new HttpError(400, "empty_body", "The request has no file in it.");

    const db = env.DB;
    const now = Date.now();
    const ip = await ipHash(request, env);
    const [ipLimit, dayLimit, endRes, startRes] = await db.batch([
      limitStatement(db, `entry:up:ip:${ip}`, LIMITS.entryUploadsPerIp, now),
      limitStatement(db, ENTRY_UPLOAD_DAY_KEY, LIMITS.entryUploadsPerDay, now),
      db.prepare(END_SETTING_SQL),
      db.prepare(START_SETTING_SQL),
    ]);
    if (votingPhase(env, now, startRes.results[0]?.value ?? null, endRes.results[0]?.value ?? null).closed) throw new HttpError(403, "entries_closed", "Entries have closed.");
    assertUnderLimit(ipLimit, LIMITS.entryUploadsPerIp, "uploads");
    if ((dayLimit?.results?.[0]?.count ?? 0) > LIMITS.entryUploadsPerDay.max) {
      throw new HttpError(429, "daily_limit", "We have reached the upload limit for today. Try again tomorrow.", { retry_after_seconds: LIMITS.entryUploadsPerDay.window });
    }

    const id = uploadId();
    const key = entryKey(id, ext);
    const { body, done } = fileBody(request, size);
    await Promise.all([env.MEDIA.put(key, await body, { httpMetadata: { contentType }, customMetadata: { fileName } }), done]);
    try {
      await db.prepare(INSERT_UPLOAD_SQL).bind(id, fileName, contentType, size, key, now).run();
    } catch (err) {
      await env.MEDIA.delete(key).catch(() => {});
      throw err;
    }
    maybePrune(context);
    return json({ upload_id: id, file_name: fileName, size });
  },
});
