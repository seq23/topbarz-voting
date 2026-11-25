// The holiday party's rules with no request in them (Scooter, 17 Nov 2026): the switch, what a
// sign-up is, what a session code is, what the line looks like, and what the team may change.
// Used by functions/api/party/[[path]].js, functions/_lib/contest.js and functions/_lib/state.js.
// Guest data (name, phone, email, city, Instagram) lives in party_guests and is answered to the
// signed-in team only; the public routes answer first names and places in line, never a phone
// number or an email (tests/party.test.mjs).
import { cleanEmail } from "./booth.js";
import { cleanPhone, cleanText } from "./entries.js";

// THE switch: "on" in preview, "off" in production until Scooter says go live (wrangler.toml).
// Off, the party's pages say "Nothing on right now" and its routes answer 404 party_off.
export const holidayOn = (env) => env?.HOLIDAY_EVENT === "on";

// While the party is on, the vote is the party's own songs only: those a booth song put in itself
// (syncEntry gives them source_name "booth:<id>"). The CultureCon tracks stay in the database,
// untouched, and simply are not in /api/state, cannot be liked or commented on, and are not in
// `npm run export -- --party`. Off (production until go-live), every active track is as before.
export const PARTY_TRACK_PREFIX = "booth:";
export const partyTrackClause = (env, alias = "t") => (holidayOn(env) ? ` AND ${alias}.source_name LIKE '${PARTY_TRACK_PREFIX}%'` : "");

// Which rules a guest agreed to when they ticked "Enter the contest". A new text of the rules is a
// new version, so each tick records the words that were on the page.
export const RULES_VERSION = "holiday-2026-draft-4";
export const RULES_PATH = "/holiday-rules";

export const PARTY_NAME_MAX = 80;
export const PARTY_CITY_MAX = 80;
export const PARTY_INSTAGRAM_MAX = 60;
export const SESSION_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I or O: never read as 1 or 0
export const SESSION_CODE_TRIES = 25;
export const STATUSES = ["waiting", "booth", "out"];
// The four lanes a group moves through (Scooter's preview notes, 17 Nov 2026): waiting → booth
// (green) → upload ("just out / at the upload station", red: out of the booth, the engineer still
// saving their song) → done (their song was uploaded against them, or the team marked them done).
// Kept as status + done_at (migrations/0011_party_lanes.sql).
export const LANES = ["waiting", "booth", "upload", "done"];
export const laneOf = (s) => (s?.status === "out" ? (s.done_at ? "done" : "upload") : s?.status ?? null);
// A lane as the two columns: [status, done?].
export const LANE_COLUMNS = { waiting: ["waiting", false], booth: ["booth", false], upload: ["out", false], done: ["out", true] };
export const OUT_SHOWN = 30; // the most recent sessions that are out, on the team's line

export const isSessionCode = (s) => typeof s === "string" && new RegExp(`^[${SESSION_LETTERS}]{4}$`).test(s);
// What a person types → the code as kept: letters only, upper case, at most 4. "jx qp" → "JXQP".
export const sessionCodeFrom = (raw) => String(raw ?? "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
export const isGuestKey = (s) => typeof s === "string" && /^[0-9a-f]{24}$/.test(s);

// Four letters from the platform's random source, with no bias (rejection sampling).
export function randomSessionCode(random = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  let out = "";
  while (out.length < 4) {
    const [v] = random(1);
    if (v < 240) out += SESSION_LETTERS[v % SESSION_LETTERS.length];
  }
  return out;
}
export const guestKey = (random = (n) => crypto.getRandomValues(new Uint8Array(n))) => [...random(12)].map((b) => b.toString(16).padStart(2, "0")).join("");

// An Instagram handle as kept: optional, a leading @ added, letters, digits, dots and underscores.
export function cleanInstagram(raw) {
  const t = cleanText(raw, PARTY_INSTAGRAM_MAX).replace(/^@+/, "").replace(/^https?:\/\/(www\.)?instagram\.com\//i, "").replace(/\/.*$/, "");
  if (!t) return "";
  return /^[A-Za-z0-9._]{1,30}$/.test(t) ? `@${t}` : null;
}

// One person's slot of a sign-up → { ok: true, value } or { ok: false, field, error, message }.
const refuse = (field, error, message, extra = {}) => ({ ok: false, field, error, message, ...extra });
export function parseGuest(b) {
  b = b && typeof b === "object" ? b : {};
  const name = cleanText(b.name, PARTY_NAME_MAX);
  if (!name) return refuse("name", "name_required", "Enter a name.");
  const phone = cleanPhone(b.phone);
  if (!phone) return refuse("phone", "bad_phone", "Enter a phone number we can text.");
  const email = cleanEmail(b.email);
  if (!email) return refuse("email", "bad_email", "Enter an email address that works.");
  const city = cleanText(b.city, PARTY_CITY_MAX);
  if (!city) return refuse("city", "city_required", "Enter a city.");
  const instagram = cleanInstagram(b.instagram ?? "");
  if (instagram === null) return refuse("instagram", "bad_instagram", "That Instagram name does not look right. Leave it empty if you like.");
  return { ok: true, value: { name, phone, email, city, instagram } };
}
// The body of POST /api/party/join: ONE person (Scooter, 18 Nov 2026: "Each person signs up on
// their own ... No group setup on the guest side"). { name, phone, email, city, instagram?, website }.
// A list of several people (the old hand-the-phone-around form) is refused with what to do instead.
// → { ok: true, value: { guests: [one] } } or the problem.
export function parseSignUp(body) {
  const b = body && typeof body === "object" ? body : {};
  if (b.website !== undefined && b.website !== "") return refuse("website", "rejected", "That did not go through.");
  if (Array.isArray(b.guests) && b.guests.length !== 1) return refuse("guests", "one_person", "Each person signs up on their own phone, with their own details.");
  const one = parseGuest(Array.isArray(b.guests) ? b.guests[0] : b);
  if (!one.ok) return { ...one, slot: 0 };
  return { ok: true, value: { guests: [one.value] } };
}

// A sign-up the team should look at twice before tapping it into the booth (Scooter, 18 Nov 2026:
// "flag stale test signups at the upload pick ... so test data can't get picked in the first
// place"): "test" for a test name or address, "stale" for one made more than STALE_HOURS ago.
export const STALE_HOURS = 12;
const TEST_EMAIL = /(^test[^@]*@)|(@(example\.(com|org|net)|test\.[a-z]+|mailinator\.com)$)/i;
export function guestFlags(g, now = Date.now()) {
  const flags = [];
  if (/^test\b/i.test(String(g?.name ?? "").trim()) || TEST_EMAIL.test(String(g?.email ?? ""))) flags.push("test");
  if (Number.isFinite(g?.joined_at) && now - g.joined_at > STALE_HOURS * 3600 * 1000) flags.push("stale");
  return flags;
}

// The part of a guest anyone but the team sees.
export function firstOf(name) {
  const first = cleanText(name, PARTY_NAME_MAX).split(" ")[0] ?? "";
  return first.slice(0, 30) || "Guest";
}
// "Jay" · "Jay & Mo" · "Jay, Mo & Kim": a group's name, from first names in sign-up order.
export function groupLabel(firstNames) {
  const n = firstNames.filter(Boolean);
  if (n.length <= 1) return n[0] ?? "";
  return `${n.slice(0, -1).join(", ")} & ${n[n.length - 1]}`;
}

// The line, from session rows (each with `guests`, sign-up order, and status/done_at): the group in
// the booth first, then those waiting in the order they joined (their place: 1, 2, …), then those
// at the upload station (the oldest out first: the engineer's next file is theirs), then the most
// recent that are done. Each carries its `lane`. Sessions nobody is in any more are left out.
export function lineOrder(sessions) {
  const live = sessions.filter((s) => (s.guests ?? []).length > 0).map((s) => ({ ...s, lane: laneOf(s) }));
  const byJoin = (a, b) => a.created_at - b.created_at || a.id - b.id;
  const byOut = (a, b) => (a.status_at ?? 0) - (b.status_at ?? 0) || a.id - b.id;
  const booth = live.filter((s) => s.lane === "booth").sort(byJoin);
  const waiting = live.filter((s) => s.lane === "waiting").sort(byJoin).map((s, i) => ({ ...s, place: i + 1 }));
  const upload = live.filter((s) => s.lane === "upload").sort(byOut);
  const done = live.filter((s) => s.lane === "done").sort((a, b) => (b.done_at ?? 0) - (a.done_at ?? 0)).slice(0, OUT_SHOWN);
  return [...booth.map((s) => ({ ...s, place: 0 })), ...waiting, ...upload.map((s) => ({ ...s, place: null })), ...done.map((s) => ({ ...s, place: null }))];
}
// A guest's place: 0 in the booth, 1… waiting, null otherwise (or unknown).
export function placeOf(sessions, sessionId) {
  return lineOrder(sessions).find((s) => s.id === sessionId)?.place ?? null;
}

// A lane change the team asks for: to one of the four, from the one they saw (so two phones
// cannot undo each other's tap in silence).
export function parseStatusChange(body) {
  const b = body && typeof body === "object" ? body : {};
  if (!LANES.includes(b.status)) return refuse("status", "bad_status", "Status is waiting, booth, upload or done.");
  if (!LANES.includes(b.from)) return refuse("from", "bad_status", "Say which status you saw.");
  if (b.status === b.from) return refuse("status", "same_status", "That is already the status.");
  // Into the booth while the last recording waits on its upload: on that same song, or a new one.
  if (b.song !== undefined && b.song !== "same" && b.song !== "new") return refuse("song", "bad_song", "Say whether it is the same song or a new one.");
  return { ok: true, value: { status: b.status, from: b.from, song: b.song ?? null } };
}

// A GIF the team adds to the gallery: Giphy's id and an https URL on giphy.com, with its size.
export function parsePartyGif(body) {
  const b = body && typeof body === "object" ? body : {};
  const id = typeof b.id === "string" ? b.id : "";
  if (!/^[A-Za-z0-9]{1,64}$/.test(id)) return refuse("id", "bad_gif", "That GIF could not be added.");
  let url = null;
  try {
    const u = new URL(String(b.url ?? ""));
    if (u.protocol === "https:" && (u.hostname === "giphy.com" || u.hostname.endsWith(".giphy.com"))) url = u.toString();
  } catch {}
  if (!url) return refuse("url", "bad_gif", "That GIF could not be added.");
  const dim = (v) => (Number.isInteger(v) && v > 0 && v < 5000 ? v : null);
  return { ok: true, value: { id, url, width: dim(b.width), height: dim(b.height), title: cleanText(b.title ?? "", 120) } };
}

// ── SQL (party tables only; the booth's side of the contest is functions/_lib/contest.js) ─────
export const SESSION_BY_CODE_SQL = "SELECT id, code, status FROM party_sessions WHERE code = ?1";
export const NEW_SESSION_SQL = "INSERT OR IGNORE INTO party_sessions (code, created_at, status) VALUES (?1, ?2, 'waiting') RETURNING id, code, status";
// An email's one row, with the lane of the session it is in now (one active place per person).
export const GUEST_BY_EMAIL_SQL = "SELECT g.id, g.session_id, s.status, s.done_at FROM party_guests g JOIN party_sessions s ON s.id = g.session_id WHERE g.email = ?1";
export const GUEST_BY_KEY_SQL = "SELECT g.id, g.name, g.session_id, s.code, s.status, s.done_at FROM party_guests g JOIN party_sessions s ON s.id = g.session_id WHERE g.guest_key = ?1";
export const INSERT_GUEST_SQL = "INSERT INTO party_guests (session_id, name, phone, email, city, instagram, guest_key, joined_at, ip_hash) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) RETURNING id";
// Back in line: the same row, in the new session, with what they typed this time and a new key.
export const REJOIN_GUEST_SQL = "UPDATE party_guests SET session_id = ?2, name = ?3, phone = ?4, city = ?5, instagram = ?6, guest_key = ?7, joined_at = ?8, ip_hash = ?9 WHERE id = ?1";
export const VISIT_SQL = "INSERT INTO party_visits (guest_id, session_id, joined_at) VALUES (?1, ?2, ?3)";
// The whole line, small enough to read at once at a bar (sessions with their guests).
export const LINE_SESSIONS_SQL = "SELECT id, code, status, done_at, created_at, status_at, texted_at, take_id FROM party_sessions WHERE id IN (SELECT DISTINCT session_id FROM party_guests)";
export const LINE_GUESTS_SQL = "SELECT id, session_id, name, phone, email, city, instagram, joined_at FROM party_guests ORDER BY joined_at, id";
export const SESSION_NAMES_SQL = "SELECT name FROM party_guests WHERE session_id = ?1 ORDER BY joined_at, id";
// To a lane, from the lane the phone saw: ?2 status, ?3 done_at (or NULL), ?4 now, ?5 the status
// seen, ?6 1 when the lane seen had no done_at.
export const SET_STATUS_SQL = "UPDATE party_sessions SET status = ?2, done_at = ?3, status_at = ?4 WHERE id = ?1 AND status = ?5 AND ((done_at IS NULL) = ?6) RETURNING status, done_at, status_at";
export const STATUS_EVENT_SQL = "INSERT INTO party_status_events (session_id, from_status, to_status, member_id, at) VALUES (?1, ?2, ?3, ?4, ?5)";
export const TEXTED_SQL = "UPDATE party_sessions SET texted_at = ?2 WHERE id = ?1 RETURNING texted_at";
// ── Takes: who is on the song (Scooter, 18 Nov 2026: "The brand ambassador taps each person into
// the booth and out when the song is done. Those taps define who's on the song."; 19 Nov 2026: "When
// Carlos and Scooter go into the booth and leave one after the other, the upload should belong to
// both, not just the last person out.") ──────────────────────────────────────────────────────────
// A take is one song's recording. It stays OPEN while its song is not uploaded: people tapped in join
// it, and an empty booth does not end it, because a group often records one verse at a time. It ends
// (closed_at) when the engineer uploads its song, or when the ambassador taps the next person in as a
// NEW song; then nobody else joins it. So a song is everyone who was in the booth for it, and nobody
// from the song before or after.
// The open take, with how many of it are in the booth now and how many are out waiting on the
// upload: in_booth > 0 → the next person tapped in joins it; everyone out → the team says whether
// the next person is on the same song or a new one (409 which_song until they do).
export const OPEN_TAKE_SQL = `SELECT t.id,
  (SELECT COUNT(*) FROM party_sessions s WHERE s.take_id = t.id AND s.status = 'booth') AS in_booth,
  (SELECT COUNT(*) FROM party_sessions s WHERE s.take_id = t.id AND s.status = 'out' AND s.done_at IS NULL) AS out_waiting
  FROM party_takes t WHERE t.closed_at IS NULL AND t.track_id IS NULL ORDER BY t.opened_at DESC, t.id DESC LIMIT 1`;
// A new take, unless one is already open (two phones tapping at once start one recording, not two).
export const NEW_TAKE_SQL = "INSERT INTO party_takes (opened_at) SELECT ?1 WHERE NOT EXISTS (SELECT 1 FROM party_takes WHERE closed_at IS NULL AND track_id IS NULL)";
export const SET_TAKE_SQL = "UPDATE party_sessions SET take_id = ?2 WHERE id = ?1";
// The team's "New song": the open take takes nobody else in.
export const END_TAKE_SQL = "UPDATE party_takes SET closed_at = ?2 WHERE id = ?1 AND closed_at IS NULL";
// "Done, no song" for its last person: a take nobody is waiting on any more takes nobody else in.
export const CLOSE_TAKE_SQL = "UPDATE party_takes SET closed_at = ?2 WHERE id = ?1 AND closed_at IS NULL AND track_id IS NULL AND NOT EXISTS (SELECT 1 FROM party_sessions s WHERE s.take_id = ?1 AND s.done_at IS NULL AND s.status IN ('booth', 'out'))";
// Back in the booth from the upload station (an undo): the take is open again until its song is up,
// unless another recording has started since (then it simply waits until this person is out again).
export const REOPEN_TAKE_SQL = "UPDATE party_takes SET closed_at = NULL WHERE id = ?1 AND track_id IS NULL AND NOT EXISTS (SELECT 1 FROM party_takes o WHERE o.closed_at IS NULL AND o.track_id IS NULL AND o.id != ?1)";
export const TAKE_OF_SQL = "SELECT t.id, t.closed_at, t.track_id FROM party_takes t JOIN party_sessions s ON s.take_id = t.id WHERE s.id = ?1";
// The next take at the upload station: no song yet, nobody of it in the booth, someone of it out and
// waiting on the upload; the oldest recording first (the engineer's next file is theirs).
const AT_STATION = `t.track_id IS NULL
    AND EXISTS (SELECT 1 FROM party_sessions s WHERE s.take_id = t.id AND s.status = 'out' AND s.done_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM party_sessions s WHERE s.take_id = t.id AND s.status = 'booth')`;
export const NEXT_TAKE_SQL = `SELECT t.id, t.closed_at FROM party_takes t WHERE ${AT_STATION} ORDER BY t.opened_at, t.id LIMIT 1`;
export const STATION_TAKES_SQL = `SELECT COUNT(*) AS n FROM party_takes t WHERE ${AT_STATION}`;
// A take's people as the upload puts them on the song: everyone of it at the upload station, in the
// order they came out. Their one record (guest id), their email (the contact the code is read
// against) and their name.
export const TAKE_PEOPLE_SQL = `SELECT s.id AS session_id, g.id AS guest_id, g.email, g.name, g.joined_at FROM party_sessions s JOIN party_guests g ON g.session_id = s.id
  WHERE s.take_id = ?1 AND s.status = 'out' AND s.done_at IS NULL ORDER BY s.status_at, s.id`;
// What the upload checks it is still the take the engineer confirmed: its id and how many are on it.
export const takeKey = (id, size) => `${id}.${size}`;
// Who is still in the booth now (first names for the booth page, while no take is at the station).
export const IN_BOOTH_NOW_SQL = "SELECT g.name FROM party_sessions s JOIN party_guests g ON g.session_id = s.id WHERE s.status = 'booth' ORDER BY s.status_at, s.id";
// The song being recorded now, for the booth page: everyone on a take someone is still in the booth
// for, with whether they are in or already out.
export const RECORDING_NOW_SQL = `SELECT g.name, s.status FROM party_sessions s JOIN party_guests g ON g.session_id = s.id
  WHERE s.done_at IS NULL AND s.status IN ('booth', 'out') AND s.take_id IN (SELECT b.take_id FROM party_sessions b WHERE b.status = 'booth' AND b.take_id IS NOT NULL)
  ORDER BY s.status_at, s.id`;
// The upload claims the take: its song, and nobody else joins it.
export const CLAIM_TAKE_SQL = "UPDATE party_takes SET track_id = ?2, closed_at = COALESCE(closed_at, ?3) WHERE id = ?1 AND track_id IS NULL";

export const GIFS_SQL = "SELECT giphy_id, url, width, height, title FROM party_gifs WHERE removed_at IS NULL ORDER BY added_at, id";
export const ADD_GIF_SQL = "INSERT INTO party_gifs (giphy_id, url, width, height, title, added_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT (giphy_id) DO UPDATE SET removed_at = NULL, url = excluded.url";
export const REMOVE_GIF_SQL = "UPDATE party_gifs SET removed_at = ?2 WHERE giphy_id = ?1 AND removed_at IS NULL";

// The gallery's GIFs as /api/state carries them.
export const toGif = (r) => ({ id: r.giphy_id, url: r.url, width: r.width ?? null, height: r.height ?? null, title: r.title || "Holiday GIF" });
