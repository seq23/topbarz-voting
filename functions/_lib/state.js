// Everything /api/state returns, built from D1 and the R2 photo manifest.
import { END_SETTING_SQL, START_SETTING_SQL, giphyStatus, gateStatus, verificationStatus, votingPhase } from "./config.js";
import { GIFS_SQL, holidayOn, partyTrackClause, toGif } from "./party.js";

export const PHOTO_MANIFEST_KEY = "manifest/photos.json";

// Likes from flagged voters never count, live or in the export. While the holiday party is on, a
// like counts only once its voter has entered the 6-digit email code (Scooter, 18 Nov 2026: "counted
// only after the 6-digit email code"): a like from someone let in without one is kept, and counts
// the moment they verify, as long as that is before voting closes (Scooter, 19 Nov 2026: "make sure
// votes after the cutoff don't count"): a code entered after the end counts nothing. `endsAtMs` is the
// window's end (Infinity: none); the ISO text is made from a number, never from a request.
const verifiedBefore = (endsAtMs) => (Number.isFinite(endsAtMs) ? ` AND (verified_at IS NULL OR verified_at < '${new Date(endsAtMs).toISOString()}')` : "");
export const countedLikesClause = (env, alias = "e", endsAtMs = Infinity) => (holidayOn(env)
  ? `${alias}.voter_id IN (SELECT id FROM voters WHERE flagged = 0 AND verified = 1${verifiedBefore(endsAtMs)})`
  : `${alias}.voter_id NOT IN (SELECT id FROM voters WHERE flagged = 1)`);
export const tracksWithCountsSql = (env, endsAtMs = Infinity) => `
SELECT t.slug, t.label, t.audio_key, t.duration_ms, t.sort,
  (SELECT COALESCE(SUM(CASE e.action WHEN 'like' THEN 1 ELSE -1 END), 0) FROM like_events e
    WHERE e.track_id = t.id AND ${countedLikesClause(env, "e", endsAtMs)}) AS likes,
  (SELECT COUNT(*) FROM comments c WHERE c.track_id = t.id AND c.hidden = 0) AS comments
FROM tracks t WHERE t.active = 1${partyTrackClause(env)} ORDER BY t.sort, t.label, t.id`;

export async function readPhotoManifest(env) {
  try {
    const obj = await env.MEDIA.get(PHOTO_MANIFEST_KEY);
    if (!obj) return [];
    const data = await obj.json();
    return Array.isArray(data?.photos) ? data.photos : [];
  } catch (err) {
    console.error("photo manifest unreadable", String(err));
    return [];
  }
}

export async function buildState(env, now = Date.now()) {
  const [settingRes, startRes] = await env.DB.batch([env.DB.prepare(END_SETTING_SQL), env.DB.prepare(START_SETTING_SQL)]);
  const { startsAt, endsAt, closed, notOpen } = votingPhase(env, now, startRes.results?.[0]?.value ?? null, settingRes.results?.[0]?.value ?? null);
  // Counted against the end, so a code entered after the close never adds a vote.
  const tracksRes = await env.DB.prepare(tracksWithCountsSql(env, endsAt)).all();
  const holiday = holidayOn(env);
  // While the party is on, the old CultureCon photos are never served (Scooter, 17 Nov 2026:
  // "Remove everything CultureCon"; the GIFs replace the old photos). Party photos loaded with
  // `load-photos --event "the Christmas party"` show as before. Off, the answer is unchanged.
  const photos = (await readPhotoManifest(env)).filter((p) => !holiday || !/culturecon/i.test(String(p?.alt ?? "")));
  // The holiday party (17 Nov 2026): the GIFs the team picked show in the gallery until there are
  // event photos. Off (production until go-live), none are read and the answer is as before.
  const gifs = holiday ? ((await env.DB.prepare(GIFS_SQL).all()).results ?? []).map(toGif) : [];
  return {
    now: new Date(now).toISOString(),
    // null only while no end is set.
    voting_ends_at: Number.isFinite(endsAt) ? new Date(endsAt).toISOString() : null,
    closed,
    voting_starts_at: new Date(startsAt).toISOString(),
    open: !closed && !notOpen,
    tracks: (tracksRes.results ?? []).map((t) => ({
      slug: t.slug,
      label: t.label,
      audio_url: `/media/${t.audio_key}`,
      duration_ms: t.duration_ms ?? null,
      likes: Math.max(0, t.likes),
      comments: t.comments,
    })),
    photos,
    ...(holiday ? { holiday: { on: true }, gifs } : {}),
    gate: gateStatus(env),
    giphy: giphyStatus(env),
    verification: verificationStatus(env),
  };
}
