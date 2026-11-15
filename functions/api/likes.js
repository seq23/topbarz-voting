// POST /api/likes — Authorization: Bearer <token>. Body: { track: "<slug>", liked?: boolean }.
// Without `liked` it toggles; with it, it sets that state (safe to retry: asking for the state a
// voter is already in changes nothing). One active like per voter per track; any number of tracks.
// Returns { track, liked, likes }. Rejected with 403 voting_closed after the end time (server clock).
import { END_SETTING_SQL, LIMITS, START_SETTING_SQL, votingPhase } from "../_lib/config.js";
import { HttpError, ipHash, json, readJson, route } from "../_lib/http.js";
import { assertUnderLimit, limitStatement, maybePrune } from "../_lib/ratelimit.js";
import { requireVoter } from "../_lib/token.js";

const LAST_ACTION = "COALESCE((SELECT action FROM like_events WHERE voter_id = ?1 AND track_id = ?2 ORDER BY id DESC LIMIT 1), 'unlike')";
// One statement each, so two taps racing can never leave two active likes.
const TOGGLE_SQL = `INSERT INTO like_events (voter_id, track_id, action, created_at)
  SELECT ?1, ?2, CASE WHEN ${LAST_ACTION} = 'like' THEN 'unlike' ELSE 'like' END, ?3`;
const SET_SQL = `INSERT INTO like_events (voter_id, track_id, action, created_at)
  SELECT ?1, ?2, ?4, ?3 WHERE ${LAST_ACTION} <> ?4`;
const AFTER_SQL = `SELECT ${LAST_ACTION} AS action,
  (SELECT COALESCE(SUM(CASE e.action WHEN 'like' THEN 1 ELSE -1 END), 0) FROM like_events e
    WHERE e.track_id = ?2 AND e.voter_id NOT IN (SELECT id FROM voters WHERE flagged = 1)) AS likes`;

export const onRequest = route({
  async POST(context) {
    const { request, env } = context;
    const body = await readJson(request);
    const voterId = await requireVoter(request, env, body.token);
    const slug = typeof body.track === "string" ? body.track.trim().toLowerCase() : "";
    if (!slug) throw new HttpError(400, "track_required", "Say which track.");
    if (body.liked !== undefined && typeof body.liked !== "boolean") throw new HttpError(400, "bad_liked", "`liked` is true or false.");

    const db = env.DB;
    const now = Date.now();
    const ip = await ipHash(request, env);
    const [ipLimit, voterLimit, trackRes, voterRes, settingRes, startRes] = await db.batch([
      limitStatement(db, `likes:ip:${ip}`, LIMITS.likesPerIp, now),
      limitStatement(db, `likes:voter:${voterId}`, LIMITS.likesPerVoter, now),
      db.prepare("SELECT id FROM tracks WHERE slug = ?1 AND active = 1").bind(slug),
      db.prepare("SELECT id FROM voters WHERE id = ?1").bind(voterId),
      db.prepare(END_SETTING_SQL),
      db.prepare(START_SETTING_SQL),
    ]);
    const phase = votingPhase(env, now, startRes.results[0]?.value ?? null, settingRes.results[0]?.value ?? null);
    if (phase.closed) throw new HttpError(403, "voting_closed", "Voting has closed.");
    if (phase.notOpen) throw new HttpError(403, "voting_not_open", "Voting opens Sunday, October 11, at 10 AM ET.");
    if (!voterRes.results[0]) throw new HttpError(401, "invalid_token", "Sign in again to continue.");
    assertUnderLimit(ipLimit, LIMITS.likesPerIp, "likes");
    assertUnderLimit(voterLimit, LIMITS.likesPerVoter, "likes");
    const track = trackRes.results[0];
    if (!track) throw new HttpError(404, "unknown_track", "That track is not in the vote.");

    const at = new Date(now).toISOString();
    const write = body.liked === undefined
      ? db.prepare(TOGGLE_SQL).bind(voterId, track.id, at)
      : db.prepare(SET_SQL).bind(voterId, track.id, at, body.liked ? "like" : "unlike");
    const [, after] = await db.batch([write, db.prepare(AFTER_SQL).bind(voterId, track.id)]);
    maybePrune(context);
    const row = after.results[0];
    return json({ track: slug, liked: row.action === "like", likes: Math.max(0, row.likes) });
  },
});
