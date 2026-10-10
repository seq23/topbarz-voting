// POST /api/entries — step 2 of the contest entry (/entry, 9 Oct 2026): the form's fields and the
// upload id from POST /api/entries/upload → { entry: <number> }. JSON body:
//   { first_name, last_name, city, email, phone, in_group: true|false,
//     instagram, track_title   (both optional),
//     members: [{ first_name, last_name, email }]   (1 to 10 when in_group, none otherwise),
//     agree: true   (the "I agree to the official rules" box: refused unless exactly true),
//     upload_id, website: ""   (the honeypot: must be empty) }
// Every field is required and checked again here (functions/_lib/entries.js parseEntry). 10 entries
// an hour per connection. 403 entries_closed once voting has ended (an entry after the vote cannot
// win). One upload is one entry: a used or unknown upload id is 409 upload_used / 404 upload_unknown.
// The answer is the entry number and nothing else: no route ever answers an email, a phone number
// or a name. GET and everything else is 405. Entries are their own data, never in the vote.
import { END_SETTING_SQL, LIMITS, START_SETTING_SQL, votingPhase } from "../_lib/config.js";
import { DROP_ENTRY_SQL, INSERT_ENTRY_SQL, INSERT_MEMBER_SQL, parseEntry } from "../_lib/entries.js";
import { HttpError, ipHash, json, readJson, route } from "../_lib/http.js";
import { assertUnderLimit, limitStatement, maybePrune } from "../_lib/ratelimit.js";

export const onRequest = route({
  async POST(context) {
    const { request, env } = context;
    const body = await readJson(request, 32 * 1024);
    const parsed = parseEntry(body);
    if (!parsed.ok) throw new HttpError(400, parsed.error, parsed.message, { field: parsed.field });
    const e = parsed.value;

    const db = env.DB;
    const now = Date.now();
    const ip = await ipHash(request, env);
    const [ipLimit, endRes, startRes, uploadRes] = await db.batch([
      limitStatement(db, `entry:ip:${ip}`, LIMITS.entriesPerIp, now),
      db.prepare(END_SETTING_SQL),
      db.prepare(START_SETTING_SQL),
      db.prepare("SELECT id, (SELECT COUNT(*) FROM entries WHERE upload_id = ?1) AS used FROM entry_uploads WHERE id = ?1").bind(e.upload_id),
    ]);
    if (votingPhase(env, now, startRes.results[0]?.value ?? null, endRes.results[0]?.value ?? null).closed) throw new HttpError(403, "entries_closed", "Entries have closed.");
    assertUnderLimit(ipLimit, LIMITS.entriesPerIp, "entries");
    const upload = uploadRes.results[0];
    if (!upload) throw new HttpError(404, "upload_unknown", "Upload your track again.");
    if (upload.used > 0) throw new HttpError(409, "upload_used", "That track is already entered.");

    let id;
    try {
      id = (await db.prepare(INSERT_ENTRY_SQL).bind(e.first_name, e.last_name, e.city, e.email, e.phone, e.in_group ? 1 : 0, now, e.upload_id, e.instagram, e.track_title).all()).results?.[0]?.id;
    } catch {
      id = undefined; // UNIQUE (upload_id): a second submission raced this one and won
    }
    if (id === undefined) throw new HttpError(409, "upload_used", "That track is already entered.");
    if (e.members.length > 0) {
      try {
        await db.batch(e.members.map((m) => db.prepare(INSERT_MEMBER_SQL).bind(id, m.first_name, m.last_name, m.email)));
      } catch (err) {
        await db.prepare(DROP_ENTRY_SQL).bind(id).run().catch(() => {});
        throw err;
      }
    }
    maybePrune(context);
    return json({ entry: id }, 201);
  },
});
