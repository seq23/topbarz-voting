// Everything /api/state returns, built from D1 and the R2 photo manifest.
import { END_SETTING_SQL, START_SETTING_SQL, giphyStatus, gateStatus, verificationStatus, votingPhase } from "./config.js";

export const PHOTO_MANIFEST_KEY = "manifest/photos.json";

// Likes from flagged voters never count, live or in the export.
export const TRACKS_WITH_COUNTS_SQL = `
SELECT t.slug, t.label, t.audio_key, t.duration_ms, t.sort,
  (SELECT COALESCE(SUM(CASE e.action WHEN 'like' THEN 1 ELSE -1 END), 0) FROM like_events e
    WHERE e.track_id = t.id AND e.voter_id NOT IN (SELECT id FROM voters WHERE flagged = 1)) AS likes,
  (SELECT COUNT(*) FROM comments c WHERE c.track_id = t.id AND c.hidden = 0) AS comments
FROM tracks t WHERE t.active = 1 ORDER BY t.sort, t.label, t.id`;

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
  const [tracksRes, settingRes, startRes] = await env.DB.batch([env.DB.prepare(TRACKS_WITH_COUNTS_SQL), env.DB.prepare(END_SETTING_SQL), env.DB.prepare(START_SETTING_SQL)]);
  const { startsAt, endsAt, closed, notOpen } = votingPhase(env, now, startRes.results?.[0]?.value ?? null, settingRes.results?.[0]?.value ?? null);
  const photos = await readPhotoManifest(env);
  return {
    now: new Date(now).toISOString(),
    voting_ends_at: new Date(endsAt).toISOString(),
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
    gate: gateStatus(env),
    giphy: giphyStatus(env),
    verification: verificationStatus(env),
  };
}
