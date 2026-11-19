// The holiday contest's song flow (Scooter, 17 Nov 2026, and his consolidated revision list of
// 18 Nov 2026, which wins where they differ): the song on /track, and its going into the vote by
// itself. The second door from the booth onto the vote, beside scripts/promote-booth.mjs; both
// refuse the same things.
//
// Who is on a song: exactly the people the brand ambassador tapped into the booth and out for that
// recording (a take, functions/_lib/party.js), put on it by the engineer's upload, each by their one
// record (booth_people.guest_id), never by a match on a typed email or phone. The team re-points a
// song that landed on the wrong people, and every re-point is kept (booth_repoints). Typing a song's
// code with an email lets anyone hear and download it, and see who has access; it never puts them on.
//
// Managing a song is first come (Scooter: "Whoever manages the song first - artwork, contest entry -
// keeps those controls. No group-wide confirmation needed."): the first person on the song to add
// artwork, set the title, tick Enter or Share it is its manager; the others hear, download and share
// a song already shared. The manager ticks "Enter the contest" (agreeing to the linked rules) and the
// song is in the vote by itself, solo or group; unticking takes it out (active = 0; likes kept). The
// team can pull any song from /team. After the end nothing moves.
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
// somebody is on it; its manager ticked Enter.
// → { ok, reason, message, step: "not_entered" | "in" | null }.
export function contestVerdict({ track, people, production } = {}) {
  const rows = Array.isArray(people) ? people : [];
  const no = (reason, message, step = null) => ({ ok: false, reason, message, step });
  if (!track || typeof track !== "object") return no("no_such_code", "no booth track has that code");
  const file = String(track.file_name ?? "");
  const where = isScooterTaylor(file.replace(/\.[^.]+$/, "")) ? "file" : isScooterTaylor(String(track.title ?? "")) ? "title" : rows.some((r) => r.name && isScooterTaylor(String(r.name))) ? "person" : null;
  if (where) return { ...no("scooter_taylor", "Scooter Taylor's track is never in the vote"), where };
  if (production && isTestName(file)) return no("test_file_in_production", "test files go to preview only, never production");
  if (track.pulled_at) return no("pulled_by_team", "the team took this song out of the vote");
  if (rows.length === 0) return no("nobody_attached", "nobody is on this song yet: the team puts its people on it from /team");
  if (!track.contest_entered_at) return no("not_entered", "nobody on this song has entered it yet", "not_entered");
  return { ok: true, reason: "entered", message: "entered", step: "in" };
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
export const CONTEST_TRACK_SQL = "SELECT id, code, file_name, media_key, title, vote_track_id, party_session_id, party_take_id, pulled_at, manager_email, manager_at, contest_entered_by, contest_entered_at FROM booth_tracks WHERE code = ?1";
// The entry: ticked (who, when, which rules) by the manager. Unticking clears it.
export const ENTER_SQL = "UPDATE booth_tracks SET contest_entered_by = COALESCE(contest_entered_by, ?2), contest_entered_at = COALESCE(contest_entered_at, ?3), contest_rules_version = ?4 WHERE id = ?1";
export const WITHDRAW_SQL = "UPDATE booth_tracks SET contest_entered_by = NULL, contest_entered_at = NULL, contest_rules_version = NULL, contest_confirmed_by = NULL, contest_confirmed_at = NULL WHERE id = ?1";
export const MARK_PERSON_SQL = "UPDATE booth_people SET contest_opt_in = 1, contest_at = ?3, rules_version = ?4 WHERE track_id = ?1 AND email = ?2";
export const UNMARK_ALL_SQL = "UPDATE booth_people SET contest_opt_in = 0, contest_at = NULL, rules_version = NULL WHERE track_id = ?1";
// First come: the first person on the song to manage it becomes its manager; nobody else after.
export const CLAIM_MANAGER_SQL = "UPDATE booth_tracks SET manager_email = ?2, manager_at = ?3 WHERE id = ?1 AND manager_email IS NULL";
export const MANAGER_OF_SQL = "SELECT manager_email FROM booth_tracks WHERE id = ?1";
// A person's name: from their one record when the upload or the team put them on by it
// (guest_id), else (rows from before 18 Nov 2026) the sign-up of that same address.
const NAME_OF = "COALESCE((SELECT g.name FROM party_guests g WHERE g.id = p.guest_id), CASE WHEN p.guest_id IS NULL THEN (SELECT g.name FROM party_guests g WHERE g.email = p.email) END)";
// The team's songs: every song that is or could be in the contest (in the vote now or pulled, from a
// take or a group, or with anyone on it who signed up), entered or not, and every song uploaded in
// the last two days with nobody on it, so a song needing its people is in front of the team.
export const TEAM_SONGS_SQL = `SELECT b.id, b.code, b.title, b.file_name, b.uploaded_at, b.party_session_id, b.party_take_id, b.pulled_at, b.contest_entered_at, b.manager_email, t.label, t.active,
  (SELECT g.name FROM party_guests g WHERE g.email = b.contest_entered_by) AS entered_by_name,
  (SELECT g.name FROM party_guests g WHERE g.email = b.manager_email) AS manager_name,
  (SELECT COUNT(*) FROM booth_people p WHERE p.track_id = b.id) AS people
  FROM booth_tracks b LEFT JOIN tracks t ON t.id = b.vote_track_id
  WHERE b.vote_track_id IS NOT NULL OR b.party_session_id IS NOT NULL OR b.party_take_id IS NOT NULL
     OR EXISTS (SELECT 1 FROM booth_people p JOIN party_guests g ON g.id = p.guest_id OR (p.guest_id IS NULL AND g.email = p.email) WHERE p.track_id = b.id)
     OR (b.uploaded_at > (CAST(strftime('%s', 'now') AS INTEGER) - 172800) * 1000 AND NOT EXISTS (SELECT 1 FROM booth_people p WHERE p.track_id = b.id))
  ORDER BY b.uploaded_at DESC, b.id DESC LIMIT 200`;
// One song's people for the team: their record and name. Never the email here (the team reads
// contact details from the line, where they are already answered to the team only).
export const TEAM_SONG_PEOPLE_SQL = `SELECT p.id, p.guest_id, p.email, p.attached_at, ${NAME_OF} AS name FROM booth_people p WHERE p.track_id = ?1 ORDER BY p.attached_at, p.id`;
export const REPOINTS_SQL = "SELECT r.at, r.before_json, r.after_json, r.note, m.email AS by_email FROM booth_repoints r LEFT JOIN team_members m ON m.id = r.member_id WHERE r.track_id = ?1 ORDER BY r.at DESC, r.id DESC LIMIT 10";
// Take out (pulled_at set, with who) or put back (NULL). Likes are kept either way.
export const PULL_SQL = "UPDATE booth_tracks SET pulled_at = ?2, pulled_by = ?3 WHERE code = ?1 AND vote_track_id IS NOT NULL RETURNING code";
// The people of a song with what the contest needs: their record, their name and their box. Their
// emails stay here: only `you` is ever matched against one, and none is answered.
export const CONTEST_PEOPLE_SQL = `SELECT p.email, p.guest_id, p.contest_opt_in, p.attached_at, ${NAME_OF} AS name FROM booth_people p WHERE p.track_id = ?1 ORDER BY p.attached_at, p.id`;
export const TITLE_SQL = "UPDATE booth_tracks SET title = ?2 WHERE id = ?1";
// The upload, from a take: the song's people by their one record, the take claimed, each person done.
export const ATTACH_PERSON_SQL = "INSERT OR IGNORE INTO booth_people (track_id, email, attached_at, guest_id) VALUES (?1, ?2, ?3, ?4)";
export const TAG_TAKE_SQL = "UPDATE booth_tracks SET party_take_id = ?2 WHERE id = ?1";
export const SESSION_DONE_SQL = "UPDATE party_sessions SET done_at = ?2 WHERE id = ?1 AND done_at IS NULL";
// The upload as a line event (member_id 0: the booth page, not a team member).
export const UPLOAD_EVENT_SQL = "INSERT INTO party_status_events (session_id, from_status, to_status, member_id, at) VALUES (?1, 'upload', 'done', 0, ?2)";
// The team's re-point: the song's people become exactly the records picked.
export const DETACH_ALL_SQL = "DELETE FROM booth_people WHERE track_id = ?1";
export const GUESTS_BY_ID_SQL = "SELECT id, name, email FROM party_guests WHERE id = ?1";
export const REPOINT_LOG_SQL = "INSERT INTO booth_repoints (track_id, member_id, at, before_json, after_json, note) VALUES (?1, ?2, ?3, ?4, ?5, ?6)";
// A manager no longer on the song stops managing it (the next person on it to manage takes over).
export const DROP_GONE_MANAGER_SQL = "UPDATE booth_tracks SET manager_email = NULL, manager_at = NULL WHERE id = ?1 AND manager_email IS NOT NULL AND NOT EXISTS (SELECT 1 FROM booth_people p WHERE p.track_id = ?1 AND p.email = booth_tracks.manager_email)";
// Everyone who has signed up, for the team's re-point picker (team only).
export const ALL_GUESTS_SQL = "SELECT id, name, email, phone, joined_at FROM party_guests ORDER BY joined_at DESC, id DESC LIMIT 300";

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

// Who manages the song (first come), as the asker may see it: their first name, and whether it is
// the asker. → { manager: first name | null, you_manage: bool }.
const managerOf = (track, people, email) => {
  if (!track.manager_email) return { manager: null, you_manage: false };
  const p = people.find((x) => x.email === track.manager_email);
  return { manager: p?.name ? firstOf(p.name) : COPY_SOMEONE, you_manage: Boolean(email) && track.manager_email === email };
};
const COPY_SOMEONE = "someone on the song";

// What /track sees, the same for everyone with the code: who has access (first names), who manages
// it, whether it is entered and by whom. `you.performer` says whether the asker is one of the song's
// people (they may manage it if nobody does yet); `you.manager` whether they are its manager. First
// names only; the one email is the asker's own, and it is not in here.
export function contestView(song, email, { entered, closed, production }) {
  const { track, people } = song;
  const verdict = contestVerdict({ track, people, production });
  const me = people.find((p) => p.email === email);
  const { manager, you_manage } = managerOf(track, people, email);
  const entrant = people.find((p) => p.email === track.contest_entered_by);
  return {
    on: true,
    rules_url: RULES_PATH,
    title: track.title ?? "",
    entered: Boolean(entered),
    closed: Boolean(closed),
    ticked: Boolean(track.contest_entered_at),
    ticked_by: track.contest_entered_at ? (entrant?.name ? firstOf(entrant.name) : COPY_SOMEONE) : null,
    step: verdict.step,
    manager,
    you: { performer: Boolean(me), manager: you_manage, can_manage: Boolean(me) && (you_manage || !track.manager_email), signed_up: Boolean(me?.name) },
    nobody: people.length === 0, // nobody on it yet: the team puts its people on it from /team
    // "Jeff, John and Scooter have access to this song" (Scooter, 18 Nov 2026).
    access: people.map((p) => (p.name ? firstOf(p.name) : null)).filter(Boolean),
    people: people.map((p) => ({ first_name: p.name ? firstOf(p.name) : null, you: p.email === email })),
    blocked: ["scooter_taylor", "test_file_in_production", "pulled_by_team"].includes(verdict.reason) ? verdict.reason : null,
    // Where the page says it: a preview's test entry, or the live site (Scooter, 18 Nov 2026: neutral
    // words, "No policy framing, and nothing about who can or cannot enter").
    production: Boolean(production),
  };
}
export { holidayOn };

// The team's view of one song on /team: its name in the vote (or, never entered, its title, its
// people's first names, or its file), in or out, who is on it, who manages it, and its re-points.
export const teamSong = (row, people = [], repoints = []) => ({
  code: row.code,
  label: row.label || cleanTitle(row.title ?? "") || groupLabel(people.filter((p) => p.name).map((p) => firstOf(p.name))) || String(row.file_name ?? "").replace(/\.[^.]+$/, "") || row.code,
  file_name: row.file_name,
  uploaded_at: row.uploaded_at ? new Date(row.uploaded_at).toISOString() : null,
  entered: row.active === 1,
  pulled: Boolean(row.pulled_at),
  pulled_at: row.pulled_at ? new Date(row.pulled_at).toISOString() : null,
  people: row.people,
  needs_people: row.people === 0,
  ticked: Boolean(row.contest_entered_at),
  ticked_by: row.contest_entered_at && row.entered_by_name ? firstOf(row.entered_by_name) : null,
  manager: row.manager_email ? (row.manager_name ? firstOf(row.manager_name) : COPY_SOMEONE) : null,
  members: people.map((p) => ({ id: p.id, guest_id: p.guest_id ?? null, name: p.name ?? null, first_name: p.name ? firstOf(p.name) : null, signed_up: Boolean(p.name), attached_at: new Date(p.attached_at).toISOString() })),
  repoints: repoints.map((r) => ({ at: new Date(r.at).toISOString(), by: r.by_email ?? null, before: namesIn(r.before_json), after: namesIn(r.after_json), note: r.note || "" })),
});
const namesIn = (json) => { try { return (JSON.parse(json) ?? []).map((p) => p.name ?? "").filter(Boolean); } catch { return []; } };

// The team's songs with their people and re-points, in one round trip each.
export async function teamSongs(db) {
  const rows = (await db.prepare(TEAM_SONGS_SQL).all()).results ?? [];
  if (rows.length === 0) return [];
  const [people, repoints] = await Promise.all([
    db.batch(rows.map((r) => db.prepare(TEAM_SONG_PEOPLE_SQL).bind(r.id))),
    db.batch(rows.map((r) => db.prepare(REPOINTS_SQL).bind(r.id))),
  ]);
  return rows.map((r, i) => teamSong(r, people[i].results ?? [], repoints[i].results ?? []));
}

// First come: the first person on the song to manage it becomes its manager. → true when the asker
// manages it now (just claimed, or already theirs); false when someone else does.
export async function claimManager(db, trackId, email, now = Date.now()) {
  await db.prepare(CLAIM_MANAGER_SQL).bind(trackId, email, now).run();
  return (await db.prepare(MANAGER_OF_SQL).bind(trackId).first())?.manager_email === email;
}
