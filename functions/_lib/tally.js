// The count and the tie-break, from the like events alone. Pure: used by scripts/export.mjs and
// checked against the live SQL count in tests/likes.test.mjs.
//
// Rule (PRD section 6; the tie-break is PROPOSED, not yet confirmed by Scooter): most likes wins;
// tracks tied on likes are ordered by which reached that count FIRST — the time of the like that
// first brought the track to its final count. `last_reached_at` (the last time it climbed to that
// count, after any un-likes) is reported too, in case the confirmed rule reads that way.
// `likes_verified` is the part of `likes` that came from voters who entered an email code (an
// event carries `verified` = its voter's); it sits beside `likes` and never changes the order.
export function computeTally(tracks, events, commentCounts = {}) {
  const byTrack = new Map(tracks.map((t) => [t.id, { ...t, likes: 0, likes_verified: 0, history: [] }]));
  for (const e of [...events].sort((a, b) => a.id - b.id)) {
    const t = byTrack.get(e.track_id);
    if (!t) continue;
    t.likes += e.action === "like" ? 1 : -1;
    if (e.verified) t.likes_verified += e.action === "like" ? 1 : -1;
    if (e.action === "like") t.history.push({ count: t.likes, at: e.created_at, id: e.id });
  }
  const rows = [...byTrack.values()].map((t) => {
    const reached = t.history.filter((h) => h.count === t.likes);
    return {
      slug: t.slug, label: t.label, likes: t.likes, likes_verified: t.likes_verified, comments: commentCounts[t.id] ?? 0,
      first_reached_at: t.likes > 0 ? reached[0]?.at ?? null : null,
      last_reached_at: t.likes > 0 ? reached[reached.length - 1]?.at ?? null : null,
      _firstId: t.likes > 0 ? reached[0]?.id ?? Infinity : Infinity,
    };
  });
  rows.sort((a, b) => b.likes - a.likes || a._firstId - b._firstId || a.slug.localeCompare(b.slug));
  let rank = 0;
  return rows.map((r, i) => {
    const tiedWithPrev = i > 0 && rows[i - 1].likes === r.likes;
    const tiedWithNext = i < rows.length - 1 && rows[i + 1].likes === r.likes;
    rank = i + 1;
    const { _firstId, ...rest } = r;
    return { rank, ...rest, tie_break_order: tiedWithPrev || tiedWithNext ? rows.filter((x, j) => j <= i && x.likes === r.likes).length : "" };
  });
}
