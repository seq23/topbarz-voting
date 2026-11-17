// The holiday contest's song flow (Scooter, 17 Nov 2026): "Enter the contest" on /track, and the
// song going into the vote by itself. The second door from the booth onto the vote, beside
// scripts/promote-booth.mjs; both refuse the same things, and this one adds two:
//
//   · every person attached to the song has ticked their OWN box, agreeing to the linked rules
//     (one person's box never speaks for the group, even if the others never open the page);
//   · every person attached signed up at /join (the contest needs a name and a number to reach);
//   · the team has not taken it out from /team (pulled_at; it stays out until the team puts it back).
//
// A tick counts only from the phone that signed up: it carries that guest's own key (localStorage
// tbz.party.guest), and the key's email must be the email being ticked. Knowing the code and a
// friend's email is not enough to tick their box.
//
// The people of a song: the session the engineer tagged at upload (attached at once, so a friend
// who never opens /track still counts as "waiting"), plus anyone who enters the code with their
// email. Unticking before voting ends takes the song back out (active = 0; its likes are kept).
// After the end nothing moves. Reads booth_tracks, booth_people and party_guests; writes the
// vote's tracks only through syncEntry below.
import { allIn } from "./booth.js";
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

// The verdict, pure. people: [{ name (from the sign-up, or null), contest_opt_in }]. In this
// order: the track exists; nothing about it is Scooter Taylor's (the file, the title or anyone on
// it); production takes no "Test …" file; somebody is attached; everybody signed up; everybody
// agreed. → { ok, reason, message, waiting_on: [first names] }.
export function contestVerdict({ track, people, production } = {}) {
  const rows = Array.isArray(people) ? people : [];
  const no = (reason, message, extra = {}) => ({ ok: false, reason, message, waiting_on: [], ...extra });
  if (!track || typeof track !== "object") return no("no_such_code", "no booth track has that code");
  const file = String(track.file_name ?? "");
  const names = [file.replace(/\.[^.]+$/, ""), String(track.title ?? ""), ...rows.map((r) => String(r.name ?? ""))];
  if (names.some((n) => n && isScooterTaylor(n))) return no("scooter_taylor", "Scooter Taylor's track is never in the vote");
  if (production && isTestName(file)) return no("test_file_in_production", "test files go to preview only, never production");
  if (track.pulled_at) return no("pulled_by_team", "the team took this song out of the vote");
  if (rows.length === 0) return no("nobody_attached", "nobody is attached to this song yet");
  const unsigned = rows.filter((r) => !r.name);
  if (unsigned.length) return no("not_signed_up", `${unsigned.length} ${unsigned.length === 1 ? "person on this song has" : "people on this song have"} not signed up at /join`, { waiting_on: rows.filter((r) => r.contest_opt_in !== 1).map((r) => (r.name ? firstOf(r.name) : "someone")) });
  const out = rows.filter((r) => r.contest_opt_in !== 1);
  if (!allIn(rows.length, rows.length - out.length)) return no("not_everyone_in", `${out.length} of the ${rows.length} people on this song ${out.length === 1 ? "has" : "have"} not entered; the contest is everyone's consent`, { waiting_on: out.map((r) => firstOf(r.name)) });
  return { ok: true, reason: "everyone_in", message: `all ${rows.length} on this song entered the contest`, waiting_on: [] };
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
export const CONTEST_TRACK_SQL = "SELECT id, code, file_name, media_key, title, vote_track_id, party_session_id, pulled_at FROM booth_tracks WHERE code = ?1";
// The email a guest key signed up with: a tick is taken only from that guest's own phone.
export const GUEST_EMAIL_BY_KEY_SQL = "SELECT email FROM party_guests WHERE guest_key = ?1";
// The team's list of contest songs: every song that has been in the vote (in now, or pulled),
// with counts only (never an email) and the first names come from CONTEST_PEOPLE_SQL per song.
export const TEAM_SONGS_SQL = `SELECT b.code, b.title, b.pulled_at, t.label, t.active,
  (SELECT COUNT(*) FROM booth_people p WHERE p.track_id = b.id) AS people,
  (SELECT COUNT(*) FROM booth_people p WHERE p.track_id = b.id AND p.contest_opt_in = 1) AS ticked
  FROM booth_tracks b JOIN tracks t ON t.id = b.vote_track_id ORDER BY b.uploaded_at DESC, b.id DESC LIMIT 200`;
// Take out (pulled_at set, with who) or put back (NULL). Likes are kept either way.
export const PULL_SQL = "UPDATE booth_tracks SET pulled_at = ?2, pulled_by = ?3 WHERE code = ?1 AND vote_track_id IS NOT NULL RETURNING code";
// The people of a song with what the contest needs: their sign-up name (NULL when not signed up)
// and their own box. Their emails stay here: only `you` is ever answered with one.
export const CONTEST_PEOPLE_SQL = `SELECT p.email, p.contest_opt_in, p.attached_at, g.name FROM booth_people p LEFT JOIN party_guests g ON g.email = p.email WHERE p.track_id = ?1 ORDER BY p.attached_at, p.id`;
export const CONTEST_SET_SQL = "UPDATE booth_people SET contest_opt_in = ?3, contest_at = ?4, rules_version = ?5 WHERE track_id = ?1 AND email = ?2 RETURNING contest_opt_in";
export const TITLE_SQL = "UPDATE booth_tracks SET title = ?2 WHERE id = ?1";
// The session the engineer tagged: only one that is in the booth right now.
export const BOOTH_SESSION_SQL = "SELECT id FROM party_sessions WHERE id = ?1 AND status = 'booth'";
export const SESSION_EMAILS_SQL = "SELECT email FROM party_guests WHERE session_id = ?1 ORDER BY joined_at, id";
export const ATTACH_TAGGED_SQL = "INSERT OR IGNORE INTO booth_people (track_id, email, attached_at) VALUES (?1, ?2, ?3)";
export const TAG_SQL = "UPDATE booth_tracks SET party_session_id = ?2 WHERE id = ?1";
// The groups an engineer can tag: those the team has marked green, first names only.
export const IN_BOOTH_SQL = "SELECT s.id, g.name FROM party_sessions s JOIN party_guests g ON g.session_id = s.id WHERE s.status = 'booth' ORDER BY s.status_at, s.id, g.joined_at, g.id";

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

// What every person on the song sees under the box: first names with In or Waiting, whether the
// song is in, and who it waits on. First names only; the one email is the asker's own (`you`).
export function contestView(song, email, { entered, closed, production }) {
  const { track, people } = song;
  const verdict = contestVerdict({ track, people, production });
  return {
    on: true,
    rules_url: RULES_PATH,
    title: track.title ?? "",
    entered: Boolean(entered),
    closed: Boolean(closed),
    you: { in: people.find((p) => p.email === email)?.contest_opt_in === 1, signed_up: Boolean(people.find((p) => p.email === email)?.name) },
    people: people.map((p) => ({ first_name: p.name ? firstOf(p.name) : null, in: p.contest_opt_in === 1, you: p.email === email })),
    waiting_on: verdict.waiting_on,
    blocked: ["scooter_taylor", "test_file_in_production", "pulled_by_team"].includes(verdict.reason) ? verdict.reason : null,
  };
}
export { holidayOn };

// The team's view of one song on /team: its name in the vote, in or out, and who it waits on.
export const teamSong = (row) => ({
  code: row.code,
  label: row.label,
  entered: row.active === 1,
  pulled: Boolean(row.pulled_at),
  pulled_at: row.pulled_at ? new Date(row.pulled_at).toISOString() : null,
  people: row.people,
  ticked: row.ticked,
});
