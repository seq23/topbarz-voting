// The holiday contest's song flow (Scooter, 17 Nov 2026, with his preview notes the same day):
// "Enter the contest" on /track, and the song going into the vote by itself. The second door from
// the booth onto the vote, beside scripts/promote-booth.mjs; both refuse the same things.
//
// Who is on a song: the group the engineer picked from the upload station when he uploaded it
// (functions/api/booth/[[path]].js). Typing a song's code lets someone hear and download it and
// nothing more: it never puts them on the song (Scooter: "never attach them to it as a performer").
//
// The entry is the song's, made by someone on it (Scooter's flow, preview only until he settles the
// waiver question): they tick Enter (agreeing to the linked rules); on a solo song that is the
// entry; on a group song they also tick "Confirmed with your group", saying the group agreed, and
// that is the entry. Who ticked, who confirmed, when and which rules are kept on the booth row and
// shown by first name to everyone on the song, so nobody's box speaks for the group in silence.
// Anyone on the song can untick Enter, which takes it back out for everyone (active = 0; likes are
// kept). The team can pull any song from /team. After the end nothing moves. Reads booth_tracks,
// booth_people and party_guests; writes the vote's tracks only through syncEntry below.
import { END_SETTING_SQL, START_SETTING_SQL, votingPhase } from "./config.js";
import { isScooterTaylor, isTestName } from "./exclusions.js";
import { RULES_PATH, firstOf, groupLabel, holidayOn } from "./party.js";

export const TITLE_MAX = 60;

// A song's title as kept: printable, single-spaced, at most 60 characters. "" clears it.
export function cleanTitle(raw) {
  if (typeof raw !== "string") return null;
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, TITLE_MAX).trim();
}

// The verdict, pure. track: the booth row (with its contest_* columns); people: [{ name (from the
// sign-up, or null) }]. In this order: the track exists; nothing about it is Scooter Taylor's (the
// file, the title or anyone on it); production takes no "Test …" file; the team has not pulled it;
// somebody is on it; someone on it ticked Enter; a group song is confirmed with the group.
// → { ok, reason, message, step: "not_entered" | "needs_group" | "in" | null }.
export function contestVerdict({ track, people, production } = {}) {
  const rows = Array.isArray(people) ? people : [];
  const no = (reason, message, step = null) => ({ ok: false, reason, message, step });
  if (!track || typeof track !== "object") return no("no_such_code", "no booth track has that code");
  const file = String(track.file_name ?? "");
  const names = [file.replace(/\.[^.]+$/, ""), String(track.title ?? ""), ...rows.map((r) => String(r.name ?? ""))];
  if (names.some((n) => n && isScooterTaylor(n))) return no("scooter_taylor", "Scooter Taylor's track is never in the vote");
  if (production && isTestName(file)) return no("test_file_in_production", "test files go to preview only, never production");
  if (track.pulled_at) return no("pulled_by_team", "the team took this song out of the vote");
  if (rows.length === 0) return no("nobody_attached", "nobody is on this song: the engineer did not pick a group when it was uploaded");
  if (!track.contest_entered_at) return no("not_entered", "nobody on this song has entered it yet", "not_entered");
  if (rows.length > 1 && !track.contest_confirmed_at) return no("needs_group", "entered, but not yet confirmed with the group", "needs_group");
  return { ok: true, reason: "entered", message: rows.length > 1 ? `entered and confirmed with the group of ${rows.length}` : "entered", step: "in" };
}

// The song's name in the vote: its title, else the group's first names ("Jay, Mo & Kim").
export const voteLabel = (track, people) => cleanTitle(track?.title ?? "") || groupLabel(people.map((p) => firstOf(p.name))) || "Holiday song";

const slugify = (s) => String(s).normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
// A slug no other track has (a slug is a link people have texted, so one given is never changed).
export function freshSlug(label, taken) {
  const base = slugify(label) || "song";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

// ── I/O ──────────────────────────────────────────────────────────────────────────────────────
export const CONTEST_TRACK_SQL = "SELECT id, code, file_name, media_key, title, vote_track_id, party_session_id, pulled_at, contest_entered_by, contest_entered_at, contest_confirmed_by, contest_confirmed_at FROM booth_tracks WHERE code = ?1";
// The entry: ticked (who, when, which rules) and, for a group, confirmed (who, when). Unticking
// Enter clears both; unticking the confirmation clears only that. A person who ticked or confirmed
// is marked on their own booth_people row too (contest_opt_in), so the team cannot remove them.
export const ENTER_SQL = "UPDATE booth_tracks SET contest_entered_by = COALESCE(contest_entered_by, ?2), contest_entered_at = COALESCE(contest_entered_at, ?3), contest_rules_version = ?4 WHERE id = ?1";
export const CONFIRM_SQL = "UPDATE booth_tracks SET contest_confirmed_by = ?2, contest_confirmed_at = ?3 WHERE id = ?1";
export const WITHDRAW_SQL = "UPDATE booth_tracks SET contest_entered_by = NULL, contest_entered_at = NULL, contest_rules_version = NULL, contest_confirmed_by = NULL, contest_confirmed_at = NULL WHERE id = ?1";
export const MARK_PERSON_SQL = "UPDATE booth_people SET contest_opt_in = 1, contest_at = ?3, rules_version = ?4 WHERE track_id = ?1 AND email = ?2";
export const UNMARK_ALL_SQL = "UPDATE booth_people SET contest_opt_in = 0, contest_at = NULL, rules_version = NULL WHERE track_id = ?1";
// The team's list of contest songs: every song that is or could be in the contest (in the vote
// now or pulled, tagged with a session at upload, or with anyone on it who signed up at /join),
// entered or not, so a song stuck waiting is in front of the team. Counts only (never an email);
// the people come from TEAM_SONG_PEOPLE_SQL per song.
export const TEAM_SONGS_SQL = `SELECT b.id, b.code, b.title, b.file_name, b.party_session_id, b.pulled_at, b.contest_entered_at, b.contest_confirmed_at, t.label, t.active,
  (SELECT g.name FROM party_guests g WHERE g.email = b.contest_entered_by) AS entered_by_name,
  (SELECT g.name FROM party_guests g WHERE g.email = b.contest_confirmed_by) AS confirmed_by_name,
  (SELECT COUNT(*) FROM booth_people p WHERE p.track_id = b.id) AS people
  FROM booth_tracks b LEFT JOIN tracks t ON t.id = b.vote_track_id
  WHERE b.vote_track_id IS NOT NULL OR b.party_session_id IS NOT NULL
     OR EXISTS (SELECT 1 FROM booth_people p JOIN party_guests g ON g.email = p.email WHERE p.track_id = b.id)
     OR (b.party_session_id IS NULL AND b.uploaded_at > (CAST(strftime('%s', 'now') AS INTEGER) - 172800) * 1000
         AND NOT EXISTS (SELECT 1 FROM booth_people p WHERE p.track_id = b.id))
  ORDER BY b.uploaded_at DESC, b.id DESC LIMIT 200`;
// One song's people for the team: the row id (what Remove names), the box, and the sign-up name
// (NULL when not signed up). Never the email: a booth email is shown to its owner only.
export const TEAM_SONG_PEOPLE_SQL = "SELECT p.id, p.contest_opt_in, p.attached_at, g.name FROM booth_people p LEFT JOIN party_guests g ON g.email = p.email WHERE p.track_id = ?1 ORDER BY p.attached_at, p.id";
// The team takes someone off a song: only a person who has NOT ticked (a tick is that person's own
// consent, and removing it is theirs to do). One person of one track. They can enter the code
// again; they are then a late joiner as before.
export const PERSON_ON_SONG_SQL = "SELECT contest_opt_in FROM booth_people WHERE track_id = ?1 AND id = ?2";
export const DETACH_SQL = "DELETE FROM booth_people WHERE track_id = ?1 AND id = ?2 AND contest_opt_in = 0 RETURNING id";
// Take out (pulled_at set, with who) or put back (NULL). Likes are kept either way.
export const PULL_SQL = "UPDATE booth_tracks SET pulled_at = ?2, pulled_by = ?3 WHERE code = ?1 AND vote_track_id IS NOT NULL RETURNING code";
// The people of a song with what the contest needs: their sign-up name (NULL when not signed up)
// and their own box. Their emails stay here: only `you` is ever answered with one.
export const CONTEST_PEOPLE_SQL = `SELECT p.email, p.contest_opt_in, p.attached_at, g.name FROM booth_people p LEFT JOIN party_guests g ON g.email = p.email WHERE p.track_id = ?1 ORDER BY p.attached_at, p.id`;
export const TITLE_SQL = "UPDATE booth_tracks SET title = ?2 WHERE id = ?1";
// The group the engineer picks: only one at the upload station (out of the booth, its song not
// uploaded yet). The upload moves it to done.
export const BOOTH_SESSION_SQL = "SELECT id FROM party_sessions WHERE id = ?1 AND status = 'out' AND done_at IS NULL";
export const SESSION_DONE_SQL = "UPDATE party_sessions SET done_at = ?2 WHERE id = ?1 AND done_at IS NULL";
// The upload as a line event (member_id 0: the booth page, not a team member).
export const UPLOAD_EVENT_SQL = "INSERT INTO party_status_events (session_id, from_status, to_status, member_id, at) VALUES (?1, 'upload', 'done', 0, ?2)";
export const SESSION_EMAILS_SQL = "SELECT email FROM party_guests WHERE session_id = ?1 ORDER BY joined_at, id";
export const ATTACH_TAGGED_SQL = "INSERT OR IGNORE INTO booth_people (track_id, email, attached_at) VALUES (?1, ?2, ?3)";
export const TAG_SQL = "UPDATE booth_tracks SET party_session_id = ?2 WHERE id = ?1";
// The team puts a group on a song uploaded with nobody on it (the engineer uploaded before the group
// reached the upload station, or a walk-up who signed up afterwards): any group whose song is not
// uploaded yet (waiting, in the booth or at the upload station). The song must still have nobody on
// it and no group; the group then moves to done, as an upload would have moved it.
export const ASSIGN_SESSION_SQL = "SELECT id, status, done_at FROM party_sessions WHERE id = ?1";
export const ASSIGN_TAG_SQL = "UPDATE booth_tracks SET party_session_id = ?2 WHERE id = ?1 AND party_session_id IS NULL AND NOT EXISTS (SELECT 1 FROM booth_people p WHERE p.track_id = ?1)";
export const ASSIGN_DONE_SQL = "UPDATE party_sessions SET status = 'out', status_at = ?2, done_at = ?2 WHERE id = ?1 AND done_at IS NULL";
export const SONG_PEOPLE_COUNT_SQL = "SELECT COUNT(*) AS n FROM booth_people WHERE track_id = ?1";
// The groups an engineer can pick: those at the upload station, the longest waiting first, first names only.
export const IN_BOOTH_SQL = "SELECT s.id, s.status_at, g.name FROM party_sessions s JOIN party_guests g ON g.session_id = s.id WHERE s.status = 'out' AND s.done_at IS NULL ORDER BY s.status_at, s.id, g.joined_at, g.id";

// Whether the song is in the vote right now (its vote track is active).
export async function isEntered(db, track) {
  return track.vote_track_id ? (await db.prepare("SELECT active FROM tracks WHERE id = ?1").bind(track.vote_track_id).first())?.active === 1 : false;
}

export async function readSong(db, code) {
  const track = await db.prepare(CONTEST_TRACK_SQL).bind(code).first();
  if (!track) return null;
  const people = (await db.prepare(CONTEST_PEOPLE_SQL).bind(track.id).all()).results ?? [];
  return { track, people };
}

async function isClosed(env, now) {
  const [start, end] = await env.DB.batch([env.DB.prepare(START_SETTING_SQL), env.DB.prepare(END_SETTING_SQL)]);
  return votingPhase(env, now, start.results?.[0]?.value ?? null, end.results?.[0]?.value ?? null).closed;
}
export const contestClosed = isClosed;

// Puts the song in the vote, or takes it out, to match the verdict. Before the end only: after it
// nothing moves (the result is the result). → { entered, verdict }.
export async function syncEntry(env, song, now = Date.now()) {
  const db = env.DB;
  const { track, people } = song;
  const verdict = contestVerdict({ track, people, production: env.APP_ENV === "production" });
  const current = track.vote_track_id ? await db.prepare("SELECT id, active FROM tracks WHERE id = ?1").bind(track.vote_track_id).first() : null;
  if (await isClosed(env, now)) return { entered: current?.active === 1, verdict };
  const iso = new Date(now).toISOString();
  if (!verdict.ok) {
    if (current?.active === 1) await db.prepare("UPDATE tracks SET active = 0, updated_at = ?2 WHERE id = ?1").bind(current.id, iso).run();
    return { entered: false, verdict };
  }
  const label = voteLabel(track, people);
  if (current) {
    await db.prepare("UPDATE tracks SET active = 1, label = ?2, updated_at = ?3 WHERE id = ?1").bind(current.id, label, iso).run();
    return { entered: true, verdict };
  }
  const existing = (await db.prepare("SELECT slug, sort FROM tracks").all()).results ?? [];
  const slug = freshSlug(label, new Set(existing.map((t) => t.slug)));
  const sort = existing.reduce((m, t) => Math.max(m, t.sort), 0) + 10;
  // source_name is the booth row's own id, so two engineers' files both called "Take 1.wav" are two songs.
  const row = await db.prepare(
    `INSERT INTO tracks (slug, label, source_name, audio_key, duration_ms, sort, active, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, NULL, ?5, 1, ?6, ?6)
     ON CONFLICT (source_name) DO UPDATE SET active = 1, label = excluded.label, updated_at = excluded.updated_at RETURNING id`,
  ).bind(slug, label, `booth:${track.id}`, track.media_key, sort, iso).first();
  await db.prepare("UPDATE booth_tracks SET vote_track_id = ?2 WHERE id = ?1").bind(track.id, row.id).run();
  return { entered: true, verdict };
}

// What the page sees under the box, the same for everyone on the song: whether it is entered,
// who ticked and who confirmed (first names), and the people on it. `you.performer` says whether the
// asker is on the song at all: someone who only typed the code hears and downloads, nothing more.
// First names only; the one email is the asker's own, and it is not in here.
export function contestView(song, email, { entered, closed, production }) {
  const { track, people } = song;
  const verdict = contestVerdict({ track, people, production });
  const nameOf = (e) => { const p = people.find((x) => x.email === e); return p?.name ? firstOf(p.name) : null; };
  const me = people.find((p) => p.email === email);
  return {
    on: true,
    rules_url: RULES_PATH,
    title: track.title ?? "",
    entered: Boolean(entered),
    closed: Boolean(closed),
    group: people.length > 1,
    ticked: Boolean(track.contest_entered_at),
    confirmed: Boolean(track.contest_confirmed_at),
    ticked_by: track.contest_entered_at ? nameOf(track.contest_entered_by) : null,
    confirmed_by: track.contest_confirmed_at ? nameOf(track.contest_confirmed_by) : null,
    step: verdict.step,
    you: { performer: Boolean(me), signed_up: Boolean(me?.name) },
    nobody: people.length === 0, // no group on it yet: the team puts one on from /team
    people: people.map((p) => ({ first_name: p.name ? firstOf(p.name) : null, you: p.email === email })),
    blocked: ["scooter_taylor", "test_file_in_production", "pulled_by_team"].includes(verdict.reason) ? verdict.reason : null,
  };
}
export { holidayOn };

// The team's view of one song on /team: its name in the vote (or, never entered, its title, its
// people's first names, or its file), in or out, who is on it and who it waits on.
export const teamSong = (row, people = []) => ({
  code: row.code,
  label: row.label || cleanTitle(row.title ?? "") || groupLabel(people.filter((p) => p.name).map((p) => firstOf(p.name))) || String(row.file_name ?? "").replace(/\.[^.]+$/, "") || row.code,
  entered: row.active === 1,
  pulled: Boolean(row.pulled_at),
  pulled_at: row.pulled_at ? new Date(row.pulled_at).toISOString() : null,
  people: row.people,
  // Nobody on it and no group: the team picks the group that recorded it (POST …/songs/<code>/group).
  needs_group: row.people === 0 && !row.party_session_id,
  ticked: Boolean(row.contest_entered_at),
  confirmed: Boolean(row.contest_confirmed_at),
  ticked_by: row.contest_entered_at && row.entered_by_name ? firstOf(row.entered_by_name) : null,
  confirmed_by: row.contest_confirmed_at && row.confirmed_by_name ? firstOf(row.confirmed_by_name) : null,
  members: people.map((p) => ({ id: p.id, first_name: p.name ? firstOf(p.name) : null, signed_up: Boolean(p.name), in: p.contest_opt_in === 1, attached_at: new Date(p.attached_at).toISOString() })),
});

// The team's songs with their people, in one round trip for the people.
export async function teamSongs(db) {
  const rows = (await db.prepare(TEAM_SONGS_SQL).all()).results ?? [];
  if (rows.length === 0) return [];
  const people = await db.batch(rows.map((r) => db.prepare(TEAM_SONG_PEOPLE_SQL).bind(r.id)));
  return rows.map((r, i) => teamSong(r, people[i].results ?? []));
}
