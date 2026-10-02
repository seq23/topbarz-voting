// GET  /api/comments?track=<slug>[&before=<id>][&limit=<1-50>]
//      → { track, total, has_more, comments: [{ id, first_name, text, gif, created_at }] }
//      The newest `limit` (default 20), oldest first, so the newest sits at the bottom. `before`
//      pages back ("show more"). Only a first name is ever returned; hidden comments never are.
// POST /api/comments — Authorization: Bearer <token>. Body: { track, text?, gif?: { id, url? } }
//      (text, a GIF, or both) → { comment, comments: <new count> }. 403 voting_closed after the end.
import { COMMENT_MAX_CHARS, END_SETTING_SQL, LIMITS, votingEndsAtMs } from "../_lib/config.js";
import { HttpError, ipHash, json, readJson, route } from "../_lib/http.js";
import { assertUnderLimit, limitStatement, maybePrune } from "../_lib/ratelimit.js";
import { requireVoter } from "../_lib/token.js";
import { cleanText, firstName, parseGif } from "../_lib/validate.js";

function shape(row) {
  return {
    id: row.id,
    first_name: firstName(row.name),
    text: row.body,
    gif: row.gif_id ? { id: row.gif_id, url: row.gif_url } : null,
    created_at: row.created_at,
  };
}

export const onRequest = route({
  async GET({ request, env }) {
    const url = new URL(request.url);
    const slug = (url.searchParams.get("track") || "").trim().toLowerCase();
    if (!slug) throw new HttpError(400, "track_required", "Say which track.");
    const limit = Math.min(50, Math.max(1, Number.parseInt(url.searchParams.get("limit") || "20", 10) || 20));
    const before = Number.parseInt(url.searchParams.get("before") || "", 10);
    const db = env.DB;
    const track = await db.prepare("SELECT id FROM tracks WHERE slug = ?1 AND active = 1").bind(slug).first();
    if (!track) throw new HttpError(404, "unknown_track", "That track is not in the vote.");
    const [rowsRes, totalRes] = await db.batch([
      db.prepare(
        `SELECT c.id, c.body, c.gif_id, c.gif_url, c.created_at, v.name FROM comments c JOIN voters v ON v.id = c.voter_id
         WHERE c.track_id = ?1 AND c.hidden = 0 AND c.id < ?2 ORDER BY c.id DESC LIMIT ?3`,
      ).bind(track.id, Number.isFinite(before) && before > 0 ? before : Number.MAX_SAFE_INTEGER, limit + 1),
      db.prepare("SELECT COUNT(*) AS n FROM comments WHERE track_id = ?1 AND hidden = 0").bind(track.id),
    ]);
    const rows = rowsRes.results;
    const hasMore = rows.length > limit;
    return json({ track: slug, total: totalRes.results[0].n, has_more: hasMore, comments: rows.slice(0, limit).reverse().map(shape) });
  },

  async POST(context) {
    const { request, env } = context;
    const body = await readJson(request);
    const voterId = await requireVoter(request, env, body.token);
    const slug = typeof body.track === "string" ? body.track.trim().toLowerCase() : "";
    if (!slug) throw new HttpError(400, "track_required", "Say which track.");
    if (typeof body.text === "string" && body.text.trim().length > COMMENT_MAX_CHARS) {
      throw new HttpError(400, "comment_too_long", `Keep it under ${COMMENT_MAX_CHARS} characters.`);
    }
    const text = typeof body.text === "string" ? body.text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replace(/\n{3,}/g, "\n\n").trim() : "";
    const { gif, error: gifError } = parseGif(body.gif);
    if (gifError) throw new HttpError(400, "bad_gif", gifError);
    if (!text && !gif) throw new HttpError(400, "empty_comment", "Write something or pick a GIF.");

    const db = env.DB;
    const now = Date.now();
    const ip = await ipHash(request, env);
    const [ipLimit, voterLimit, trackRes, voterRes, settingRes] = await db.batch([
      limitStatement(db, `comments:ip:${ip}`, LIMITS.commentsPerIp, now),
      limitStatement(db, `comments:voter:${voterId}`, LIMITS.commentsPerVoter, now),
      db.prepare("SELECT id FROM tracks WHERE slug = ?1 AND active = 1").bind(slug),
      db.prepare("SELECT id, name FROM voters WHERE id = ?1").bind(voterId),
      db.prepare(END_SETTING_SQL),
    ]);
    if (now >= votingEndsAtMs(env, settingRes.results[0]?.value ?? null)) throw new HttpError(403, "voting_closed", "Voting has closed.");
    const voter = voterRes.results[0];
    if (!voter) throw new HttpError(401, "invalid_token", "Sign in again to continue.");
    assertUnderLimit(ipLimit, LIMITS.commentsPerIp, "comments");
    assertUnderLimit(voterLimit, LIMITS.commentsPerVoter, "comments");
    const track = trackRes.results[0];
    if (!track) throw new HttpError(404, "unknown_track", "That track is not in the vote.");

    const at = new Date(now).toISOString();
    const [insertRes, totalRes] = await db.batch([
      db.prepare("INSERT INTO comments (voter_id, track_id, body, gif_id, gif_url, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) RETURNING id")
        .bind(voterId, track.id, text, gif?.id ?? null, gif?.url ?? null, at),
      db.prepare("SELECT COUNT(*) AS n FROM comments WHERE track_id = ?1 AND hidden = 0").bind(track.id),
    ]);
    maybePrune(context);
    return json({
      comment: shape({ id: insertRes.results[0].id, name: voter.name, body: text, gif_id: gif?.id ?? null, gif_url: gif?.url ?? null, created_at: at }),
      comments: totalRes.results[0].n,
    }, 201);
  },
});
