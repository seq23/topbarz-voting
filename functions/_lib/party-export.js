// The team's two downloads on /team (Scooter, 20 Nov 2026: "Add a CSV export on the team page: one
// for the line (everyone who signed up, with name, phone, email, city and Instagram), and one for
// the songs (code, title, who is on it, whether it is in the vote, and the like and comment counts)").
// Answered to a signed-in team member only (the same token as the line), never cached, never kept
// on the server: the file is made from D1 at the moment of the tap.
import { END_SETTING_SQL, START_SETTING_SQL, votingPhase } from "./config.js";
import { teamSongs } from "./contest.js";
import { guestFlags, laneOf } from "./party.js";
import { countedLikesClause } from "./state.js";

// One cell. Every cell is quoted. A cell a spreadsheet would run as a formula (=, @, a tab or a
// return first; + or - followed by anything that is not a phone number's characters) gets a
// leading apostrophe, so a sign-up typed as "=HYPERLINK(…)" is text in Excel and Sheets, while a
// phone number like +1 901 555 0100 stays as it was.
export function csvCell(value) {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=@\t\r]/.test(s) || /^[+-](?![\d\s().-]*$)/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
// The file: a byte-order mark (Excel then reads the accents right), a header row, CRLF lines.
export const toCsv = (header, rows) => `﻿${[header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n")}\r\n`;

const iso = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : "");
const LANE_WORDS = { waiting: "waiting", booth: "in the booth", upload: "at the upload station", done: "done" };
const FLAG_WORDS = { test: "looks like a test sign-up", stale: "signed up more than 12 hours ago" };

// ── The line: everyone who signed up, one row per person (their one record), first sign-up first.
export const LINE_EXPORT_SQL = `SELECT g.id, g.name, g.phone, g.email, g.city, g.instagram, g.joined_at,
  (SELECT MIN(v.joined_at) FROM party_visits v WHERE v.guest_id = g.id) AS first_joined_at,
  (SELECT COUNT(*) FROM party_visits v WHERE v.guest_id = g.id) AS visits,
  s.status, s.done_at
  FROM party_guests g LEFT JOIN party_sessions s ON s.id = g.session_id
  ORDER BY COALESCE((SELECT MIN(v.joined_at) FROM party_visits v WHERE v.guest_id = g.id), g.joined_at), g.id`;
export const LINE_HEADER = ["Name", "Phone", "Email", "City", "Instagram", "First signed up (UTC)", "Last signed up (UTC)", "Times in line", "Now", "Flags"];
export function lineRows(rows, now = Date.now()) {
  return rows.map((g) => [
    g.name, g.phone, g.email, g.city, String(g.instagram ?? "").replace(/^@+/, ""),
    iso(g.first_joined_at ?? g.joined_at), iso(g.joined_at), Math.max(1, Number(g.visits) || 0),
    LANE_WORDS[laneOf(g)] ?? "", guestFlags(g, now).map((f) => FLAG_WORDS[f] ?? f).join("; "),
  ]);
}

// ── The songs: the team's Songs list, with the counts the voting page shows (a like counts as the
// page counts it: while the party is on, only once its voter entered the 6-digit code before the
// cutoff), and the full names of the people on each (team only).
export const songCountsSql = (env, endsAtMs) => `SELECT b.code,
  (SELECT COALESCE(SUM(CASE e.action WHEN 'like' THEN 1 ELSE -1 END), 0) FROM like_events e WHERE e.track_id = b.vote_track_id AND ${countedLikesClause(env, "e", endsAtMs)}) AS likes,
  (SELECT COUNT(*) FROM comments c WHERE c.track_id = b.vote_track_id AND c.hidden = 0) AS comments
  FROM booth_tracks b WHERE b.vote_track_id IS NOT NULL`;
export const SONGS_HEADER = ["Code", "Title", "Who is on it", "People", "In the vote", "Likes", "Comments", "Last entered or withdrawn", "Uploaded (UTC)", "File"];
const voteWords = (s) => (s.entered ? "yes" : s.pulled ? "no (taken out by the team)" : s.ticked ? "no (entered, not eligible)" : s.changed ? "no (withdrawn)" : "no (never entered)");
export function songRows(songs, counts) {
  return songs.map((s) => {
    const c = counts.get(s.code) ?? { likes: 0, comments: 0 };
    const names = (s.members ?? []).map((m) => m.name ?? "someone not signed up");
    return [
      s.code, s.label, names.join(", "), names.length, voteWords(s), Math.max(0, Number(c.likes) || 0), Number(c.comments) || 0,
      s.changed ? `${s.changed.action} by ${s.changed.by} at ${s.changed.at}` : "", s.uploaded_at ?? "", s.file_name ?? "",
    ];
  });
}

const stamp = (now) => new Date(now).toISOString().slice(0, 16).replace(/[:T]/g, "-");
const csvResponse = (body, name) => new Response(body, {
  status: 200,
  headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}"`, "cache-control": "no-store", "x-robots-tag": "noindex" },
});

export async function lineCsv(env, now = Date.now()) {
  const rows = (await env.DB.prepare(LINE_EXPORT_SQL).all()).results ?? [];
  return csvResponse(toCsv(LINE_HEADER, lineRows(rows, now)), `topbarz-line-${stamp(now)}.csv`);
}
export async function songsCsv(env, now = Date.now()) {
  const [start, end] = await env.DB.batch([env.DB.prepare(START_SETTING_SQL), env.DB.prepare(END_SETTING_SQL)]);
  const { endsAt } = votingPhase(env, now, start.results?.[0]?.value ?? null, end.results?.[0]?.value ?? null);
  const [songs, counts] = await Promise.all([teamSongs(env.DB), env.DB.prepare(songCountsSql(env, endsAt)).all()]);
  const byCode = new Map((counts.results ?? []).map((r) => [r.code, r]));
  return csvResponse(toCsv(SONGS_HEADER, songRows(songs, byCode)), `topbarz-songs-${stamp(now)}.csv`);
}
