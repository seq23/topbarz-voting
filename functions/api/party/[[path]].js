// The holiday party (Scooter, 17 Nov 2026): the QR sign-up, the booth sessions, the team's line.
// Every route answers 404 party_off while HOLIDAY_EVENT is not "on" (production, until go-live),
// except GET /api/party, which says whether it is on.
//
// Guests (open routes, kept safe by what they answer: first names and places, never a phone or an email):
//   GET  /api/party                  → { on }
//   POST /api/party/join             { guests: [{ name, phone, email, city, instagram? }, …], website } → 201 { guest_key, you, session }
//                                    one phone, handed around: each person fills their own slot, and they are one group (1 to 10);
//                                    a single person may send { name, phone, email, city, instagram?, website }. One active place
//                                    per email: 409 already_in_line (with the slot) while that email's group is waiting, in the
//                                    booth or at the upload station; once its song is uploaded (done) the same email signs up again.
//   POST /api/party/me               { guest_key } → { you, session }   the sign-up phone's page refreshes this
// The team (a team token from the emailed code; functions/_lib/team.js):
//   POST /api/party/team/code        { email } → { sent, email, resend_in_seconds }   only an email on the team list
//   POST /api/party/team/verify      { email, code } → { token, member: { email } }
//   GET  /api/party/team/line        → { now, sessions: [{ id, code, status, place, …, guests: [{ name, phone, email, city, instagram, joined_at }] }] }
//   POST /api/party/team/sessions/<id>/status  { status, from } → { session }   waiting | booth (green) | upload (red: just out, at
//                                    the upload station) | done; undo is the same call back. The engineer's upload moves upload → done.
//   POST /api/party/team/sessions/<id>/texted  → { texted_at }
//   GET  /api/party/team/members     → { members: [{ id, email, you }] };  POST { email } adds;  POST …/members/<id>/remove
//   GET  /api/party/team/gifs        → { gifs };  POST { id, url, width, height, title } adds;  POST …/gifs/<giphy id>/remove
//   GET  /api/party/team/songs       → { songs: [{ code, label, entered, pulled, pulled_at, people, ticked, members: [{ id, first_name, signed_up, in, attached_at }] }] }   every contest song, entered or not (never an email)
//   POST /api/party/team/songs/<booth code>/pull  { pulled: true|false } → { song }   "Take out of the vote" / "Put back": the team's
//                                    safety valve on auto-entry; a pulled song stays out even if everyone ticks again; likes are kept
//   POST /api/party/team/songs/<booth code>/people/<id>/remove → { song }   takes off the song someone who has not ticked
//                                    (409 ticked for someone who has); the song is judged again on the people left
import { cleanEmail, isCode } from "../../_lib/booth.js";
import { CONTEST_TRACK_SQL, DETACH_SQL, PERSON_ON_SONG_SQL, PULL_SQL, contestClosed, readSong, syncEntry, teamSongs } from "../../_lib/contest.js";
import { LIMITS, VERIFICATION, verificationStatus } from "../../_lib/config.js";
import { HttpError, fail, ipHash, json, readJson, route } from "../../_lib/http.js";
import {
  ADD_GIF_SQL, GIFS_SQL, GUEST_BY_EMAIL_SQL, GUEST_BY_KEY_SQL, INSERT_GUEST_SQL, LANE_COLUMNS, LINE_GUESTS_SQL, LINE_SESSIONS_SQL, NEW_SESSION_SQL, REJOIN_GUEST_SQL, REMOVE_GIF_SQL, SESSION_CODE_TRIES, SESSION_NAMES_SQL, SET_STATUS_SQL, STATUS_EVENT_SQL, TEXTED_SQL, VISIT_SQL,
  firstOf, guestKey, holidayOn, isGuestKey, laneOf, lineOrder, parsePartyGif, parseSignUp, parseStatusChange, randomSessionCode, toGif,
} from "../../_lib/party.js";
import { assertUnderLimit, limitStatement, maybePrune } from "../../_lib/ratelimit.js";
import { MEMBER_BY_EMAIL_SQL, STORE_TEAM_CODE_SQL, newCode, releaseTeamSlot, requireMember, signTeamToken, takeTeamSlot, teamCodeEmail, teamCodeHmac, teamCodeMatches } from "../../_lib/team.js";
import { sendMail } from "../../_lib/verify.js";

const segments = (params) => (Array.isArray(params?.path) ? params.path : [params?.path]).filter((s) => typeof s === "string" && s !== "");
const off = () => { throw new HttpError(404, "party_off", "Nothing on right now."); };
const limited = async (db, key, limit, what) => assertUnderLimit(await limitStatement(db, key, limit).all(), limit, what);

// ── Guests ─────────────────────────────────────────────────────────────────────────────────────
// A new session with a fresh 4-letter code (kept as the group's id on the team's line; nobody types
// it). The UNIQUE constraint settles a collision; retried.
async function newSession(db, now) {
  for (let i = 0; i < SESSION_CODE_TRIES; i++) {
    const row = await db.prepare(NEW_SESSION_SQL).bind(randomSessionCode(), now).first();
    if (row) return row;
  }
  throw new HttpError(503, "no_code_free", "Could not start a place in line right now. Try again in a moment.");
}
// What the sign-up phone sees of its group: first names and the place.
async function guestView(db, guest) {
  const [names, sessions, guests] = await db.batch([db.prepare(SESSION_NAMES_SQL).bind(guest.session_id), db.prepare(LINE_SESSIONS_SQL), db.prepare("SELECT session_id FROM party_guests")]);
  const bySession = new Map();
  for (const g of guests.results ?? []) bySession.set(g.session_id, [...(bySession.get(g.session_id) ?? []), g]);
  const line = lineOrder((sessions.results ?? []).map((s) => ({ ...s, guests: bySession.get(s.id) ?? [] })));
  const mine = line.find((s) => s.id === guest.session_id);
  return {
    you: { first_name: firstOf(guest.name) },
    session: { status: mine?.lane ?? laneOf(guest) ?? "waiting", place: mine?.place ?? null, names: (names.results ?? []).map((r) => firstOf(r.name)), size: (names.results ?? []).length },
  };
}

// The sign-up: one person, or a group on one phone. Every email is checked before anything is
// written, so a group is in line whole or not at all. An email already holding an active place is
// refused with what is happening (never a silent block); an email whose last group is done comes
// back in line: its one row moves to the new group, and the visit is kept in party_visits.
async function join(context) {
  const { request, env } = context;
  const parsed = parseSignUp(await readJson(request));
  if (!parsed.ok) throw new HttpError(400, parsed.error, parsed.message, { field: parsed.field, slot: parsed.slot ?? 0 });
  const { guests } = parsed.value;
  const db = env.DB;
  const now = Date.now();
  const ip = await ipHash(request, env);
  await limited(db, `party:join:ip:${ip}`, LIMITS.partyJoinsPerIp, "sign-ups");
  const found = await db.batch(guests.map((g) => db.prepare(GUEST_BY_EMAIL_SQL).bind(g.email)));
  const existing = found.map((r) => r.results?.[0] ?? null);
  const busy = existing.findIndex((row) => row && laneOf(row) !== "done");
  if (busy >= 0) {
    const lane = laneOf(existing[busy]);
    const where = lane === "booth" ? "in the booth right now" : lane === "upload" ? "just out of the booth, waiting for their song to be uploaded" : "already in line";
    throw new HttpError(409, "already_in_line", `${guests.length > 1 ? `Person ${busy + 1} (${guests[busy].name}): this email is` : "This email is"} ${where}. One place at a time: once that group's song is uploaded, the same email can get back in line. If that is wrong, ask the team at the booth.`, { field: "email", slot: busy, lane });
  }
  const session = await newSession(db, now);
  const keys = guests.map(() => guestKey());
  await db.batch(guests.map((g, i) => existing[i]
    ? db.prepare(REJOIN_GUEST_SQL).bind(existing[i].id, session.id, g.name, g.phone, g.city, g.instagram, keys[i], now + i, ip)
    : db.prepare(INSERT_GUEST_SQL).bind(session.id, g.name, g.phone, g.email, g.city, g.instagram, keys[i], now + i, ip)));
  const ids = await db.batch(guests.map((g) => db.prepare("SELECT id FROM party_guests WHERE email = ?1").bind(g.email)));
  await db.batch(ids.map((r, i) => db.prepare(VISIT_SQL).bind(r.results[0].id, session.id, now + i)));
  maybePrune(context);
  return json({ guest_key: keys[0], ...(await guestView(db, { name: guests[0].name, session_id: session.id, status: "waiting", done_at: null })) }, 201);
}
async function guestFrom(context, rawKey) {
  const { request, env } = context;
  await limited(env.DB, `party:read:ip:${await ipHash(request, env)}`, LIMITS.partyReadsPerIp, "requests");
  const guest = isGuestKey(rawKey) ? await env.DB.prepare(GUEST_BY_KEY_SQL).bind(rawKey).first() : null;
  if (!guest) throw new HttpError(404, "no_guest", "We could not find your sign-up on this phone. Sign up again.");
  return guest;
}
async function me(context) {
  const body = await readJson(context.request);
  return json(await guestView(context.env.DB, await guestFrom(context, body.guest_key)));
}

// ── The team's sign-in ───────────────────────────────────────────────────────────────────────
async function teamCode(context) {
  const { request, env } = context;
  const body = await readJson(request);
  const email = cleanEmail(body.email);
  if (!email) throw new HttpError(400, "bad_email", "Enter your email.", { field: "email" });
  const db = env.DB;
  const nowS = Math.floor(Date.now() / 1000);
  await limited(db, `team:code:ip:${await ipHash(request, env)}`, LIMITS.teamCodesPerIp, "codes");
  const member = await db.prepare(MEMBER_BY_EMAIL_SQL).bind(email).first();
  if (!member) throw new HttpError(403, "not_team", "That email is not on the team list. Ask a team member to add you.", { field: "email" });
  if (!verificationStatus(env).available) throw new HttpError(503, "code_unavailable", "We could not send your code right now. Try again in a little while.");
  const slot = await takeTeamSlot(env, member.id, nowS);
  if (slot.refused === "cooldown") return json({ sent: false, email, resend_in_seconds: slot.wait });
  if (slot.refused === "hourly") throw new HttpError(429, "code_limit", "That is 3 codes this hour. Use the last one, or try again later.", { retry_after_seconds: slot.wait });
  if (slot.refused) throw new HttpError(503, "code_unavailable", "We could not send your code right now. Try again in a little while.");
  const code = newCode();
  await db.prepare(STORE_TEAM_CODE_SQL).bind(member.id, await teamCodeHmac(env, member.id, code), nowS + VERIFICATION.codeTtl).run();
  const sent = await sendMail(env, email, teamCodeEmail(code));
  if (!sent.ok) {
    if (sent.sent === "no") await releaseTeamSlot(db, slot.slot);
    throw new HttpError(503, "code_unavailable", "We could not send your code right now. Try again in a little while.");
  }
  return json({ sent: true, email, resend_in_seconds: VERIFICATION.resendCooldown, expires_in_seconds: VERIFICATION.codeTtl });
}
async function teamVerify(context) {
  const { request, env } = context;
  const body = await readJson(request);
  const email = cleanEmail(body.email);
  const code = String(body.code ?? "").replace(/[\s-]/g, "");
  if (!email || !/^\d{6}$/.test(code)) throw new HttpError(400, "invalid_code", "Enter the 6 digits from the email.");
  const db = env.DB;
  const nowS = Math.floor(Date.now() / 1000);
  await limited(db, `team:verify:ip:${await ipHash(request, env)}`, LIMITS.teamVerifyPerIp, "tries");
  const member = await db.prepare(MEMBER_BY_EMAIL_SQL).bind(email).first();
  const stored = member ? await db.prepare("UPDATE team_codes SET attempts = attempts + 1 WHERE member_id = ?1 RETURNING code_hmac, expires_at, attempts").bind(member.id).first() : null;
  if (!stored || stored.expires_at <= nowS) throw new HttpError(410, "code_expired", "That code has run out. Send a new one.");
  if (stored.attempts > VERIFICATION.maxTries) throw new HttpError(410, "code_exhausted", "Too many wrong tries for that code. Send a new one.");
  if (!(await teamCodeMatches(env, member.id, code, stored.code_hmac))) throw new HttpError(400, "wrong_code", `That code is not right. ${VERIFICATION.maxTries - stored.attempts} tries left.`, { tries_left: VERIFICATION.maxTries - stored.attempts });
  await db.prepare("DELETE FROM team_codes WHERE member_id = ?1").bind(member.id).run();
  return json({ token: await signTeamToken(env, member.id, nowS), member: { email: member.email } });
}

// ── The team's line ──────────────────────────────────────────────────────────────────────────
async function member(context) {
  const m = await requireMember(context.request, context.env);
  await limited(context.env.DB, `team:member:${m.id}`, LIMITS.teamPerMember, "requests");
  return m;
}
async function line(context) {
  const db = context.env.DB;
  const [sessions, guests] = await db.batch([db.prepare(LINE_SESSIONS_SQL), db.prepare(LINE_GUESTS_SQL)]);
  const bySession = new Map();
  for (const g of guests.results ?? []) bySession.set(g.session_id, [...(bySession.get(g.session_id) ?? []), { id: g.id, name: g.name, first_name: firstOf(g.name), phone: g.phone, email: g.email, city: g.city, instagram: g.instagram, joined_at: new Date(g.joined_at).toISOString() }]);
  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
  return json({
    now: new Date().toISOString(),
    sessions: lineOrder((sessions.results ?? []).map((s) => ({ ...s, guests: bySession.get(s.id) ?? [] }))).map((s) => ({ id: s.id, code: s.code, status: s.lane, place: s.place, created_at: iso(s.created_at), status_at: iso(s.status_at), texted_at: iso(s.texted_at), guests: s.guests })),
  });
}
async function setStatus(context, id, m) {
  const parsed = parseStatusChange(await readJson(context.request));
  if (!parsed.ok) throw new HttpError(400, parsed.error, parsed.message);
  const db = context.env.DB;
  const now = Date.now();
  const [toStatus, toDone] = LANE_COLUMNS[parsed.value.status];
  const [fromStatus, fromDone] = LANE_COLUMNS[parsed.value.from];
  const row = await db.prepare(SET_STATUS_SQL).bind(id, toStatus, toDone ? now : null, now, fromStatus, fromDone ? 0 : 1).first();
  if (!row) {
    const current = await db.prepare("SELECT status, done_at FROM party_sessions WHERE id = ?1").bind(id).first();
    if (!current) throw new HttpError(404, "no_session", "That group is not in the line.");
    throw new HttpError(409, "changed", "Someone else changed this group a moment ago. The line has been refreshed.", { status: laneOf(current) });
  }
  await db.prepare(STATUS_EVENT_SQL).bind(id, parsed.value.from, parsed.value.status, m.id, now).run();
  return json({ session: { id, status: laneOf(row), status_at: new Date(row.status_at).toISOString() } });
}
async function texted(context, id) {
  const row = await context.env.DB.prepare(TEXTED_SQL).bind(id, Date.now()).first();
  if (!row) throw new HttpError(404, "no_session", "That group is not in the line.");
  return json({ texted_at: new Date(row.texted_at).toISOString() });
}
async function members(context, m) {
  const rows = (await context.env.DB.prepare("SELECT id, email, added_at FROM team_members WHERE removed_at IS NULL ORDER BY added_at, id").all()).results ?? [];
  return json({ members: rows.map((r) => ({ id: r.id, email: r.email, you: r.id === m.id })) });
}
async function addMember(context, m) {
  const email = cleanEmail((await readJson(context.request)).email);
  if (!email) throw new HttpError(400, "bad_email", "Enter an email address that works.");
  await context.env.DB.prepare("INSERT INTO team_members (email, added_at, added_by) VALUES (?1, ?2, ?3) ON CONFLICT (email) DO UPDATE SET removed_at = NULL").bind(email, Date.now(), m.id).run();
  return members(context, m);
}
async function removeMember(context, id, m) {
  if (id === m.id) throw new HttpError(409, "not_yourself", "You cannot take yourself off the team. Ask another team member.");
  await context.env.DB.prepare("UPDATE team_members SET removed_at = ?2 WHERE id = ?1 AND removed_at IS NULL").bind(id, Date.now()).run();
  return members(context, m);
}
const gifs = async (context) => json({ gifs: ((await context.env.DB.prepare(GIFS_SQL).all()).results ?? []).map(toGif) });
async function addGif(context) {
  const parsed = parsePartyGif(await readJson(context.request));
  if (!parsed.ok) throw new HttpError(400, parsed.error, parsed.message);
  const g = parsed.value;
  await context.env.DB.prepare(ADD_GIF_SQL).bind(g.id, g.url, g.width, g.height, g.title, Date.now()).run();
  return gifs(context);
}
async function removeGif(context, id) {
  await context.env.DB.prepare(REMOVE_GIF_SQL).bind(id, Date.now()).run();
  return gifs(context);
}

// ── The team's contest songs: take one out of the vote, or put it back ─────────────────────────
async function songs(context) {
  return json({ songs: await teamSongs(context.env.DB) });
}
const songOf = async (db, code, fallback) => (await teamSongs(db)).find((s) => s.code === code) ?? fallback;
async function pull(context, code, m) {
  const body = await readJson(context.request);
  if (typeof body.pulled !== "boolean") throw new HttpError(400, "bad_pull", "Send { pulled: true } or { pulled: false }.");
  const { env } = context;
  const now = Date.now();
  if (await contestClosed(env, now)) throw new HttpError(403, "voting_closed", "Voting has closed, so songs can no longer go in or come out.");
  const row = await env.DB.prepare(PULL_SQL).bind(code, body.pulled ? now : null, body.pulled ? m.id : null).first();
  if (!row) throw new HttpError(404, "no_song", "That song has not been in the vote.");
  await syncEntry(env, await readSong(env.DB, code), now);
  return json({ song: await songOf(env.DB, code, { code, pulled: body.pulled }) });
}
// "Remove from this song": someone on a song who has not ticked (a plus-one who only wanted to
// hear it, an engineer testing the code, a mistyped code) would hold it out of the vote for good.
// The team takes them off; the song is then judged again on the people left. A person who ticked
// is refused: their tick is their own consent, and only they untick it.
async function detach(context, code, personId) {
  const { env } = context;
  const now = Date.now();
  if (await contestClosed(env, now)) throw new HttpError(403, "voting_closed", "Voting has closed, so songs can no longer go in or come out.");
  const track = await env.DB.prepare(CONTEST_TRACK_SQL).bind(code).first();
  if (!track) throw new HttpError(404, "no_song", "No booth song has that code.");
  const row = await env.DB.prepare(DETACH_SQL).bind(track.id, personId).first();
  if (!row) {
    const there = await env.DB.prepare(PERSON_ON_SONG_SQL).bind(track.id, personId).first();
    if (there) throw new HttpError(409, "ticked", "This person ticked the box themselves, so only they can take their tick back. To keep the song out, use Take out of the vote.");
    throw new HttpError(404, "no_person", "That person is no longer on this song. The list has been refreshed.");
  }
  await syncEntry(env, await readSong(env.DB, code), now);
  return json({ song: await songOf(env.DB, code, { code }) });
}

const idOf = (s) => (/^[1-9][0-9]{0,9}$/.test(s ?? "") ? Number(s) : null);
export const onRequest = route({
  async GET(context) {
    const parts = segments(context.params);
    // GET /api/party (this catch-all also takes the bare path): whether the party is on here.
    if (parts.length === 0) return json({ on: holidayOn(context.env) }, 200, { "cache-control": "public, max-age=30" });
    if (!holidayOn(context.env)) off();
    if (parts[0] !== "team") return fail(404, "not_found", "No such API route.");
    const m = await member(context);
    if (parts.length === 2 && parts[1] === "line") return line(context);
    if (parts.length === 2 && parts[1] === "members") return members(context, m);
    if (parts.length === 2 && parts[1] === "gifs") return gifs(context);
    if (parts.length === 2 && parts[1] === "songs") return songs(context);
    return fail(404, "not_found", "No such API route.");
  },
  async POST(context) {
    const parts = segments(context.params);
    if (!holidayOn(context.env)) off();
    if (parts.length === 1 && parts[0] === "join") return join(context);
    if (parts.length === 1 && parts[0] === "me") return me(context);
    if (parts[0] !== "team") return fail(404, "not_found", "No such API route.");
    if (parts.length === 2 && parts[1] === "code") return teamCode(context);
    if (parts.length === 2 && parts[1] === "verify") return teamVerify(context);
    const m = await member(context);
    if (parts.length === 4 && parts[1] === "sessions" && idOf(parts[2]) && parts[3] === "status") return setStatus(context, idOf(parts[2]), m);
    if (parts.length === 4 && parts[1] === "sessions" && idOf(parts[2]) && parts[3] === "texted") return texted(context, idOf(parts[2]));
    if (parts.length === 2 && parts[1] === "members") return addMember(context, m);
    if (parts.length === 4 && parts[1] === "members" && idOf(parts[2]) && parts[3] === "remove") return removeMember(context, idOf(parts[2]), m);
    if (parts.length === 2 && parts[1] === "gifs") return addGif(context);
    if (parts.length === 4 && parts[1] === "songs" && isCode(parts[2]) && parts[3] === "pull") return pull(context, parts[2], m);
    if (parts.length === 6 && parts[1] === "songs" && isCode(parts[2]) && parts[3] === "people" && idOf(parts[4]) && parts[5] === "remove") return detach(context, parts[2], idOf(parts[4]));
    if (parts.length === 4 && parts[1] === "gifs" && /^[A-Za-z0-9]{1,64}$/.test(parts[2]) && parts[3] === "remove") return removeGif(context, parts[2]);
    return fail(404, "not_found", "No such API route.");
  },
});
